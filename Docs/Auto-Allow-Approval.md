# Auto Allow and Auto Approval

This project enables permissive defaults for development and automation:

- CORS: Allowed for MCP endpoints to enable cross-origin Agent Builder access.
- Tools: `typesense_config_set` allows runtime configuration without manual approval once token-based auth passes.
- Vercel Env Sync: Automated via script using a team token; once run, all envs are copied without additional prompts.

Warning:
- For production hardening, restrict origins, enforce stricter token validation, and scope tool access.
- Do not expose admin Typesense keys client-side.
