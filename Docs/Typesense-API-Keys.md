# Typesense API Keys and Access Control

This note summarizes the Typesense API Key model and our project's requirements, with troubleshooting steps.

## Key Types
- Bootstrap/Admin Key: Full access; used to create scoped keys; do not use in production apps.
- Search-only Key: Scoped to `documents:search` and specific collections (e.g., `quickitquote_products`).
- Other actions: `documents:get`, `documents:import`, `collections:*`, etc (see attached docs).

## Our Requirements
- Cluster: `b7p0h5alwcoxe6qgp-1.a1.typesense.net` (https, port 443)
- Collection: `quickitquote_products`
- Application key: Search-only, scoped to actions `["documents:search"]` and collections `["quickitquote_products"]` (or a regex for family).

## Creating Keys (Example)
```js
// Admin key creation (only during bootstrap, avoid wide scopes in production)
client.keys().create({
  description: 'Admin key',
  actions: ['*'],
  collections: ['*']
});

// Search-only key for quickitquote_products
client.keys().create({
  description: 'Search-only QIQ products key',
  actions: ['documents:search'],
  collections: ['quickitquote_products']
});
```

Notes:
- The generated key value is only returned at creation. Retrieve later only returns the prefix.
- Store keys securely in your secret manager.

## Using Keys
- Always send `X-TYPESENSE-API-KEY` header with the search-only key for client calls.
- Use our MCP tool `typesense_config_set` to apply: host, protocol, port, apiKey, collection, query settings.

## Troubleshooting 401 Forbidden
Symptoms:
- `typesense_health` returns `connected=false` and error `Request failed with HTTP code 401 | Forbidden - a valid x-typesense-api-key header must be sent.`
- Direct HTTP requests return 401.

Checklist:
- Confirm you are using a valid search-only key for the target cluster and collection.
- Verify no extra whitespace; we sanitize but double-check secret source formatting.
- Ensure the project is pointed to `https://b7p0h5alwcoxe6qgp-1.a1.typesense.net:443`.
- Confirm the collection name matches exactly: `quickitquote_products`.
- If using scoped search keys, ensure embedded filters are appropriate.

## Action Items
- Replace the current invalid key with the correct `TYPESENSE_SEARCH_ONLY_KEY`.
- Apply runtime config via `typesense_config_set` and re-run `typesense_health`.
- Once `connected=true`, run live tests and update documentation with actual results.
