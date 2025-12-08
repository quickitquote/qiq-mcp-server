import http from 'http';
import { WebSocketServer } from 'ws';
import { createMcpServer } from './src/mcp.mjs';

// HTTP server with health and 426 on non-upgraded MCP path
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'QIQ_MCP_GENERIC', version: '1.0.0', status: 'ok' }));
    } else {
        res.writeHead(426, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WebSocket-only endpoint. Upgrade with ws/wss.' }));
    }
});

// noServer mode; HTTP controls upgrade routing
const wss = new WebSocketServer({ noServer: true });

const { handleUpgrade } = createMcpServer({
    name: 'QIQ_MCP_GENERIC',
    version: '1.0.0',
    path: '/mcp',
});

server.on('upgrade', (req, socket, head) => {
    if (req.url === '/mcp') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            handleUpgrade(ws, req);
        });
    } else {
        socket.destroy();
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('MCP server running on port', PORT);
});
