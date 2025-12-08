import http from 'http';
import { createMcpServer } from './mcp.mjs';

const PORT = process.env.PORT || 8080;
const PATH = '/mcp';

// create MCP server
const { wsServer, handleUpgrade } = createMcpServer({
    name: "QIQ_MCP",
    version: "1.0.0",
    path: PATH,
});

// create HTTP server
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "ok", name: "QIQ_MCP" }));
        return;
    }

    // No direct HTTP access to /mcp
    if (req.url.startsWith(PATH)) {
        res.writeHead(426, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ error: "WebSocket-only endpoint. Upgrade with ws/wss." }));
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

// Upgrade → WebSocket handshake
server.on('upgrade', (req, socket, head) => {
    if (req.url !== PATH) {
        socket.destroy();
        return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
        handleUpgrade(ws, req);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`MCP server running on port ${PORT}`);
});
