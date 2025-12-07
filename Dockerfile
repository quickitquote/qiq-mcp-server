FROM node:20-alpine AS base

WORKDIR /app

# Install production deps
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm ci --only=production || npm install --production

# Copy source
COPY . .

# Expose port (Cloud Run uses $PORT, default 8080)
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8080

# Start server
CMD ["node", "scripts/mcp-server.js"]