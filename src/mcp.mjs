// Minimal MCP core for HTTP/SSE transports (no WebSocket)

// In-memory tool registry
const tools = new Map();

// Default ping tool
tools.set('ping', {
    name: 'ping',
    description: 'Returns pong',
    inputSchema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
    },
    call: async (args = {}) => ({ reply: args.status ? `pong:${args.status}` : 'pong' }),
});

export function getTools() {
    return Array.from(tools.values()).map(t => ({
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

export function handleJsonRpc(input) {
    try {
        const { id, method, params } = input || {};
        const ok = (result) => ({ jsonrpc: '2.0', id, result });
        const err = (code, message, data) => {
            const e = { code, message }; if (data !== undefined) e.data = data;
            return { jsonrpc: '2.0', id: id ?? null, error: e };
        };

        switch (method) {
            case 'initialize':
                return ok({
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'MCP_HTTP', version: '1.0.0' },
                    capabilities: { tools: { listChanged: false } },
                });
            case 'tools/list':
                return ok({ tools: getTools() });
            case 'tools/call': {
                const name = params?.name; const args = params?.arguments;
                const tool = name && tools.get(name);
                if (!tool) return err(-32601, `Method not found: tool ${name}`);
                return Promise.resolve(tool.call(args || {}))
                    .then((result) => ok(result))
                    .catch(() => err(-32000, 'Tool invocation error'));
            }
            default:
                return err(-32601, `Method not found: ${method}`);
        }
    } catch {
        return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
}
// End of minimal MCP core
