import http from 'http';
import { WebSocketServer } from 'ws';

// Module-scoped tool registry so both WS and HTTP/SSE can share state
const tools = new Map();

// Default example tool: ping (module-level)
tools.set('ping', {
    name: 'ping',
    description: 'Simple ping tool that returns {status:"ok"}'.replace(/\n/g, ' '),
    inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
    },
    outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
        additionalProperties: false,
    },
    call: async () => ({ status: 'ok' }),
});

// Module-scoped helpers to manage tools
export function getTools() {
    return Array.from(tools.values()).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
        outputSchema: t.outputSchema || { type: 'object' },
    }));
}
export function registerTool(name, def) {
    if (!name || typeof name !== 'string') throw new Error('Tool name must be a string');
    if (!def || typeof def.call !== 'function') throw new Error('Tool def must have call()');
    tools.set(name, { name, ...def });
    return getTools();
}

/**
 * Minimal MCP-compliant WebSocket server with JSON-RPC 2.0.
 * Dynamic, framework-free, and reusable.
 *
 * Exported API:
 * - createMcpServer(options)
 *   Returns { httpServer, wsServer, start(), stop(), registerTool(name, toolDef), getTools() }
 *
 * Options:
 * - name: string (server name)
 * - version: string (server version)
 * - host: string (bind host, default '0.0.0.0')
 * - port: number (bind port, default from process.env.PORT || 8080)
 * - path: string (WebSocket path, default '/mcp')
 * - logger: object ({ info, warn, error }) optional
 */
export function createMcpServer(options = {}) {
    const NAME = options.name || 'MCP_GENERIC';
    const VERSION = options.version || '0.1.0';
    const PATH = options.path || '/mcp';
    const HOST = options.host || '0.0.0.0';
    const PORT = Number(process.env.PORT || options.port || 8080);
    const logger = options.logger || {
        info: (...a) => console.log('[INFO ]', ...a),
        warn: (...a) => console.warn('[WARN ]', ...a),
        error: (...a) => console.error('[ERROR]', ...a),
    };

    const SUPPORTED_SUBPROTOCOLS = ['mcp', 'jsonrpc'];

    // Tools are module-scoped and already contain default ping

    // JSON-RPC helpers
    function makeResult(id, result) {
        return { jsonrpc: '2.0', id, result };
    }
    function makeError(id, code, message, data) {
        const err = { code, message };
        if (data !== undefined) err.data = data;
        return { jsonrpc: '2.0', id, error: err };
    }

    // Use noServer mode so the HTTP server can control upgrade routing (Cloud Run safe)
    const wsServer = new WebSocketServer({
        noServer: true,
        // Subprotocol negotiation: prefer 'mcp', then 'jsonrpc'; fallback to 'mcp' if none provided
        handleProtocols: (protocols) => {
            const requested = Array.from(protocols || []);
            if (requested.includes('mcp')) return 'mcp';
            if (requested.includes('jsonrpc')) return 'jsonrpc';
            // No subprotocols provided by some clients (e.g., Agent Builder) → default to 'mcp'
            return 'mcp';
        },
    });

    // Register / get tools API (module-scoped)

    // Per-connection handler (supports multiple clients)
    function onConnection(ws, request) {
        logger.info('WS connected', request?.socket?.remoteAddress);

        ws.on('message', async (data) => {
            let msgStr = data.toString();
            try {
                const msg = JSON.parse(msgStr);
                const { id, method, params } = msg;
                if (!method || typeof method !== 'string') {
                    const resp = makeError(id ?? null, -32600, 'Invalid Request: method missing');
                    ws.send(JSON.stringify(resp));
                    return;
                }

                switch (method) {
                    case 'initialize': {
                        const result = {
                            protocolVersion: '2024-11-05',
                            serverInfo: { name: NAME, version: VERSION },
                            capabilities: { tools: { listChanged: false } },
                        };
                        ws.send(JSON.stringify(makeResult(id, result)));
                        break;
                    }
                    case 'tools/list': {
                        ws.send(JSON.stringify(makeResult(id, { tools: getTools() })));
                        break;
                    }
                    case 'tools/call': {
                        const name = params?.name;
                        const args = params?.arguments;
                        if (!name || typeof name !== 'string') {
                            ws.send(JSON.stringify(makeError(id, -32602, 'Invalid params: name is required')));
                            break;
                        }
                        const tool = tools.get(name);
                        if (!tool) {
                            ws.send(JSON.stringify(makeError(id, -32601, `Method not found: tool ${name}`)));
                            break;
                        }
                        try {
                            const result = await tool.call(args || {});
                            ws.send(JSON.stringify(makeResult(id, result)));
                        } catch (e) {
                            logger.error('Tool error', e);
                            ws.send(JSON.stringify(makeError(id, -32000, 'Tool invocation error')));
                        }
                        break;
                    }
                    default: {
                        ws.send(JSON.stringify(makeError(id, -32601, `Method not found: ${method}`)));
                    }
                }
            } catch (e) {
                logger.error('Invalid JSON', e);
                ws.send(JSON.stringify(makeError(null, -32700, 'Parse error')));
            }
        });

        ws.on('close', () => {
            logger.info('WS closed');
        });
        ws.on('error', (e) => {
            logger.error('WS error', e);
        });
    }

    // Helper to perform subprotocol negotiation and attach handlers
    function handleUpgrade(ws, request) {
        // Note: In noServer mode, Sec-WebSocket-Protocol negotiation is done by the HTTP upgrade logic.
        // If you need to enforce protocols, inspect request.headers['sec-websocket-protocol'] here.
        onConnection(ws, request);
    }

    // HTTP server with health and 426 for non-WS access to PATH
    const httpServer = http.createServer((req, res) => {
        if (req.url === PATH) {
            res.statusCode = 426; // Upgrade Required
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'WebSocket-only endpoint. Upgrade with ws/wss.' }));
            return;
        }
        if (req.url === '/') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ name: NAME, version: VERSION, status: 'ok' }));
            return;
        }
        res.statusCode = 404;
        res.end('Not Found');
    });

    // HTTP → WebSocket upgrade routing
    httpServer.on('upgrade', (req, socket, head) => {
        if (req.url !== PATH) {
            socket.destroy();
            return;
        }
        // Debug: log requested subprotocols (if any)
        const requestedProto = req.headers['sec-websocket-protocol'];
        logger.info('HTTP upgrade → WS', { url: req.url, requestedProto });
        wsServer.handleUpgrade(req, socket, head, (ws) => handleUpgrade(ws, req));
    });

    // Start listening (Cloud Run: PORT provided via env)
    httpServer.listen(PORT, HOST, () => {
        logger.info(`MCP server listening on ws://${HOST}:${PORT}${PATH}`);
    });

    function stop() {
        return new Promise((resolve) => {
            try {
                wsServer.close(() => {
                    httpServer.close(() => resolve());
                });
            } catch (_) {
                resolve();
            }
        });
    }

    // Return hooks and servers for integration
    return { httpServer, wsServer, handleUpgrade, registerTool, getTools };
}

// Unified JSON-RPC dispatcher for HTTP/SSE transport
export function handleJsonRpc(input) {
    try {
        const { id, method, params } = input || {};
        const makeResult = (result) => ({ jsonrpc: '2.0', id, result });
        const makeErr = (code, message, data) => {
            const err = { code, message };
            if (data !== undefined) err.data = data;
            return { jsonrpc: '2.0', id: id ?? null, error: err };
        };
        switch (method) {
            case 'initialize':
                return makeResult({
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'MCP_GENERIC', version: '0.1.0' },
                    capabilities: { tools: { listChanged: false } },
                });
            case 'tools/list':
                return makeResult({
                    tools: Array.from(tools.values()).map(t => ({
                        name: t.name,
                        description: t.description || '',
                        inputSchema: t.inputSchema || { type: 'object' },
                        outputSchema: t.outputSchema || { type: 'object' },
                    }))
                });
            case 'tools/call': {
                const name = params?.name;
                const args = params?.arguments;
                const tool = name && tools.get(name);
                if (!tool) return makeErr(-32601, `Method not found: tool ${name}`);
                return Promise.resolve(tool.call(args || {}))
                    .then((result) => makeResult(result))
                    .catch(() => makeErr(-32000, 'Tool invocation error'));
            }
            default:
                return makeErr(-32601, `Method not found: ${method}`);
        }
    } catch (e) {
        const err = { code: -32700, message: 'Parse error' };
        return { jsonrpc: '2.0', id: null, error: err };
    }
}

// (getTools is exported above as a named export)
