import handler from '../api/mcp-http.js';

const payload = {
  jsonrpc: '2.0',
  id: 888,
  method: 'tools/call',
  params: {
    name: 'typesense_search',
    arguments: { objectIDs: ['KL4069IA1YRS'] },
  },
};

const headers = new Headers();
headers.set('content-type', 'application/json');
headers.set('authorization', 'Bearer test');

const req = new Request('https://example.com/mcp/http', {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
});

const res = await handler(req);
const text = await res.text();
console.log('STATUS', res.status);
console.log('HEADERS', Object.fromEntries(res.headers));
console.log('BODY', text);
try {
  const json = JSON.parse(text);
  console.log('PRODUCTS_COUNT', Array.isArray(json.products) ? json.products.length : 'not-array');
} catch (e) {
  console.error('JSON_PARSE_ERROR', e?.message || e);
}
