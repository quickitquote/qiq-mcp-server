import dotenv from 'dotenv';
import express from 'express';
import { handleJsonRpc } from '../src/mcp.mjs';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Basic CORS for MCP endpoints
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

const PORT = parseInt(process.env.HTTP_PORT || process.env.PORT || process.env.MCP_PORT || '3001', 10);
const HOST = process.env.MCP_HOST || '0.0.0.0';

function log(...args) {
    console.log('[HTTP]', ...args);
}

function sendJson(res, body, status = 200) {
    res.status(status).set('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(body));
}

app.post('/mcp/http', async (req, res) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const start = Date.now();

    try {
        const payload = req.body || {};
        const { jsonrpc, method } = payload;
        if (jsonrpc !== '2.0') {
            log(requestId, 'Invalid jsonrpc version:', jsonrpc);
        }

        // Delegate to MCP JSON-RPC handler for initialize, tools/list, tools/call
        const rpcResponse = await Promise.resolve(handleJsonRpc(payload));

        // For tools/call with typesense_search, return strict { products: [] } body
        if (rpcResponse && rpcResponse.result && rpcResponse.result.products) {
            return sendJson(res, rpcResponse.result);
        }
        // Otherwise return the JSON-RPC envelope
        return sendJson(res, rpcResponse);
    } catch (e) {
        log('error', e?.message || e);
        return sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Server error' } });
    } finally {
        const ms = Date.now() - start;
        log('done', requestId, ms + 'ms');
    }
});

// --- Simple SSE transport for MCP ---
// Maintains a set of connected SSE clients and pushes JSON-RPC responses to them.
const sseClients = new Set();

app.get('/mcp/sse', (req, res) => {
    // Establish SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Allow proxies to keep it alive
    res.flushHeaders?.();

    const client = res;
    sseClients.add(client);
    log('SSE connected. clients:', sseClients.size);

    // Send a ping to confirm stream is open
    res.write(`event: ping\n`);
    res.write(`data: {"ok":true}\n\n`);

    // Optionally emit tools/list immediately so clients see available tools without posting
    (async () => {
        try {
            const listResponse = await Promise.resolve(handleJsonRpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list' }));
            const data = JSON.stringify(listResponse);
            res.write(`event: message\n`);
            res.write(`data: ${data}\n\n`);
        } catch (e) {
            // ignore
        }
    })();

    req.on('close', () => {
        sseClients.delete(client);
        log('SSE disconnected. clients:', sseClients.size);
    });
});

app.post('/mcp/sse', async (req, res) => {
    // Accept JSON-RPC over POST, respond via SSE stream as well as HTTP response
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const start = Date.now();
    try {
        const payload = req.body || {};
        const rpcResponse = await Promise.resolve(handleJsonRpc(payload));

        // Push to all connected SSE clients
        const data = JSON.stringify(rpcResponse && rpcResponse.result && rpcResponse.result.products ? rpcResponse.result : rpcResponse);
        for (const client of sseClients) {
            try {
                client.write(`event: message\n`);
                client.write(`data: ${data}\n\n`);
            } catch (e) {
                // On error, drop client
                sseClients.delete(client);
            }
        }

        // Also return HTTP response: strict body for products, else envelope
        if (rpcResponse && rpcResponse.result && rpcResponse.result.products) {
            return sendJson(res, rpcResponse.result);
        }
        return sendJson(res, rpcResponse);
    } catch (e) {
        log('sse error', e?.message || e);
        return sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Server error' } });
    } finally {
        const ms = Date.now() - start;
        log('sse done', requestId, ms + 'ms');
    }
});

// Health
app.get('/', (_req, res) => sendJson(res, { name: 'QIQ_MCP_HTTP', status: 'ok' }));

app.listen(PORT, HOST, () => {
    log(`HTTP server listening on http://${HOST}:${PORT}/mcp/http`);
    log(`SSE endpoint ready at       http://${HOST}:${PORT}/mcp/sse`);
});
