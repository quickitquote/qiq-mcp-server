import { createMcpServer } from './src/mcp.mjs';

// Delegate server creation and listening to the MCP module.
// Explicitly set host/port/path as requested.
const server = createMcpServer({
    name: 'QIQ_MCP',
    version: '1.0.0',
    host: '0.0.0.0',
    port: 9090,
    path: '/mcp',
});

export default server;
