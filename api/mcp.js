export const config = { runtime: 'edge' };

function makeResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    return { jsonrpc: '2.0', id, error: err };
}

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

function negotiateSubprotocol(req) {
    const protoHeader = req.headers.get('sec-websocket-protocol') || '';
    const requested = protoHeader.split(',').map((s) => s.trim()).filter(Boolean);
    if (requested.includes('mcp')) return 'mcp';
    if (requested.includes('jsonrpc')) return 'jsonrpc';
    return undefined; // none
}

export default async function handler(req) {
    // Only accept WebSocket upgrade
    if (req.headers.get('upgrade') !== 'websocket') {
        return new Response(JSON.stringify({ error: 'WebSocket-only endpoint. Use ws/wss upgrade.' }), {
            status: 426,
            headers: { 'content-type': 'application/json' },
        });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept and set subprotocol
    const selected = negotiateSubprotocol(req);
    server.accept();
    if (selected) {
        try { server.protocol = selected; } catch { }
    }

    // Logging helpers
    const logIn = (msg) => console.log('[<- IN ]', msg);
    const logOut = (msg) => console.log('[OUT ->]', msg);
    const logErr = (...args) => console.error('[ERROR]', ...args);

    server.addEventListener('message', async (event) => {
        const data = event.data;
        let msgStr = typeof data === 'string' ? data : String(data);
        try {
            const msg = JSON.parse(msgStr);
            logIn(msg);
            const { id, method, params } = msg;

            if (!method || typeof method !== 'string') {
                const resp = makeError(id ?? null, -32600, 'Invalid Request: method missing');
                logOut(resp);
                server.send(JSON.stringify(resp));
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
                    logOut(resp);
                    server.send(JSON.stringify(resp));
                    break;
                }
                case 'tools/list':
                case 'toolslist': {
                    const list = Object.values(tools).map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        outputSchema: t.outputSchema,
                    }));
                    const resp = makeResult(id, { tools: list });
                    logOut(resp);
                    server.send(JSON.stringify(resp));
                    break;
                }
                case 'tools/call':
                case 'toolscall': {
                    const name = params?.name;
                    const args = params?.arguments;
                    if (!name || typeof name !== 'string') {
                        const resp = makeError(id, -32602, 'Invalid params: name is required');
                        logOut(resp);
                        server.send(JSON.stringify(resp));
                        break;
                    }
                    const tool = tools[name];
                    if (!tool) {
                        const resp = makeError(id, -32601, `Method not found: tool ${name}`);
                        logOut(resp);
                        server.send(JSON.stringify(resp));
                        break;
                    }
                    try {
                        const result = await tool.call(args || {});
                        const resp = makeResult(id, result);
                        logOut(resp);
                        server.send(JSON.stringify(resp));
                    } catch (e) {
                        const resp = makeResult(id, { content: [], isError: true });
                        logErr('Tool error', e);
                        logOut(resp);
                        server.send(JSON.stringify(resp));
                    }
                    break;
                }
                default: {
                    const resp = makeError(id, -32601, `Method not found: ${method}`);
                    logOut(resp);
                    server.send(JSON.stringify(resp));
                }
            }
        } catch (e) {
            logErr('Invalid JSON', e);
            const resp = makeError(null, -32700, 'Parse error');
            logOut(resp);
            server.send(JSON.stringify(resp));
        }
    });

    server.addEventListener('close', () => { });
    server.addEventListener('error', (e) => logErr('WS error', e));

    // Return the upgraded socket response
    return new Response(null, { status: 101, webSocket: client });
}