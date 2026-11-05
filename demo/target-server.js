// A small demo API to practise against. Latency grows with concurrency so stress tests
// show realistic degradation. Run with: npm run demo-target  (http://localhost:3333)
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.DEMO_PORT || '3333', 10);
const products = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: +(5 + ((i * 7.3) % 95)).toFixed(2), stock: (i * 13) % 40 }));
const tokens = new Set();
let inFlight = 0;

const spec = {
  openapi: '3.0.3',
  info: { title: 'Demo Shop', version: '1.0.0' },
  servers: [{ url: `http://localhost:${PORT}` }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Login: { type: 'object', properties: { username: { type: 'string', example: 'demo' }, password: { type: 'string', example: 'demo' } } },
      CartItem: { type: 'object', properties: { productId: { type: 'integer', example: 3 }, qty: { type: 'integer', example: 1 } } },
    },
  },
  paths: {
    '/api/health': { get: { operationId: 'health', tags: ['System'], responses: { 200: { description: 'ok' } } } },
    '/api/login': { post: { operationId: 'login', tags: ['Auth'], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Login' } } } }, responses: { 200: { description: 'token' } } } },
    '/api/products': { get: { operationId: 'listProducts', tags: ['Catalog'], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', example: 1 } }], responses: { 200: { description: 'list' } } } },
    '/api/products/{id}': { get: { operationId: 'getProduct', tags: ['Catalog'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 7 } }], responses: { 200: { description: 'product' }, 404: { description: 'missing' } } } },
    '/api/cart': { post: { operationId: 'addToCart', tags: ['Cart'], security: [{ bearer: [] }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CartItem' } } } }, responses: { 201: { description: 'added' } } } },
    '/api/search': { get: { operationId: 'search', tags: ['Catalog'], parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', example: 'prod' } }], responses: { 200: { description: 'results' } } } },
  },
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve(null); } });
  });
}

http.createServer(async (req, res) => {
  inFlight++;
  res.on('finish', () => { inFlight--; });
  const url = new URL(req.url, 'http://x');
  // Base latency + a load-dependent component: more concurrent requests → slower.
  const delay = 8 + Math.random() * 25 + Math.max(0, inFlight - 40) * 1.5;
  await new Promise((r) => setTimeout(r, delay));
  const p = url.pathname;

  if (p === '/openapi.json') return json(res, 200, spec);
  if (p === '/api/health') return json(res, 200, { status: 'ok', inFlight });
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b?.username) return json(res, 400, { error: 'username required' });
    const token = crypto.randomBytes(12).toString('hex');
    tokens.add(token);
    if (tokens.size > 50000) tokens.clear();
    return json(res, 200, { token, user: b.username });
  }
  if (p === '/api/products') {
    const page = Math.max(1, +url.searchParams.get('page') || 1);
    return json(res, 200, { page, items: products.slice((page - 1) * 10, page * 10) });
  }
  const m = /^\/api\/products\/(\d+)$/.exec(p);
  if (m) {
    const prod = products.find((x) => x.id === +m[1]);
    return prod ? json(res, 200, prod) : json(res, 404, { error: 'not found' });
  }
  if (p === '/api/search') {
    // Deliberately slower endpoint.
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    const q = (url.searchParams.get('q') || '').toLowerCase();
    return json(res, 200, { results: products.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 10) });
  }
  if (p === '/api/cart' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    if (!tokens.has(auth.replace(/^Bearer\s+/i, ''))) return json(res, 401, { error: 'unauthorized' });
    if (Math.random() < 0.01) return json(res, 503, { error: 'cart service busy' }); // ~1% flaky
    const b = await readBody(req);
    return json(res, 201, { ok: true, item: b });
  }
  json(res, 404, { error: 'no route' });
}).listen(PORT, () => console.log(`Demo target API on http://localhost:${PORT}  (OpenAPI spec: /openapi.json)`));
