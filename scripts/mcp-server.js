import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer } from 'ws';

dotenv.config();

// Cloud Run sets PORT env; prefer it, fallback to MCP_PORT then default 3001
const MCP_PORT = parseInt(process.env.PORT || process.env.MCP_PORT || '3001', 10);
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0';
const PATH = '/mcp';
const SUPPORTED_SUBPROTOCOLS = ['mcp', 'jsonrpc'];

// Simple logger for JSON-RPC traffic
const log = {
    in: (msg) => console.log('[<- IN ]', msg),
    out: (msg) => console.log('[OUT ->]', msg),
    info: (...args) => console.log('[INFO ]', ...args),
    warn: (...args) => console.warn('[WARN ]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
};

// Tool registry
const tools = {
    ping: {
        name: 'ping',
        description: 'Echo a message back',
        inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
        },
        outputSchema: {
            type: 'object',
            properties: {
                content: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { type: { type: 'string' }, text: { type: 'string' } },
                        required: ['type', 'text'],
                    },
                },
                isError: { type: 'boolean' },
            },
            required: ['content'],
        },
        call: async (args) => {
            const msg = typeof args?.message === 'string' ? args.message : '';
            return { content: [{ type: 'text', text: `pong: ${msg}` }], isError: false };
        },
    },
};

// JSON-RPC helpers
function makeResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    return { jsonrpc: '2.0', id, error: err };
}

// HTTP server (used only for upgrade and 426 on GET /mcp)
const server = http.createServer((req, res) => {
    if (req.url === PATH) {
        // For plain HTTP access, indicate upgrade required
        res.statusCode = 426; // Upgrade Required
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'WebSocket-only endpoint. Use ws/wss upgrade.' }));
        return;
    }
    // Basic health endpoint
    if (req.url === '/') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'QIQ_MCP', version: '1.0.0', status: 'ok' }));
        return;
    }
    res.statusCode = 404;
    res.end('Not Found');
});

// WebSocket server without auto-attach; we'll manually handle upgrade for subprotocol negotiation
const wss = new WebSocketServer({ noServer: true });

// Handle connection
wss.on('connection', (ws, request) => {
    log.info('WS connected from', request.socket.remoteAddress);

    ws.on('message', async (data) => {
        let msgStr = data.toString();
        try {
            const msg = JSON.parse(msgStr);
            log.in(msg);
            const { id, method, params } = msg;

            if (!method || typeof method !== 'string') {
                const resp = makeError(id ?? null, -32600, 'Invalid Request: method missing');
                log.out(resp);
                ws.send(JSON.stringify(resp));
                return;
            }

            switch (method) {
                case 'initialize': {
                    const result = {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'QIQ_MCP', version: '1.0.0' },
                        capabilities: { tools: { listChanged: false } },
                    };
                    const resp = makeResult(id, result);
                    log.out(resp);
                    ws.send(JSON.stringify(resp));
                    break;
                }
                case 'tools/list':
                case 'toolslist': { // tolerate variant from user request
                    const list = Object.values(tools).map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        outputSchema: t.outputSchema,
                    }));
                    const resp = makeResult(id, { tools: list });
                    log.out(resp);
                    ws.send(JSON.stringify(resp));
                    break;
                }
                case 'tools/call':
                case 'toolscall': { // tolerate variant from user request
                    const name = params?.name;
                    const args = params?.arguments;
                    if (!name || typeof name !== 'string') {
                        const resp = makeError(id, -32602, 'Invalid params: name is required');
                        log.out(resp);
                        ws.send(JSON.stringify(resp));
                        break;
                    }
                    const tool = tools[name];
                    if (!tool) {
                        const resp = makeError(id, -32601, `Method not found: tool ${name}`);
                        log.out(resp);
                        ws.send(JSON.stringify(resp));
                        break;
                    }
                    try {
                        const result = await tool.call(args || {});
                        const resp = makeResult(id, result);
                        log.out(resp);
                        ws.send(JSON.stringify(resp));
                    } catch (e) {
                        const resp = makeResult(id, { content: [], isError: true });
                        log.error('Tool error', e);
                        log.out(resp);
                        ws.send(JSON.stringify(resp));
                    }
                    break;
                }
                default: {
                    const resp = makeError(id, -32601, `Method not found: ${method}`);
                    log.out(resp);
                    ws.send(JSON.stringify(resp));
                }
            }
        } catch (e) {
            log.error('Invalid JSON', e);
            const resp = makeError(null, -32700, 'Parse error');
            log.out(resp);
            ws.send(JSON.stringify(resp));
        }
    });

    ws.on('close', () => {
        log.info('WS closed');
    });
});

// Upgrade handler to require path and negotiate subprotocols
server.on('upgrade', (request, socket, head) => {
    try {
        const { url, headers } = request;
        if (!url || !url.startsWith(PATH)) {
            socket.destroy();
            return;
        }

        // Client requested subprotocols (comma-separated)
        const requested = (headers['sec-websocket-protocol'] || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        // Prefer 'mcp', otherwise allow 'jsonrpc', otherwise none
        let selected = '';
        if (requested.includes('mcp')) selected = 'mcp';
        else if (requested.includes('jsonrpc')) selected = 'jsonrpc';

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
            // Set the selected protocol on the socket
            if (selected) {
                try {
                    ws._socket.protocol = selected; // internal
                } catch { }
            }
        });
    } catch (e) {
        log.error('upgrade error', e);
        socket.destroy();
    }
});

server.listen(MCP_PORT, MCP_HOST, () => {
    log.info(`QIQ MCP server listening on ws://${MCP_HOST}:${MCP_PORT}${PATH}`);
});