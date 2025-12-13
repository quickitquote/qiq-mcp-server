// Minimal MCP tool core usable from HTTP or WS handlers

// In-memory tool registry
const tools = new Map();

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
    if (!def || typeof def.call !== 'function') throw new Error('Tool def must include call()');
    tools.set(name, { name, ...def });
}

export function getTool(name) {
    return tools.get(name);
}

export async function callTool(name, args = {}) {
    const tool = getTool(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.call(args);
}

export function handleJsonRpc(input) {
    try {
        const { id, method, params } = input || {};
        const ok = (result) => ({ jsonrpc: '2.0', id, result });
        const err = (code, message, data) => {
            const e = { code, message }; if (data !== undefined) e.data = data;
            return { jsonrpc: '2.0', id: id ?? null, error: e };
        };

        if (!method || typeof method !== 'string') return err(-32600, 'Invalid Request: method missing');

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
                const tool = name && getTool(name);
                const { objectID, objectIDs, keywords, category } = params || {}
                // Accept both camelCase and lowercase keys from upstream nodes
                const objectID = (params?.objectID ?? params?.objectid ?? params?.ObjectID ?? params?.ObjectId) || undefined
                let objectIDs = (params?.objectIDs ?? params?.objectIds ?? params?.objectids ?? params?.ObjectIDs) || undefined

                // Normalize a single id into array for unified handling
                if (!objectIDs && objectID) {
                    objectIDs = [objectID]
                }
                if (!tool) return err(-32601, `Method not found: tool ${name}`);
                return Promise.resolve(tool.call(args || {}))
                    .then((result) => ok(result))
                    .catch((e) => err(-32000, 'Tool invocation error', String(e?.message || e)));
            }
            default:
                return err(-32601, `Method not found: ${method}`);
        }
    } catch (e) {
        return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
}

// Built-in tools
registerTool('ping', {
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

// Required tool: typesense_search (HTTP returns must be { products: [...] } with no wrappers)
registerTool('typesense_search', {
    description: 'Return products by objectIDs or keywords. If objectIDs are provided, returns those products in canonical QIQ shape.',
    inputSchema: {
        type: 'object',
        properties: {
            objectID: { type: 'string' },
            objectIDs: { type: 'array', items: { type: 'string' } },
            keywords: { type: 'string' },
            category: { type: 'string' },
        },
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: {
            products: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        objectID: { type: 'string' },
                        name: { type: 'string' },
                        brand: { type: 'string' },
                        item_type: { type: 'string' },
                        category: { type: 'string' },
                        price: { type: 'number' },
                        list_price: { type: 'number' },
                        availability: { type: 'number' },
                        image: { type: 'string' },
                        spec_sheet: { type: 'string' },
                        url: { type: 'string' },
                    },
                    required: ['objectID', 'name', 'brand', 'item_type', 'category', 'price', 'list_price', 'availability', 'image', 'spec_sheet', 'url'],
                    additionalProperties: false,
                },
            },
        },
        required: ['products'],
        additionalProperties: false,
    },
    call: async ({ objectID, objectIDs, keywords, category } = {}) => {
        // Lazy import to avoid bundling when unused in some environments
        const { default: Typesense } = await import('typesense');
        const dotenvModule = await import('dotenv');
        // Prefer .env.local if present, then fallback to .env
        try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const root = process.cwd();
            const candidates = [
                path.join(root, '.env.local'),
                path.join(root, '.env.server'),
                path.join(root, '.env.vercel'),
                path.join(root, '.env'),
            ];
            const found = candidates.find((p) => {
                try { return fs.existsSync(p); } catch { return false; }
            });
            if (found) {
                dotenvModule.default.config({ path: found });
            } else {
                dotenvModule.default.config();
            }
        } catch {
            dotenvModule.default.config();
        }

        const host = process.env.TYPESENSE_HOST;
        const protocol = (process.env.TYPESENSE_PROTOCOL || 'https').toLowerCase();
        const port = parseInt(process.env.TYPESENSE_PORT || (protocol === 'https' ? '443' : '80'), 10);
        const apiKey = [
            process.env.TYPESENSE_SEARCH_ONLY_KEY,
            process.env.TYPESENSE_API_KEY,
            process.env.TYPESENSE_ADMIN_API_KEY,
        ].find((v) => typeof v === 'string' && v.trim().length > 0);
        const collection = process.env.TYPESENSE_COLLECTION || 'quickitquote_products';
        const queryBy = (process.env.TYPESENSE_QUERY_BY || '').split(',').map((s) => s.trim()).filter(Boolean);

        const client = (host && apiKey)
            ? new Typesense.Client({ nodes: [{ host, port, protocol }], apiKey, connectionTimeoutSeconds: 10 })
            : null;

        function toAvailability(n) {
            const v = Number.isFinite(n) ? n : 0;
            return v; // keep numeric per schema; mapping semantics handled downstream
        }

        function mapRecord(rec) {
            // Read object_id from Typesense, emit objectID in output
            const oid = String(rec?.objectID || rec?.object_id || '');
            const name = String(rec?.name || '');
            const brand = String(rec?.brand || '');
            const item_type = String(rec?.item_type || '');
            const categoryVal = String(rec?.category || '');
            const priceNum = Number.isFinite(Number(rec?.price)) ? Number(rec?.price) : 0;
            const listPriceNum = Number.isFinite(Number(rec?.list_price)) ? Number(rec?.list_price) : 0;
            const availabilityNum = toAvailability(Number(rec?.availability));
            const imageUrl = String(rec?.image || '');
            const specUrl = String(rec?.spec_sheet || '');
            const url = `https://quickitquote.com/catalog/${encodeURIComponent(oid)}`;
            return {
                objectID: oid,
                name,
                brand,
                item_type,
                category: categoryVal,
                price: priceNum,
                list_price: listPriceNum,
                availability: availabilityNum,
                image: imageUrl,
                spec_sheet: specUrl,
                url,
            };
        }

        try {
            // Normalize identifiers: ensure strings and lowercase to avoid case mismatches
            const ids = Array.from(new Set([
                ...(Array.isArray(objectIDs) ? objectIDs : []),
                ...(objectID ? [objectID] : []),
            ]
                .filter(Boolean)
                .map((v) => String(v).trim())
                .map((v) => v.toLowerCase())));
            const ids = (objectIDs || []).map(id => String(id).toLowerCase())

            if (client && ids.length > 0) {
                // Retrieve by filter. Try objectID field first, then id
                const filterValue = ids.map((id) => `"${id.replace(/"/g, '\"')}"`).join(',');
                const filterByCandidates = [
                    `objectID:=[${filterValue}]`,
                    `object_id:=[${filterValue}]`,
                    `id:=[${filterValue}]`,
                    `mpn:=[${filterValue}]`,
                    `manufacturer_part_number:=[${filterValue}]`,
                ];
                let hits = [];
                for (const filterBy of filterByCandidates) {
                    try {
                        const res = await client.collections(collection).documents().search({
                            q: '*', // wildcard query; we match via filter_by to fetch exact docs
                            query_by: (queryBy.length > 0 ? queryBy.join(',') : 'name,brand,category'),
                            per_page: ids.length,
                            filter_by: filterBy,
                        });
                        hits = Array.isArray(res?.hits) ? res.hits : [];
                        if (hits.length > 0) break;
                    } catch (e) {
                        // try next candidate
                        continue;
                    }
                }
                // For any id not found in the initial batch, attempt a targeted fallback search
                async function fallbackLookup(oid) {
                    const fields = [
                        'objectID', 'object_id', 'id', 'mpn', 'manufacturer_part_number', 'vendor_mpn', 'sku', 'mpn_normalized'
                    ];
                    for (const f of fields) {
                        try {
                            const res = await client.collections(collection).documents().search({
                                q: '*',
                                query_by: (queryBy.length > 0 ? queryBy.join(',') : 'name,brand,category'),
                                per_page: 1,
                                filter_by: `${f}:=${JSON.stringify(oid)}`,
                            });
                            const doc = Array.isArray(res?.hits) && res.hits[0]?.document;
                            if (doc) return mapRecord(doc);
                        } catch { /* try next field */ }
                    }
                    return mapRecord({ objectID: oid });
                }

                const products = await Promise.all(ids.map(async (oid) => {
                    const hit = hits.find((h) => {
                        const d = h?.document || {};
                        return [
                            (d.objectID ? String(d.objectID).toLowerCase() : ''),
                            (d.object_id ? String(d.object_id).toLowerCase() : ''),
                            (d.id ? String(d.id).toLowerCase() : ''),
                            (d.mpn ? String(d.mpn).toLowerCase() : ''),
                            (d.manufacturer_part_number ? String(d.manufacturer_part_number).toLowerCase() : ''),
                            (d.vendor_mpn ? String(d.vendor_mpn).toLowerCase() : ''),
                            (d.sku ? String(d.sku).toLowerCase() : ''),
                            (d.mpn_normalized ? String(d.mpn_normalized).toLowerCase() : ''),
                        ].some((v) => v === String(oid));
                    });
                    if (hit && hit.document) return mapRecord(hit.document);
                    // Fallback targeted search
                    return fallbackLookup(oid);
                }));
                return { products };
            }

            if (client && typeof keywords === 'string' && keywords.trim().length > 0) {
                const res = await client.collections(collection).documents().search({
                    q: keywords.trim().length > 0 ? keywords.trim() : '*',
                    query_by: (queryBy.length > 0 ? queryBy.join(',') : 'name,brand,category'),
                    per_page: 20,
                });
                const products = (Array.isArray(res?.hits) ? res.hits : []).map((h) => mapRecord(h.document));
                return { products };
            }

            // No client or no inputs → empty JSON shape
            return { products: [] };
        } catch (e) {
            // Silent failure to maintain strict output shape
            return { products: [] };
        }
    },
});


