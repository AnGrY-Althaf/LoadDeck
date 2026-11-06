import { browserConfig, browserScenario, browserJourney } from './browser.js';
// Turns a test definition (requests + load profile + SLAs) into a readable k6 script.
// Every importer (cURL, HAR, OpenAPI, Postman) produces this same definition, so the
// user can review/edit requests in the UI before generating.

export const PROFILES = {
  smoke: { label: 'Smoke', hint: 'Few VUs for a short time — verifies the script and system work at all.', defaults: { vus: 1, duration: '1m' } },
  load: { label: 'Average load', hint: 'Ramp up to normal traffic, hold it, ramp down.', defaults: { vus: 20, rampUp: '1m', duration: '5m', rampDown: '30s' } },
  stress: { label: 'Stress', hint: 'Climbs to peak VUs in 4 steps to see how the system degrades.', defaults: { vus: 100, rampUp: '1m', duration: '3m', rampDown: '1m' } },
  spike: { label: 'Spike', hint: 'Sudden surge from low traffic to peak and back.', defaults: { vus: 200, duration: '1m' } },
  soak: { label: 'Soak / endurance', hint: 'Normal load for a long time — finds leaks and slow degradation.', defaults: { vus: 20, rampUp: '2m', duration: '2h', rampDown: '2m' } },
  breakpoint: { label: 'Breakpoint', hint: 'Keeps increasing iteration rate until thresholds fail (test auto-aborts).', defaults: { rate: 500, duration: '10m', maxVus: 1000 } },
  'constant-rate': { label: 'Constant arrival rate', hint: 'Fixed iterations per second regardless of response times (open model).', defaults: { rate: 50, duration: '5m', vus: 20, maxVus: 200 } },
  iterations: { label: 'Fixed iterations', hint: 'Run the flow an exact number of times, shared across VUs.', defaults: { vus: 5, iterations: 100 } },
  custom: { label: 'Custom stages', hint: 'Define your own ramping stages.', defaults: { stages: [{ duration: '30s', target: 10 }, { duration: '1m', target: 10 }, { duration: '30s', target: 0 }] } },
};

const PH = /\{\{\s*([$\w.-]+)\s*\}\}/g;
const BASE_NAMES = new Set(['baseurl', 'base_url', 'base-url', 'host', 'url', 'baseUrl'.toLowerCase()]);
const DYNAMIC = {
  $guid: 'uuid()', $uuid: 'uuid()', $randomUUID: 'uuid()',
  $timestamp: 'Math.floor(Date.now() / 1000)', $isoTimestamp: 'new Date().toISOString()',
  $randomInt: 'Math.floor(Math.random() * 1000)', $vu: '__VU', $iter: '__ITER',
};

function ident(name) { return /^[A-Za-z_$][\w$]*$/.test(name) ? `vars.${name}` : `vars[${q(name)}]`; }

export function q(s) {
  return "'" + String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'";
}

class Ctx { constructor() { this.usesUuid = false; this.usedVars = new Set(); this.payloads = 0; } }

// String literal; {{var}} placeholders become template expressions.
function str(s, ctx) {
  s = String(s ?? '');
  if (!s.match(PH)) return q(s);
  let out = '`';
  let last = 0;
  for (const m of s.matchAll(PH)) {
    out += escTpl(s.slice(last, m.index));
    out += '${' + expr(m[1], ctx) + '}';
    last = m.index + m[0].length;
  }
  out += escTpl(s.slice(last)) + '`';
  return out;
}
function escTpl(s) { return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'); }
function expr(name, ctx) {
  if (DYNAMIC[name]) { if (DYNAMIC[name] === 'uuid()') ctx.usesUuid = true; return DYNAMIC[name]; }
  if (BASE_NAMES.has(name.toLowerCase())) return 'BASE_URL';
  ctx.usedVars.add(name);
  return ident(name);
}

// Pretty JS literal from a parsed JSON value (strings may contain {{placeholders}}).
function lit(v, ctx, indent) {
  const pad = '  '.repeat(indent);
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map((x) => lit(x, ctx, 0)).join(', ')}]`;
    return `[\n${v.map((x) => `${pad}  ${lit(x, ctx, indent + 1)}`).join(',\n')},\n${pad}]`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${lit(v[k], ctx, indent + 1)}`).join(',\n')},\n${pad}}`;
  }
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([$\w.-]+)\s*\}\}$/.exec(v);
    if (whole && !DYNAMIC[whole[1]]) return expr(whole[1], ctx);
    return str(v, ctx);
  }
  return String(v);
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const t = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const filtered = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (filtered.length < 2) return [];
  const head = filtered[0].map((h) => h.trim());
  return filtered.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function originOf(u) { try { return new URL(u).origin; } catch { return null; } }

function urlExpr(raw, base, ctx) {
  let u = String(raw || '').trim();
  const baseM = /^\{\{\s*([$\w.-]+)\s*\}\}/.exec(u);
  if (baseM && BASE_NAMES.has(baseM[1].toLowerCase())) return str('{{baseUrl}}' + u.slice(baseM[0].length), ctx);
  const bo = originOf(base);
  if (bo && u.startsWith(bo)) {
    const basePath = new URL(base).pathname.replace(/\/$/, '');
    let rest = u.slice(bo.length);
    if (basePath && rest.startsWith(basePath)) rest = rest.slice(basePath.length);
    return str('{{baseUrl}}' + rest, ctx);
  }
  if (u.startsWith('/')) return str('{{baseUrl}}' + u, ctx);
  if (!/^[a-z]+:\/\//i.test(u) && !u.startsWith('{{')) return str('{{baseUrl}}/' + u, ctx);
  return str(u, ctx);
}

function statusCheck(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return null;
  if (/^\dxx$/i.test(s)) { const d = +s[0]; return [`status is ${s}`, `r.status >= ${d * 100} && r.status < ${d * 100 + 100}`]; }
  const codes = s.split(/[\s,|]+/).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
  if (!codes.length) return null;
  if (codes.length === 1) return [`status is ${codes[0]}`, `r.status === ${codes[0]}`];
  return [`status is ${codes.join('/')}`, `[${codes.join(', ')}].includes(r.status)`];
}

function profileOptions(p) {
  const type = p.type || 'load';
  const d = { ...PROFILES[type]?.defaults, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null)) };
  const vus = Math.max(1, parseInt(d.vus, 10) || 1);
  const sc = {};
  switch (type) {
    case 'smoke':
      Object.assign(sc, { executor: 'constant-vus', vus, duration: d.duration });
      break;
    case 'stress': {
      const stages = [];
      for (const f of [0.25, 0.5, 0.75, 1]) {
        const t = Math.max(1, Math.round(vus * f));
        stages.push({ duration: d.rampUp, target: t }, { duration: d.duration, target: t });
      }
      stages.push({ duration: d.rampDown, target: 0 });
      Object.assign(sc, { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '30s' });
      break;
    }
    case 'spike': {
      const base = Math.max(1, Math.round(vus * 0.1));
      Object.assign(sc, {
        executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '30s',
        stages: [
          { duration: '10s', target: base }, { duration: '30s', target: base },
          { duration: '10s', target: vus }, { duration: d.duration, target: vus },
          { duration: '10s', target: base }, { duration: '30s', target: base },
          { duration: '10s', target: 0 },
        ],
      });
      break;
    }
    case 'breakpoint':
      Object.assign(sc, {
        executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s',
        preAllocatedVUs: Math.min(50, parseInt(d.maxVus, 10) || 50), maxVUs: parseInt(d.maxVus, 10) || 1000,
        stages: [{ duration: d.duration, target: parseInt(d.rate, 10) || 100 }],
      });
      break;
    case 'constant-rate':
      Object.assign(sc, {
        executor: 'constant-arrival-rate', rate: parseInt(d.rate, 10) || 10, timeUnit: '1s', duration: d.duration,
        preAllocatedVUs: vus, maxVUs: Math.max(vus, parseInt(d.maxVus, 10) || vus * 10),
      });
      break;
    case 'iterations':
      Object.assign(sc, { executor: 'shared-iterations', vus, iterations: parseInt(d.iterations, 10) || 10, maxDuration: d.maxDuration || '30m' });
      break;
    case 'custom':
      Object.assign(sc, {
        executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '30s',
        stages: (d.stages || []).filter((s) => s.duration).map((s) => ({ duration: s.duration, target: parseInt(s.target, 10) || 0 })),
      });
      break;
    case 'soak':
    case 'load':
    default:
      Object.assign(sc, {
        executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '30s',
        stages: [
          { duration: d.rampUp, target: vus },
          { duration: d.duration, target: vus },
          { duration: d.rampDown, target: 0 },
        ],
      });
  }
  return { main: sc };
}

function thresholdOptions(t = {}, requests = [], abort) {
  const out = {};
  const wrap = (expr) => (abort ? { threshold: expr, abortOnFail: true, delayAbortEval: '10s' } : expr);
  const dur = [];
  if (num(t.p95)) dur.push(wrap(`p(95)<${num(t.p95)}`));
  if (num(t.p99)) dur.push(wrap(`p(99)<${num(t.p99)}`));
  if (dur.length) out.http_req_duration = dur;
  if (num(t.errorRate) !== null) out.http_req_failed = [wrap(`rate<=${+(num(t.errorRate) / 100).toFixed(4)}`)];
  if (num(t.checkRate) !== null) out.checks = [`rate>=${+(num(t.checkRate) / 100).toFixed(4)}`];
  for (const r of requests) {
    if (num(r.slaP95)) out[`http_req_duration{name:${r.name}}`] = [`p(95)<${num(r.slaP95)}`];
  }
  return out;
}
function num(v) { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }

function jsonLit(obj, indent = 0) {
  // JSON → JS literal with unquoted identifier keys, for the options block.
  const pad = '  '.repeat(indent);
  if (Array.isArray(obj)) {
    if (obj.every((x) => typeof x !== 'object')) return `[${obj.map((x) => jsonLit(x)).join(', ')}]`;
    return `[\n${obj.map((x) => `${pad}  ${jsonLit(x, indent + 1)}`).join(',\n')},\n${pad}]`;
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const inline = keys.length <= 3 && keys.every((k) => typeof obj[k] !== 'object');
    const parts = keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${jsonLit(obj[k], indent + 1)}`);
    if (inline) return `{ ${parts.join(', ')} }`;
    return `{\n${parts.map((p) => `${pad}  ${p}`).join(',\n')},\n${pad}}`;
  }
  return typeof obj === 'string' ? q(obj) : String(obj);
}

function requestCode(r, def, ctx, indent) {
  const pad = '  '.repeat(indent);
  const L = [];
  const method = (r.method || 'GET').toUpperCase();
  const url = urlExpr(r.url, def.baseUrl, ctx);
  const headers = { ...(r.headers || {}) };
  const bodyType = r.bodyType || (r.body ? 'text' : 'none');
  const hasBody = bodyType !== 'none' && r.body !== undefined && r.body !== '' && !['GET', 'HEAD'].includes(method);
  const hk = (n) => Object.keys(headers).find((k) => k.toLowerCase() === n);
  if (hasBody && bodyType === 'json' && !hk('content-type')) headers['Content-Type'] = 'application/json';

  let bodyVar = 'null';
  if (hasBody) {
    if (bodyType === 'json') {
      let parsed;
      try { parsed = JSON.parse(r.body); } catch { parsed = undefined; }
      if (parsed !== undefined && typeof parsed === 'object') {
        const pv = `payload${++ctx.payloads}`;
        L.push(`${pad}const ${pv} = ${lit(parsed, ctx, indent)};`);
        bodyVar = `JSON.stringify(${pv})`;
      } else {
        bodyVar = str(r.body, ctx);
      }
    } else if (bodyType === 'form') {
      const obj = Object.fromEntries(new URLSearchParams(r.body));
      const pv = `payload${++ctx.payloads}`;
      L.push(`${pad}const ${pv} = ${lit(obj, ctx, indent)};`);
      bodyVar = pv;
    } else {
      bodyVar = str(r.body, ctx);
    }
  }

  const hlines = Object.entries(headers).filter(([k]) => k).map(([k, v]) => `${pad}    ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${str(v, ctx)},`);
  const paramLines = [];
  if (hlines.length || def.hasDefaultHeaders) {
    if (!hlines.length) paramLines.push(`${pad}  headers: ${def.headersRef},`);
    else paramLines.push(`${pad}  headers: {`, ...(def.hasDefaultHeaders ? [`${pad}    ...${def.headersRef},`] : []), ...hlines, `${pad}  },`);
  }
  paramLines.push(`${pad}  tags: { name: ${q(r.name || `${method} ${r.url}`)} },`);
  if (r.timeout) paramLines.push(`${pad}  timeout: ${q(r.timeout)},`);
  if (r.expectedStatuses) paramLines.push(`${pad}  responseCallback: http.expectedStatuses(${r.expectedStatuses}),`);
  const params = `{\n${paramLines.join('\n')}\n${pad}}`;

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || (method === 'DELETE' && !hasBody)) {
    const fn = { GET: 'get', HEAD: 'head', OPTIONS: 'options', DELETE: 'del' }[method];
    L.push(`${pad}res = http.${fn}(${url}, ${method === 'GET' || method === 'HEAD' ? '' : 'null, '}${params});`);
  } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const fn = { POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'del' }[method];
    L.push(`${pad}res = http.${fn}(${url}, ${bodyVar}, ${params});`);
  } else {
    L.push(`${pad}res = http.request(${q(method)}, ${url}, ${bodyVar}, ${params});`);
  }

  const checks = [];
  const label = r.name || `${method} ${r.url}`;
  const c = r.checks || {};
  const sc = statusCheck(c.status ?? '2xx');
  if (sc) checks.push([`${label}: ${sc[0]}`, sc[1]]);
  if (num(c.maxDuration)) checks.push([`${label}: under ${num(c.maxDuration)}ms`, `r.timings.duration < ${num(c.maxDuration)}`]);
  if (c.contains) checks.push([`${label}: body contains ${String(c.contains).slice(0, 40)}`, `typeof r.body === 'string' && r.body.includes(${str(c.contains, ctx)})`]);
  if (c.jsonPath) checks.push([`${label}: has ${c.jsonPath}`, `jsonValue(r, ${q(c.jsonPath)}) !== undefined`]);
  if (checks.length) {
    L.push(`${pad}check(res, {`);
    for (const [n, e] of checks) L.push(`${pad}  ${q(n)}: (r) => ${e},`);
    L.push(`${pad}});`);
  }

  for (const ex of r.extract || []) {
    if (!ex.name || !ex.path) continue;
    const target = ident(ex.name);
    if (ex.from === 'header') L.push(`${pad}${target} = res.headers[${q(canonicalHeader(ex.path))}];`);
    else if (ex.from === 'regex') L.push(`${pad}${target} = ((typeof res.body === 'string' && res.body.match(new RegExp(${q(ex.path)}))) || [])[1];`);
    else L.push(`${pad}${target} = jsonValue(res, ${q(ex.path)});`);
  }
  if (num(r.thinkTime)) L.push(`${pad}sleep(${num(r.thinkTime)});`);
  return L;
}

function canonicalHeader(h) { return String(h).split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-'); }

export function buildScript(def) {
  const mode = def.engine || 'http';
  if (!['http', 'browser', 'hybrid'].includes(mode)) throw new Error('Unknown test engine');
  const browser = mode !== 'http' ? browserConfig(def.browser) : null;
  const ctx = new Ctx();
  const requests = (def.requests || []).filter((r) => r && r.enabled !== false && r.url);
  if (mode !== 'browser' && !requests.length) throw new Error('Add at least one enabled API request.');
  const baseUrl = (def.baseUrl || '').replace(/\/$/, '') || (requests[0] && originOf(requests[0].url)) || 'http://localhost:8080';
  const profile = def.profile || { type: 'smoke' };
  const defaultHeaders = { ...(def.defaultHeaders || {}) };
  const auth = def.auth || {};
  if (auth.type === 'bearer' && auth.token) defaultHeaders.Authorization = `Bearer ${auth.token}`;
  if (auth.type === 'apikey' && auth.headerName) defaultHeaders[auth.headerName] = auth.value || '';
  const basic = auth.type === 'basic' && auth.username;
  const dynamicHeaders = Object.values(defaultHeaders).some((v) => String(v).match(PH));
  const local = {
    ...def, baseUrl, hasDefaultHeaders: Object.keys(defaultHeaders).length > 0 || !!basic,
    headersRef: dynamicHeaders ? 'defaultHeaders(vars)' : 'HEADERS',
  };
  // Render default headers now so their {{placeholders}} are registered before VARS is built.
  const headerLines = Object.entries(defaultHeaders).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${str(v, ctx)},`);
  if (basic) headerLines.push('Authorization: `Basic ${BASIC_AUTH}`,');

  // Body first so we know which helpers/vars are used.
  const body = [];
  let i = 0;
  while (i < requests.length) {
    const g = requests[i].group;
    if (g) {
      body.push('', `  group(${q(g)}, () => {`);
      while (i < requests.length && requests[i].group === g) {
        body.push(...requestCode(requests[i], local, ctx, 2));
        i++;
        if (i < requests.length && requests[i].group === g) body.push('');
      }
      body.push('  });');
    } else {
      body.push('');
      body.push(...requestCode(requests[i], local, ctx, 1));
      i++;
    }
  }
  const think = def.thinkTime || {};
  if (num(think.max) || num(think.min)) {
    const mn = num(think.min) ?? 0, mx = num(think.max) ?? mn;
    body.push('', mx > mn ? `  sleep(${mn} + Math.random() * ${+(mx - mn).toFixed(3)}); // think time` : `  sleep(${mn}); // think time`);
  }

  const vars = (def.variables || []).filter((v) => v.name);
  const declared = new Set(vars.map((v) => v.name));
  const dataRows = def.data?.csv ? parseCsv(def.data.csv) : [];
  const dataCols = new Set(dataRows.length ? Object.keys(dataRows[0]) : []);
  const extracted = new Set(requests.flatMap((r) => (r.extract || []).map((e) => e.name)));
  // Undeclared placeholders become env-overridable variables so the script always runs.
  for (const name of ctx.usedVars) {
    if (!declared.has(name) && !dataCols.has(name) && !extracted.has(name)) { vars.push({ name, value: '' }); declared.add(name); }
  }

  const options = { scenarios: mode === 'browser' ? {} : profileOptions(profile) };
  if (browser) options.scenarios.browser = browserScenario(browser);
  const th = thresholdOptions(def.thresholds, requests, profile.type === 'breakpoint' || def.thresholds?.abortOnFail);
  if (mode === 'browser') { for (const key of Object.keys(th)) if (key.startsWith('http_')) delete th[key]; }
  if (['constant-rate', 'breakpoint'].includes(profile.type) && mode !== 'browser') th.dropped_iterations = ['count==0'];
  if (browser) {
    th.browser_web_vital_lcp = [`p(75)<${browser.lcp}`];
    th.browser_http_req_failed = ['rate<=0.01'];
    th.checks ||= ['rate>=0.99'];
  }
  if (Object.keys(th).length) options.thresholds = th;
  if (def.options?.insecure) options.insecureSkipTLSVerify = true;

  const out = [];
  out.push(`// ${def.name || 'Generated load test'}`);
  out.push(`// Generated by LoadDeck on ${new Date().toISOString().slice(0, 10)} — profile: ${PROFILES[profile.type]?.label || profile.type}`);
  out.push(`// Override the target with:  -e BASE_URL=https://other-host`);
  if (browser) out.push(`import { browser } from 'k6/browser';`);
  out.push(`import http from 'k6/http';`);
  out.push(`import { check, group, sleep } from 'k6';`);
  if (dataRows.length) {
    out.push(`import { SharedArray } from 'k6/data';`);
    if ((def.data.mode || 'sequential') === 'sequential') out.push(`import exec from 'k6/execution';`);
  }
  if (auth.type === 'basic' && auth.username) out.push(`import encoding from 'k6/encoding';`);
  out.push('');
  out.push(`const BASE_URL = __ENV.BASE_URL || ${q(baseUrl)};`);
  if (basic) {
    out.push(`const BASIC_AUTH = encoding.b64encode(\`\${__ENV.USERNAME || ${q(auth.username)}}:\${__ENV.PASSWORD || ${q(auth.password || '')}}\`);`);
  }
  if (vars.length) {
    out.push('');
    out.push('// Variables — each can be overridden at run time with -e NAME=value');
    out.push('const VARS = {');
    for (const v of vars) {
      const env = (v.env || v.name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      out.push(`  ${/^[A-Za-z_$][\w$]*$/.test(v.name) ? v.name : q(v.name)}: __ENV.${env} || ${q(v.value ?? '')},`);
    }
    out.push('};');
  }
  if (dataRows.length) {
    out.push('');
    out.push(`// Test data (${dataRows.length} rows, mode: ${def.data.mode || 'sequential'}) — loaded once and shared by all VUs`);
    out.push(`const DATA = new SharedArray('test-data', () => ${JSON.stringify(dataRows, null, 2).replace(/\n/g, '\n')});`);
  }
  if (local.hasDefaultHeaders) {
    out.push('');
    if (dynamicHeaders) out.push(`// Default headers (built per iteration because they use variables)\nfunction defaultHeaders(vars) {\n  return {\n${headerLines.map((l) => `    ${l}`).join('\n')}\n  };\n}`);
    else out.push(`const HEADERS = {\n${headerLines.map((l) => `  ${l}`).join('\n')}\n};`);
  }
  out.push('');
  out.push(`export const options = ${jsonLit(options)};`);
  out.push('');
  out.push(`function jsonValue(res, path) {\n  try { return res.json(path); } catch (e) { return undefined; }\n}`);
  if (ctx.usesUuid) {
    out.push(`\nfunction uuid() {\n  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {\n    const r = (Math.random() * 16) | 0;\n    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);\n  });\n}`);
  }
  out.push('');
  out.push('export default function () {');
  const dataMode = def.data?.mode || 'sequential';
  const rowExpr = !dataRows.length ? null
    : dataMode === 'random' ? 'DATA[Math.floor(Math.random() * DATA.length)]'
      : dataMode === 'perVu' ? 'DATA[(__VU - 1) % DATA.length]'
        : 'DATA[exec.scenario.iterationInTest % DATA.length]';
  const parts = [];
  if (vars.length) parts.push('VARS');
  if (rowExpr) parts.push(rowExpr);
  out.push(`  const vars = ${parts.length ? `Object.assign({}, ${parts.join(', ')})` : '{}'};`);
  out.push('  let res;');
  out.push(...body);
  out.push('}');
  out.push('');
  if (browser) out.push(browserJourney(browser));
  return out.join('\n');
}
