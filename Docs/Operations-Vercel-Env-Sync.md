# Operations: Vercel Environment Variables Sync

This runbook documents how we copy environment variables from the source Vercel project to the target project using `$Env:VERCEL_TOKEN`.

## Prerequisites
- Windows PowerShell
- Environment variable set:
  - `$Env:VERCEL_TOKEN = X7AxYAHyj1t5tdsgpHK3uwGn`
- Source project: `v0-v0-quickitquote`
- Target project: `qiq-mcp-server`
- Team (org) id: `qiq1`

## Script
Use `scripts/vercel-env-sync.ps1` to fetch envs from source and upsert into target.

Parameters used:
- Source: `https://vercel.com/qiq1/v0-v0-quickitquote/settings/environment-variables`
- Target: `https://vercel.com/qiq1/qiq-mcp-server/settings/environment-variables`

## What gets copied
- Key
- Value
- Type (e.g., `encrypted`, `plain`, `secret`)
- Target environments (e.g., `production`, `preview`, `development`)

## Notes
- The Vercel API only returns values if token has proper scope. If values are redacted, ensure the token has access to the source project.
- After syncing, verify envs on the Vercel dashboard.
- Documented values should be stored securely; do not commit raw secrets.

## Troubleshooting
- 401/403: Token lacks permissions; confirm team membership and token scope.
- 404: Check project names and teamId.
- Redacted values: Regenerate token with `read/write` env scope and project access.
