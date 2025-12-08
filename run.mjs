import express from 'express';
import { getTools, handleJsonRpc } from './src/mcp.mjs';

const PORT = Number(process.env.PORT || 8080);

const app = express();
app.use(express.json({ type: 'application/json' }));

// GET /mcp → 426 Upgrade Required (per spec)
app.get('/mcp', (_req, res) => {
    res.status(426).json({ error: 'Upgrade Required' });
});

// SSE endpoint – send initial initialize message (Agent Builder expects this)
app.get('/mcp/sse', async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    const initialize = await handleJsonRpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    res.write('event: message\n');
    res.write(`data: ${JSON.stringify(initialize)}\n\n`);
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

app.listen(PORT, '0.0.0.0', () => console.log(`MCP Server running on PORT ${PORT}`));
