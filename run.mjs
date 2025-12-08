import express from 'express';
import { createMcpServer, getTools, handleJsonRpc } from './src/mcp.mjs';

// Keep existing WebSocket server untouched (created via mcp.mjs)
createMcpServer({ host: '0.0.0.0', port: Number(process.env.PORT || 8080), path: '/mcp' });

const app = express();
app.use(express.json({ type: 'application/json' }));

// GET /mcp → 426 Upgrade Required (per spec)
app.get('/mcp', (_req, res) => {
    res.status(426).json({ error: 'Upgrade Required' });
});

// SSE endpoint bridging JSON-RPC over HTTP
app.get('/mcp/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Initial connected event
    res.write('event: connected\n');
    res.write('data: {"status":"ok"}\n\n');

    // For demo purposes, if the client sends messages via query (?msg=...)
    // or a POST to /mcp/sse with JSON, we could bridge — here we keep it simple:
    // Clients are expected to POST JSON-RPC to /mcp/http and receive SSE responses.

    // Keep-alive ping every 25s
    const interval = setInterval(() => {
        res.write('event: ping\n');
        res.write('data: "keep-alive"\n\n');
    }, 25000);

    req.on('close', () => { clearInterval(interval); });
});

// Optional HTTP JSON-RPC endpoint to produce SSE-compatible responses
app.post('/mcp/http', async (req, res) => {
    const input = req.body;
    const out = await handleJsonRpc(input);
    res.status(200).json(out);
});

// Health
app.get('/', (_req, res) => {
    res.json({ name: 'MCP_HTTP_SSE+WS', tools: getTools() });
});

const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, '0.0.0.0');
export default server;
