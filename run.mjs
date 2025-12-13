import 'dotenv/config';
import express from 'express';
import { getTools, handleJsonRpc } from './src/mcp.mjs';

const PORT = Number(process.env.PORT || 8080);
const REQUIRED_TOKEN = process.env.MCP_TOKEN?.trim();

function authGuard(req, res, next) {
    if (!REQUIRED_TOKEN) return next(); // no auth configured
    const hdr = req.headers['authorization'] || '';
    const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : undefined;
    const token = bearer || req.query.token || req.headers['x-access-token'];
    if (token === REQUIRED_TOKEN) return next();
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
}

const app = express();
app.use(express.json({ type: 'application/json' }));
// Basic request log for debugging
app.use((req, _res, next) => {
    console.log(`[REQ] ${req.method} ${req.path}`);
    next();
});

// GET /mcp → 426 Upgrade Required (per spec)
app.get('/mcp', authGuard, (_req, res) => {
    res.status(426).json({ error: 'Upgrade Required' });
});

// SSE endpoint – send initial initialize message and keep the stream alive
app.get('/mcp/sse', authGuard, async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    const init = await handleJsonRpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    res.write('event: message\n');
    res.write(`data: ${JSON.stringify(init)}\n\n`);
    const interval = setInterval(() => {
        res.write('event: ping\n');
        res.write('data: "keep-alive"\n\n');
    }, 25000);
    req.on('close', () => clearInterval(interval));
});

// CORS preflight for /mcp/sse POST
app.options('/mcp/sse', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token');
    res.status(204).end();
});

// Some clients POST to /mcp/sse to send JSON-RPC requests
app.post('/mcp/sse', authGuard, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const out = await handleJsonRpc(req.body);
        res.status(200).json(out);
    } catch {
        res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
});

// Optional HTTP JSON-RPC endpoint to produce SSE-compatible responses
// CORS preflight for /mcp/http
app.options('/mcp/http', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token');
    res.status(204).end();
});

// GET handler for /mcp/http → 405 JSON (no HTML)
app.get('/mcp/http', authGuard, (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
});

// POST /mcp/http → JSON-RPC over HTTP with CORS
app.post('/mcp/http', authGuard, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const out = await handleJsonRpc(req.body);
        res.status(200).json(out);
    } catch {
        res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
});

// Health
app.get('/', (_req, res) => {
    res.json({ ok: true, tools: getTools() });
});

// Agent Builder compatibility: return tools list
app.get('/mcp/info', authGuard, (_req, res) => {
    res.json({ ok: true, tools: getTools() });
});

app.listen(PORT, '0.0.0.0', () => console.log(`MCP Server running on PORT ${PORT}`));
