// LoadDeck server: REST API + static GUI. Binds to localhost only by default.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as runner from './runner.js';
import { buildScript, PROFILES } from './generator/builder.js';
import * as importers from './generator/importers.js';
import { htmlReport, csvReport } from './report.js';
import { generateScript, aiConfigured } from './generator/ai.js';
import { PROVIDERS, providerConfig, publicProviders, activeProviderId, listModels } from './generator/providers.js';

const PORT = parseInt(process.env.PORT || '7700', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(store.ROOT, 'public');
const MAX_BODY = 200 * 1024 * 1024; // HAR files can be big

const STATIC_MOUNTS = {
  '/vendor/chart.js': path.join(store.ROOT, 'node_modules/chart.js/dist/chart.umd.min.js'),
  '/vendor/codemirror/': path.join(store.ROOT, 'node_modules/codemirror/'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}
const ok = (res, body) => send(res, 200, body);
const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  for (const [prefix, target] of Object.entries(STATIC_MOUNTS)) {
    if (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix) {
      const file = prefix.endsWith('/') ? path.join(target, path.normalize(pathname.slice(prefix.length))) : target;
      if (!file.startsWith(target)) return fail(res, 403, 'forbidden');
      return serveFile(res, file);
    }
  }
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'forbidden');
  if (pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
  serveFile(res, file);
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// ---- info & settings ----
route('GET', '/api/info', async (req, res) => ok(res, {
  k6Version: await runner.k6Version(),
  settings: store.publicSettings(),
  ai: aiInfo(),
  profiles: PROFILES,
  active: runner.activeRuns(),
}));
route('GET', '/api/settings', (req, res) => ok(res, store.publicSettings()));
route('PUT', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  const patch = {};
  if (typeof b.k6Path === 'string' && b.k6Path.trim()) patch.k6Path = b.k6Path.trim();
  if (typeof b.keepRawData === 'boolean') patch.keepRawData = b.keepRawData;
  if (b.maxConcurrentRuns) patch.maxConcurrentRuns = Math.max(1, Math.min(20, parseInt(b.maxConcurrentRuns, 10) || 3));
  store.saveSettings(patch);
  ok(res, store.publicSettings());
});

// ---- scripts ----
route('GET', '/api/scripts', (req, res) => {
  const runs = store.listRuns();
  ok(res, store.listScripts().map((s) => {
    const mine = runs.filter((r) => r.scriptId === s.id);
    return { ...s, runCount: mine.length, lastRun: mine[0] || null };
  }));
});
route('POST', '/api/scripts', async (req, res) => {
  const b = await readBody(req);
  ok(res, store.saveScript({ name: b.name, description: b.description, code: b.code, source: b.source, generator: b.generator }));
});
route('GET', '/api/scripts/:id', (req, res, p) => {
  const s = store.getScript(p.id);
  return s ? ok(res, s) : fail(res, 404, 'script not found');
});
route('PUT', '/api/scripts/:id', async (req, res, p) => {
  const b = await readBody(req);
  if (!store.getScript(p.id)) return fail(res, 404, 'script not found');
  ok(res, store.saveScript({ id: p.id, name: b.name, description: b.description, code: b.code, generator: b.generator }));
});
route('DELETE', '/api/scripts/:id', (req, res, p) => { store.deleteScript(p.id); ok(res, { ok: true }); });
route('POST', '/api/scripts/:id/duplicate', (req, res, p) => {
  const s = store.getScript(p.id);
  if (!s) return fail(res, 404, 'script not found');
  ok(res, store.saveScript({ name: `${s.name} (copy)`, description: s.description, code: s.code, source: s.source, generator: s.generator }));
});
route('POST', '/api/validate', async (req, res) => {
  const b = await readBody(req);
  ok(res, await runner.validateScript(b.code || ''));
});

// ---- generator ----
route('POST', '/api/generate/import', async (req, res) => {
  const b = await readBody(req);
  const fn = { curl: importers.fromCurl, har: importers.fromHar, openapi: importers.fromOpenApi, postman: importers.fromPostman }[b.type];
  try {
    if (b.type === 'url') return ok(res, importers.fromUrl(b.text, b.options?.method));
    if (!fn) return fail(res, 400, 'unknown import type');
    ok(res, fn(b.text, b.options || {}));
  } catch (e) { fail(res, 422, e.message); }
});
route('POST', '/api/generate/build', async (req, res) => {
  const b = await readBody(req);
  try { ok(res, { code: buildScript(b.def || {}) }); } catch (e) { fail(res, 422, e.message); }
});

// ---- AI providers ----
function aiInfo() {
  const settings = store.getSettings();
  const providers = publicProviders(settings);
  const active = activeProviderId(settings);
  return { configured: aiConfigured(settings), active, activeLabel: PROVIDERS[active].label, activeModel: providers.find((p) => p.id === active)?.model || '', providers };
}
const knownProvider = (id) => { if (!PROVIDERS[id]) throw Object.assign(new Error('unknown provider'), { status: 404 }); return id; };
route('GET', '/api/ai/providers', (req, res) => ok(res, aiInfo()));
route('PUT', '/api/ai/providers/:id', async (req, res, p) => {
  const b = await readBody(req);
  store.updateAiProvider(knownProvider(p.id), b);
  ok(res, aiInfo());
});
route('PUT', '/api/ai/active', async (req, res) => {
  const b = await readBody(req);
  store.setActiveAiProvider(knownProvider(b.id));
  ok(res, aiInfo());
});
// Lists the provider's models; doubles as a connection test. Accepts an unsaved key/base URL to try first.
route('POST', '/api/ai/providers/:id/models', async (req, res, p) => {
  const b = await readBody(req);
  const c = providerConfig(store.getSettings(), knownProvider(p.id));
  if (b.apiKey) c.apiKey = String(b.apiKey).trim();
  if (b.baseUrl) c.baseUrl = String(b.baseUrl).trim().replace(/\/+$/, '');
  try { ok(res, { models: await listModels(c, AbortSignal.timeout(20000)) }); } catch (e) { fail(res, 422, e.message); }
});

// ---- AI generation — streamed as server-sent events ----
route('POST', '/api/ai/generate', async (req, res) => {
  const b = await readBody(req);
  if (!String(b.prompt || '').trim()) return fail(res, 400, 'Describe what the test should do.');
  const settings = store.getSettings();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  await generateScript({
    prompt: String(b.prompt).slice(0, 20000),
    baseUrl: b.baseUrl || '',
    reference: b.reference || '',
    currentCode: b.currentCode || '',
    loadHint: b.loadHint || '',
    provider: b.provider || '',
    model: b.model || '',
  }, { settings, validate: runner.validateScript, emit, signal: controller.signal });
  res.end();
});

// ---- runs ----
route('GET', '/api/runs', (req, res, p, url) => {
  let runs = store.listRuns();
  const sid = url.searchParams.get('scriptId');
  if (sid) runs = runs.filter((r) => r.scriptId === sid);
  ok(res, runs);
});
route('POST', '/api/runs', async (req, res) => {
  const b = await readBody(req);
  ok(res, runner.startRun(b));
});
route('GET', '/api/runs/:id', (req, res, p) => {
  const meta = store.getRunMeta(p.id);
  if (!meta) return fail(res, 404, 'run not found');
  ok(res, { meta, report: store.getRunReport(p.id) });
});
route('PATCH', '/api/runs/:id', async (req, res, p) => {
  const meta = store.getRunMeta(p.id);
  if (!meta) return fail(res, 404, 'run not found');
  const b = await readBody(req);
  if (typeof b.name === 'string') meta.name = b.name;
  if (typeof b.notes === 'string') meta.notes = b.notes;
  if (typeof b.baseline === 'boolean') meta.baseline = b.baseline;
  store.saveRunMeta(meta);
  ok(res, meta);
});
route('DELETE', '/api/runs/:id', (req, res, p) => {
  if (runner.activeRuns().some((r) => r.id === p.id && r.status === 'running')) return fail(res, 409, 'stop the run first');
  store.deleteRun(p.id);
  ok(res, { ok: true });
});
route('POST', '/api/runs/:id/stop', (req, res, p) => ok(res, { stopping: runner.stopRun(p.id) }));
route('GET', '/api/runs/:id/stream', (req, res, p) => runner.subscribe(store.safeId(p.id), res));
route('GET', '/api/runs/:id/log', (req, res, p) => send(res, 200, store.readRunFile(p.id, 'stdout.log') ?? '', 'text/plain; charset=utf-8'));
route('GET', '/api/runs/:id/script', (req, res, p) => send(res, 200, store.readRunFile(p.id, 'script.js') ?? '', 'text/plain; charset=utf-8'));
route('GET', '/api/runs/:id/export/:fmt', (req, res, p) => {
  const meta = store.getRunMeta(p.id);
  const report = store.getRunReport(p.id);
  if (!meta || !report) return fail(res, 404, 'report not available');
  const base = `loaddeck-${meta.id}`;
  const dl = (name) => ({ 'Content-Disposition': `attachment; filename="${name}"` });
  if (p.fmt === 'html') return send(res, 200, htmlReport(meta, report), 'text/html; charset=utf-8', dl(`${base}.html`));
  if (p.fmt === 'json') return send(res, 200, JSON.stringify({ meta, report }, null, 2), 'application/json', dl(`${base}.json`));
  if (p.fmt === 'csv') return send(res, 200, csvReport(meta, report), 'text/csv; charset=utf-8', dl(`${base}.csv`));
  if (p.fmt === 'summary') return send(res, 200, store.readRunFile(p.id, 'summary.json') ?? '{}', 'application/json', dl(`${base}-k6-summary.json`));
  fail(res, 400, 'unknown format');
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // Basic CSRF guard: browsers send Origin on cross-site requests.
      const origin = req.headers.origin;
      if (origin && req.method !== 'GET' && new URL(origin).host !== req.headers.host) return fail(res, 403, 'cross-origin request blocked');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res, params, url);
      }
      return fail(res, 404, 'no such endpoint');
    }
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.message);
    else res.end();
    if (!e.status) console.error(e);
  }
});

runner.recoverStaleRuns();

// First start: add the example script so there is something to run right away.
const seedMarker = path.join(store.DATA, '.seeded');
if (!fs.existsSync(seedMarker)) {
  if (!store.listScripts().length) {
    store.saveScript({
      name: 'Demo shop — user journey',
      description: 'Example against the bundled demo API (npm run demo-target)',
      code: fs.readFileSync(path.join(store.ROOT, 'examples/demo-shop.js'), 'utf8'),
      source: 'manual',
    });
  }
  fs.writeFileSync(seedMarker, new Date().toISOString());
}
server.listen(PORT, HOST, async () => {
  const v = await runner.k6Version();
  console.log(`\n  LoadDeck is running →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(v ? `  Using ${v}` : '  ⚠  k6 was not found. Install it (brew install k6) or set its path in Settings.');
  console.log(`  Data directory: ${store.DATA}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    runner.stopAll();
    setTimeout(() => process.exit(0), 300);
  });
}
