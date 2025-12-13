## Deployment via GitHub Actions (env sync)

You can deploy the environment file to the server and restart the service using the workflow `.github/workflows/deploy-env.yml`.

Required repo secrets:
- `SERVER_HOST`: e.g., `109.199.105.196`
- `SERVER_USER`: e.g., `root` or `ubuntu`
- Provide ONE of:
	- `SERVER_SSH_KEY`: private key for SSH (PEM format)
	- `SERVER_PASSWORD`: password for SSH (used via sshpass)
- `MCP_TOKEN`: Bearer token to verify HTTPS endpoints (optional but recommended)

Manual trigger:
- In GitHub → Actions → `Deploy MCP env and restart service` → `Run workflow`
- Optionally set `env_file` input (defaults to `.env.server`).

The workflow uploads the env file to `/opt/qiq-mcp-server/.env`, restarts `qiq-mcp-server`, and performs basic HTTPS checks.

### Cloudflare Zero Trust SSH proxy
If Cloudflare Zero Trust SSH proxy is enabled, the standard scp/ssh commands used by the workflow generally work as-is, provided your proxy is configured to accept connections from GitHub runners or you supply appropriate host/port settings and key credentials.
# QuickItQuote MCP HTTP/SSE Server

Minimal MCP server over HTTP + Server‑Sent Events (SSE) with token auth and CORS for OpenAI Agent Builder. Includes built‑in tools for Typesense search and QIQ scoring.

## Features
- HTTP JSON‑RPC at `POST /mcp/sse` and SSE stream at `GET /mcp/sse`
- Handshake via `initialize`
- `tools/list` and `tools/call` supported
- Built‑in tools:
	- `ping` – sanity check
	- `typesense_search` – search Typesense and normalize product results
	- `qiq_scoring` – simple, transparent ranking (price‑based baseline)
- Token auth via `Authorization: Bearer <MCP_TOKEN>`
 - Typesense integration with env-driven config and graceful fallbacks

## Local → Public (tunnel)
## Usage

### Module API
```js
import { createMcpServer } from './src/mcp.mjs';

const server = createMcpServer({
	name: 'MY_MCP',
	version: '1.0.0',
	// port is taken from process.env.PORT with fallback to 8080
});

// Add a dynamic tool at runtime
server.registerTool('echo', {
	description: 'Echo text back',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	call: async ({ text }) => ({ text }),
});

await server.start();
```

### Local run
```bash
npm install
npm run start
```

Server listens on `http://0.0.0.0:<PORT>` (default 8080).

Endpoints:
- `GET /mcp/sse` → SSE stream (sends `initialize` and keep‑alive pings)
- `GET /mcp/http` → SSE alias for tools that expect the stream on the same URL as POST
- `POST /mcp/sse` → JSON‑RPC requests (e.g., `tools/list`, `tools/call`)
- `GET /mcp/info` → health/tools (requires token if configured)

Auth: set `MCP_TOKEN` then pass it via `Authorization: Bearer <token>`.

Environment variables: see `.env.example`.

### Quick connect in OpenAI Agent Builder
Use these values in the "Connect to MCP Server" dialog (screenshot in prompt):

- **URL**: `https://<your-domain-or-ip>/mcp/sse` (or `https://<your-domain-or-ip>/mcp/http` if the client expects GET+POST on the same path).
- **Label**: any short name, e.g., `qiq_mcp_server`.
- **Description (optional)**: e.g., `QIQ MCP Server`.
- **Authentication → Access token / API key**: the value of `MCP_TOKEN` from your `.env`.

If you did not set `MCP_TOKEN`, leave Authentication blank. Keep the same URL for both listing tools and streaming.

### VPS setup steps
On your VPS (e.g., the `root@109.199.105.196` server you mentioned):

1. **Install dependencies** (Node 20+):
   ```bash
   apt update && apt install -y curl git
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   ```
2. **Fetch the code** (or pull latest):
   ```bash
   cd /opt
   git clone https://github.com/<your-org>/qiq-mcp-server.git
   cd qiq-mcp-server
   npm install --production
   ```
3. **Create `/opt/qiq-mcp-server/.env`** (copy from `.env.example`):
   ```bash
   cp .env.example .env
   # then edit .env to set MCP_TOKEN and any Typesense values
   ```
4. **Start the server** (foreground for testing):
   ```bash
   PORT=8080 node run.mjs
   ```
   For background service, run via a process manager (e.g., `pm2 start run.mjs --name qiq-mcp`).
5. **Open firewall/Cloudflare** so `https://<your-domain-or-ip>/mcp/sse` (and `/mcp/http`) are reachable.

After the server is running, use the Agent Builder form above with your public URL and `MCP_TOKEN` to connect.

### Test endpoints
- List tools
        - `POST /mcp/sse` with body `{ "jsonrpc":"2.0","id":1,"method":"tools/list","params":{} }`
- Call Typesense search
	- `POST /mcp/sse` with body
		`{ "jsonrpc":"2.0","id":2,"method":"tools/call","params":{ "name":"typesense_search", "arguments": { "category":"edr","keywords":"license", "quantity":100 } } }`
- Score results
	- `POST /mcp/sse` with body
		`{ "jsonrpc":"2.0","id":3,"method":"tools/call","params":{ "name":"qiq_scoring", "arguments": { "products":[...], "context":{ "solutionType":"EDR","seats":100,"termYears":1 } } } }`

## Deployment

This repository includes a Dockerfile that:
- Installs production dependencies
- Starts the runner `run.mjs`
- Uses `PORT` from environment (Cloud Run sets it automatically; fallback 8080)

### Build locally
```bash
docker build -t generic-mcp:latest .
docker run -e PORT=8080 -p 8080:8080 generic-mcp:latest
```

### Deploy to Cloud Run
```bash
gcloud run deploy generic-mcp \
	--image <REGION>-docker.pkg.dev/<PROJECT>/<REPO>/<IMAGE>:latest \
	--region <REGION> \
	--allow-unauthenticated \
	--port 8080
```

Notes:
- Cloud Run supports WebSockets over HTTP/1.1. Use `wss://<service-url>/mcp` in clients.
- Subprotocol negotiation: client should request `mcp`; server supports `mcp` and `jsonrpc`.

## Cloud Build + Artifact Registry (Quick Setup)

This repo includes a `cloudbuild.yaml` that builds the Docker image and pushes it to Artifact Registry under:

```
${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPOSITORY}/${_IMAGE}:{latest|$COMMIT_SHA}
```

Default substitutions:
- `_REGION`: `europe-west1`
- `_REPOSITORY`: `mcp-server`
- `_IMAGE`: `mcp-server`

The build config now ensures the Artifact Registry repository exists (creates it if missing) before pushing.

### Trigger configuration
- Set your Cloud Build trigger to use the config file: `cloudbuild.yaml`.
- Optionally override substitutions for region/repository/image.

### Manual submit (optional)
```bash
gcloud builds submit --config=cloudbuild.yaml \
	--substitutions=_REGION=europe-west1,_REPOSITORY=mcp-server,_IMAGE=mcp-server
```

### Permissions
- Ensure the Cloud Build service account has `roles/artifactregistry.writer` on your repository (or project) if push access fails.

### Deploy to Cloud Run
```bash
gcloud run deploy mcp-server \
	--image europe-west1-docker.pkg.dev/$PROJECT_ID/mcp-server/mcp-server:latest \
	--region europe-west1 \
	--allow-unauthenticated \
	--port 8080
```

For a permanent HTTPS domain, you can front the service with Cloudflare Tunnel and use the `https://<domain>/mcp/sse` URL in OpenAI Agent Builder.

## Typesense configuration

The server supports a Typesense-backed search tool `typesense_search`. Configure via environment variables:

- `TYPESENSE_HOST`: e.g., `xxxxx-1.a1.typesense.net`
- `TYPESENSE_PROTOCOL`: `https` or `http` (defaults imply port 443/80 if `TYPESENSE_PORT` is unset)
- `TYPESENSE_PORT`: typically `443` for `https`
- Keys (set ONE; first non-empty trimmed value is used):
	- `TYPESENSE_SEARCH_ONLY_KEY` (recommended in production for read-only search)
	- `TYPESENSE_API_KEY`
	- `TYPESENSE_ADMIN_API_KEY`
- `TYPESENSE_COLLECTION`: e.g., `quickitquote_products`
- `TYPESENSE_QUERY_BY`: optional, comma-separated list of string fields to search by (e.g., `name,description,brand,category`). If omitted, the server attempts to retrieve the collection schema to discover string fields; otherwise uses sensible defaults.

Diagnostics: call `typesense_health` via JSON-RPC to verify connectivity and see fields used. With search-only keys, schema retrieval may not be permitted; in that case the tool reports or uses the `query_by` fields provided via environment.