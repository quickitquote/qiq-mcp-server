// Minimal MCP core for HTTP/SSE transports (no WebSocket)
import Typesense from 'typesense';

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

// --- Built-in tools: Typesense search and QIQ scoring ---
// Environment-driven configuration so the server can run without hardcoding
const sanitize = (v) => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    // Remove wrapping single or double quotes, if present
    const unq = s.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    return unq.trim();
};

const TS_HOST = sanitize(process.env.TYPESENSE_HOST);
const TS_PROTOCOL = sanitize(process.env.TYPESENSE_PROTOCOL); // http|https
const TS_PORT = (() => {
    const raw = sanitize(process.env.TYPESENSE_PORT);
    if (raw && raw !== '') {
        const n = Number(raw);
        if (!Number.isNaN(n)) return n;
    }
    if (TS_PROTOCOL === 'https') return 443;
    if (TS_PROTOCOL === 'http') return 80;
    return undefined;
})();
// Prefer search-only key, then general API key, then admin key; pick the first non-empty trimmed value
const TS_API_KEY = [process.env.TYPESENSE_SEARCH_ONLY_KEY, process.env.TYPESENSE_API_KEY, process.env.TYPESENSE_ADMIN_API_KEY]
    .find((v) => typeof v === 'string' && sanitize(v)?.length > 0);
const TS_API_KEY_TRIMMED = sanitize(TS_API_KEY);
const TS_COLLECTION = sanitize(process.env.TYPESENSE_COLLECTION);

let tsClient = null;
try {
    if (TS_HOST && TS_PROTOCOL && TS_API_KEY_TRIMMED && typeof TS_PORT === 'number' && !Number.isNaN(TS_PORT)) {
        tsClient = new Typesense.Client({
            nodes: [{ host: TS_HOST, port: TS_PORT, protocol: TS_PROTOCOL }],
            apiKey: TS_API_KEY_TRIMMED,
            connectionTimeoutSeconds: 5,
        });
    }
} catch {
    tsClient = null;
}

const productSchema = {
    type: 'object',
    properties: {
        sku: { type: 'string' },
        name: { type: 'string' },
        brand: { type: 'string' },
        price: { type: 'number' },
        quantity: { type: 'number' },
        score: { type: 'number' }
    },
    required: ['sku', 'name', 'brand', 'price', 'quantity'],
    additionalProperties: true,
};

let cachedQueryBy = null;

registerTool('typesense_search', {
    description: 'Search products from Typesense and return normalized product list.',
    inputSchema: {
        type: 'object',
        properties: {
            category: { type: 'string' },
            keywords: { type: 'string' },
            quantity: { type: ['number', 'null'] },
            duration_years: { type: ['number', 'null'] },
        },
        required: ['category', 'keywords'],
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: { products: { type: 'array', items: productSchema } },
        required: ['products'],
        additionalProperties: false,
    },
    call: async ({ category, keywords, quantity = null }) => {
        // If Typesense is not configured, return deterministic mock data
        const qty = typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
        if (!tsClient || !TS_COLLECTION) {
            return {
                products: [
                    { sku: 'MOCK-001', name: `${category} basic - ${keywords}`, brand: 'Generic', price: 10, quantity: qty },
                    { sku: 'MOCK-002', name: `${category} standard - ${keywords}`, brand: 'Generic', price: 20, quantity: qty },
                    { sku: 'MOCK-003', name: `${category} pro - ${keywords}`, brand: 'Generic', price: 30, quantity: qty },
                ],
            };
        }

        try {
            // Determine query_by fields once
            if (!cachedQueryBy) {
                const envQueryBy = sanitize(process.env.TYPESENSE_QUERY_BY);
                if (envQueryBy) {
                    // Honor explicit override and skip schema discovery
                    cachedQueryBy = envQueryBy;
                } else {
                    // Try to discover string fields from schema, then fallback to sensible defaults
                    try {
                        const schema = await tsClient.collections(TS_COLLECTION).retrieve();
                        const strFields = (schema?.fields || [])
                            .filter((f) => typeof f?.name === 'string' && String(f.type || '').startsWith('string'))
                            .map((f) => f.name);
                        cachedQueryBy = (strFields.length ? strFields : ['name', 'description', 'brand', 'category']).join(',');
                    } catch {
                        cachedQueryBy = ['name', 'description', 'brand', 'category'].join(',');
                    }
                }
            }

            let result;
            const baseParams = {
                q: keywords && String(keywords).trim() ? String(keywords) : '*',
                per_page: 25,
            };

            // Attempt search with discovered query_by, then progressively degrade
            const attempt = async (queryBy) => {
                const params = { ...baseParams, query_by: queryBy };
                if (category) params.filter_by = `category:=${JSON.stringify(category)}`;
                return tsClient.collections(TS_COLLECTION).documents().search(params);
            };

            try {
                result = await attempt(cachedQueryBy);
            } catch {
                // Fallbacks: try a common single field, then a conservative default set
                try {
                    result = await attempt('name');
                } catch {
                    result = await attempt('name,description,brand,category');
                }
            }

            const products = (result.hits || []).map((hit, idx) => {
                const doc = hit.document || {};
                const sku = doc.sku || doc.id || `TS-${idx + 1}`;
                const name = doc.name || doc.title || `${category} item`;
                const brand = doc.brand || doc.vendor || 'Unknown';
                const price = typeof doc.price === 'number' ? doc.price : Number(doc.price) || 0;
                return { sku, name, brand, price, quantity: qty };
            });
            return { products };
        } catch {
            // Fall back to mock data on failure
            return {
                products: [
                    { sku: 'FALLBACK-001', name: `${category} fallback - ${keywords}`, brand: 'Generic', price: 15, quantity: qty },
                ],
            };
        }
    },
});

registerTool('qiq_scoring', {
    description: 'Score and rank products for QIQ procurement logic.',
    inputSchema: {
        type: 'object',
        properties: {
            products: { type: 'array', items: productSchema },
            context: {
                type: 'object',
                properties: {
                    solutionType: { type: 'string' },
                    seats: { type: 'number' },
                    termYears: { type: 'number' },
                },
                additionalProperties: true,
            },
        },
        required: ['products'],
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: { products: { type: 'array', items: productSchema } },
        required: ['products'],
        additionalProperties: false,
    },
    call: async ({ products = [], context = {} } = {}) => {
        const scored = (Array.isArray(products) ? products : []).map((p) => {
            const price = typeof p.price === 'number' ? p.price : Number(p.price) || 0;
            // Simple, transparent baseline: lower price → higher score
            const score = price > 0 ? 1 / price : 0;
            return { ...p, price, score };
        });
        scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return { products: scored };
    },
});

// Health/diagnostics tool for Typesense connectivity
registerTool('typesense_health', {
    description: 'Report Typesense connectivity and collection schema fields.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
        type: 'object',
        properties: {
            connected: { type: 'boolean' },
            host: { type: 'string' },
            protocol: { type: 'string' },
            port: { type: 'number' },
            collection: { type: 'string' },
            fields: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' }
        },
        required: ['connected', 'host', 'protocol', 'port', 'collection'],
        additionalProperties: false,
    },
    call: async () => {
        const base = {
            connected: false,
            host: TS_HOST || '',
            protocol: TS_PROTOCOL || '',
            port: typeof TS_PORT === 'number' ? TS_PORT : 0,
            collection: TS_COLLECTION || '',
            fields: [],
        };
        try {
            if (!tsClient) return { ...base, error: 'Client not initialized' };

            // Attempt a lightweight search which should succeed with search-only key
            let connected = false;
            let fields = [];
            try {
                const qb = cachedQueryBy || sanitize(process.env.TYPESENSE_QUERY_BY) || 'name';
                await tsClient.collections(TS_COLLECTION).documents().search({ q: '*', query_by: qb, per_page: 1 });
                connected = true;
                // If we don't have schema access, at least report the query_by we used
                fields = qb.split(',').map(s => s.trim()).filter(Boolean);
            } catch (searchErr) {
                // Try health and schema (may require non-search-only keys)
                try {
                    await tsClient.health.retrieve();
                    const schema = await tsClient.collections(TS_COLLECTION).retrieve();
                    fields = (schema?.fields || []).map((f) => f?.name).filter(Boolean);
                    connected = true;
                } catch (schemaErr) {
                    const msg = (searchErr && searchErr.message) ? searchErr.message : (schemaErr && schemaErr.message) ? schemaErr.message : undefined;
                    return { ...base, connected, fields, error: msg };
                }
            }
            return { ...base, connected, fields };
        } catch (e) {
            return { ...base, error: (e && e.message) ? e.message : 'Unknown error' };
        }
    },
});

