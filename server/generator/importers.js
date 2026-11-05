// Importers: each returns a partial test definition { baseUrl, requests, variables, auth, warnings }
// that the UI shows for review before the builder turns it into a k6 script.
import YAML from 'yaml';

let seq = 0;
const rid = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;

function req(o) {
  return {
    id: rid(), enabled: true, name: '', group: '', method: 'GET', url: '', headers: {}, body: '', bodyType: 'none',
    checks: { status: '2xx', maxDuration: '', contains: '' }, extract: [], thinkTime: '', slaP95: '', ...o,
  };
}

function guessBodyType(body, contentType = '') {
  if (!body) return 'none';
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  try { const v = JSON.parse(body); if (v && typeof v === 'object') return 'json'; } catch { /* not json */ }
  return 'text';
}

function shortName(method, url) {
  try {
    const u = new URL(url.replace(/\{\{[^}]+\}\}/g, 'x'), 'http://x');
    const p = decodeURIComponent(u.pathname).replace(/\/$/, '') || '/';
    return `${method} ${p.length > 60 ? '…' + p.slice(-58) : p}`;
  } catch { return `${method} ${url}`.slice(0, 70); }
}

function mostCommonOrigin(urls) {
  const counts = {};
  for (const u of urls) { try { const o = new URL(u).origin; counts[o] = (counts[o] || 0) + 1; } catch { /* skip */ } }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

const DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cookie', 'priority', 'te', 'upgrade-insecure-requests']);
function cleanHeaders(h, keepCookies) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk.startsWith(':') || lk.startsWith('sec-')) continue;
    if (DROP_HEADERS.has(lk) && !(keepCookies && lk === 'cookie')) continue;
    out[k] = v;
  }
  return out;
}

// ---------------- cURL ----------------
function shellSplit(s) {
  const out = [];
  let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { cur += s[++i] === '\n' ? '' : s[i]; }
      else cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") { // $'...' ANSI-C quoting (Chrome "copy as cURL")
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += s[i];
        i++;
      }
      has = true;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && s[i + 1] === '\n') { i++; continue; }
    if (c === '\\' && s[i + 1] === '\r' && s[i + 2] === '\n') { i += 2; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

export function fromCurl(text) {
  const warnings = [];
  // Support several commands pasted together (one per "curl ..." block).
  const chunks = String(text).replace(/\^\r?\n/g, ' ').split(/(?:^|\n)\s*(?=curl\s)/).map((c) => c.trim()).filter((c) => c.startsWith('curl'));
  if (!chunks.length) throw new Error('No curl command found. Paste one or more commands starting with "curl".');
  const requests = [];
  for (const chunk of chunks) {
    const args = shellSplit(chunk.replace(/\^"/g, '"'));
    let method = null, url = '', body = '', getMode = false, insecure = false;
    const headers = {}, dataParts = [], form = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const next = () => args[++i] ?? '';
      if (a === '-X' || a === '--request') method = next().toUpperCase();
      else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
      else if (a === '-H' || a === '--header') { const h = next(); const ix = h.indexOf(':'); if (ix > 0) headers[h.slice(0, ix).trim()] = h.slice(ix + 1).trim(); }
      else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(a)) dataParts.push(next());
      else if (a === '--data-urlencode') { const v = next(); const ix = v.indexOf('='); dataParts.push(ix > 0 ? `${v.slice(0, ix)}=${encodeURIComponent(v.slice(ix + 1))}` : encodeURIComponent(v)); }
      else if (a === '--json') { dataParts.push(next()); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; headers.Accept = headers.Accept || 'application/json'; }
      else if (a === '-F' || a === '--form') form.push(next());
      else if (a === '-u' || a === '--user') { headers.Authorization = `Basic ${Buffer.from(next()).toString('base64')}`; }
      else if (a === '-b' || a === '--cookie') headers.Cookie = next();
      else if (a === '-A' || a === '--user-agent') headers['User-Agent'] = next();
      else if (a === '-e' || a === '--referer') headers.Referer = next();
      else if (a === '-G' || a === '--get') getMode = true;
      else if (a === '-I' || a === '--head') method = 'HEAD';
      else if (a === '-k' || a === '--insecure') insecure = true;
      else if (a === '--url') url = next();
      else if (['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--retry', '-x', '--proxy', '--cacert', '--cert', '--key'].includes(a)) next();
      else if (a.startsWith('-')) { /* ignore flags like --compressed, -s, -L, -v, -i */ }
      else if (!url) url = a;
    }
    if (!url) { warnings.push('Skipped a curl command without URL.'); continue; }
    if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
    body = dataParts.join('&');
    if (getMode && body) { url += (url.includes('?') ? '&' : '?') + body; body = ''; }
    if (form.length) {
      warnings.push('Multipart form fields (-F) were converted to url-encoded form fields; file uploads need manual editing.');
      body = form.map((f) => f.replace(/=@.*/, '=FILE')).join('&');
    }
    if (!method) method = body ? 'POST' : 'GET';
    if (insecure) warnings.push('curl used -k/--insecure: enable "Skip TLS verification" if needed.');
    const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
    let bodyType = guessBodyType(body, ctKey ? headers[ctKey] : '');
    if (bodyType === 'text' && body && !ctKey && !form.length && /^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/.test(body)) bodyType = 'form';
    if (bodyType === 'json') { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep raw */ } }
    requests.push(req({ name: shortName(method, url), method, url, headers: cleanHeaders(headers, true), body, bodyType }));
  }
  return { baseUrl: mostCommonOrigin(requests.map((r) => r.url)), requests, warnings };
}

// ---------------- HAR (browser recording) ----------------
const STATIC_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)(\?|$)/i;
const STATIC_TYPES = ['image/', 'font/', 'text/css', 'javascript', 'video/', 'audio/'];

export function fromHar(text, opts = {}) {
  const har = typeof text === 'string' ? JSON.parse(text) : text;
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file (missing log.entries).');
  const warnings = [];
  const includeStatic = !!opts.includeStatic;
  const domains = (opts.domains || '').split(/[\s,]+/).filter(Boolean);
  const pages = new Map((har.log.pages || []).map((p) => [p.id, p]));

  let skipped = 0;
  const kept = entries.filter((e) => {
    const url = e.request?.url || '';
    if (!/^https?:/i.test(url)) return false;
    const mime = (e.response?.content?.mimeType || '').toLowerCase();
    if (!includeStatic && (STATIC_RE.test(url) || STATIC_TYPES.some((t) => mime.includes(t)))) { skipped++; return false; }
    if (domains.length) { try { const h = new URL(url).hostname; if (!domains.some((d) => h === d || h.endsWith('.' + d))) { skipped++; return false; } } catch { return false; } }
    return true;
  }).sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  if (skipped) warnings.push(`Skipped ${skipped} static asset / third-party request(s). Toggle "include static assets" or adjust domains to keep them.`);

  const requests = [];
  let prevEnd = null, prevPage = null;
  for (const e of kept) {
    const r = e.request;
    const headers = Object.fromEntries((r.headers || []).map((h) => [h.name, h.value]));
    const ct = (r.postData?.mimeType || headers['content-type'] || headers['Content-Type'] || '');
    let body = r.postData?.text || '';
    if (!body && r.postData?.params?.length) body = r.postData.params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value || '')}`).join('&');
    let bodyType = guessBodyType(body, ct);
    if (bodyType === 'json') { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* raw */ } }
    const page = pages.get(e.pageref);
    const group = page ? (page.title || e.pageref).slice(0, 80) : '';
    const start = Date.parse(e.startedDateTime);
    // Think time: gap before a new page/navigation in the recording (capped).
    if (requests.length && prevEnd && (e.pageref !== prevPage || start - prevEnd > 1500)) {
      const gap = Math.min(10, Math.max(0, (start - prevEnd) / 1000));
      if (gap >= 0.5) requests[requests.length - 1].thinkTime = +gap.toFixed(1);
    }
    prevEnd = Math.max(prevEnd || 0, start + (e.time || 0));
    prevPage = e.pageref;
    const status = e.response?.status;
    requests.push(req({
      name: shortName(r.method, r.url), group, method: r.method, url: r.url,
      headers: cleanHeaders(headers, !!opts.keepCookies), body, bodyType,
      checks: { status: status && status >= 100 ? String(status) : '2xx', maxDuration: '', contains: '' },
    }));
  }
  if (!requests.length) throw new Error('No matching requests found in the HAR file.');
  if (requests.length > 150) warnings.push(`${requests.length} requests imported — consider disabling the ones you do not need.`);
  warnings.push('Cookies are handled automatically by k6\'s cookie jar; recorded Cookie headers were dropped unless you chose to keep them. Look for session tokens / CSRF values that must be extracted from earlier responses.');
  return { baseUrl: mostCommonOrigin(requests.map((r) => r.url)), requests, warnings, thinkTime: { min: '', max: '' } };
}

// ---------------- OpenAPI / Swagger ----------------
function resolveRef(doc, ref) {
  if (!ref?.startsWith('#/')) return {};
  return ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc) || {};
}
function deref(doc, obj, seen = new Set()) {
  if (obj && obj.$ref) { if (seen.has(obj.$ref)) return {}; seen.add(obj.$ref); return deref(doc, resolveRef(doc, obj.$ref), seen); }
  return obj || {};
}
function sample(doc, schema, depth = 0, seen = new Set()) {
  if (schema?.$ref) {
    if (seen.has(schema.$ref) || depth > 6) return null;
    const s2 = new Set(seen); s2.add(schema.$ref);
    return sample(doc, resolveRef(doc, schema.$ref), depth + 1, s2);
  }
  const s = schema || {};
  if (s.example !== undefined) return s.example;
  if (s.examples && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sample(doc, x, depth + 1, seen)).filter((x) => x && typeof x === 'object'));
  if (s.oneOf || s.anyOf) return sample(doc, (s.oneOf || s.anyOf)[0], depth + 1, seen);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type || (s.properties ? 'object' : s.items ? 'array' : 'string');
  switch (type) {
    case 'object': {
      const o = {};
      for (const [k, v] of Object.entries(s.properties || {})) { if (depth < 6) o[k] = sample(doc, v, depth + 1, seen); }
      return o;
    }
    case 'array': return depth < 6 ? [sample(doc, s.items, depth + 1, seen)] : [];
    case 'integer': return s.minimum ?? 1;
    case 'number': return s.minimum ?? 1.5;
    case 'boolean': return true;
    default:
      switch (s.format) {
        case 'email': return 'user@example.com';
        case 'date': return '2026-01-01';
        case 'date-time': return '2026-01-01T00:00:00Z';
        case 'uuid': return '{{$uuid}}';
        case 'uri': case 'url': return 'https://example.com';
        case 'password': return 'P@ssw0rd!';
        default: return 'string';
      }
  }
}

export function fromOpenApi(text, opts = {}) {
  let doc;
  try { doc = typeof text === 'string' ? (text.trim().startsWith('{') ? JSON.parse(text) : YAML.parse(text)) : text; }
  catch (e) { throw new Error('Could not parse spec as JSON or YAML: ' + e.message); }
  if (!doc?.paths) throw new Error('Not an OpenAPI/Swagger document (missing "paths").');
  const warnings = [];
  const isV2 = !!doc.swagger;
  let baseUrl = '';
  if (isV2) baseUrl = `${(doc.schemes || ['https'])[0]}://${doc.host || 'localhost'}${doc.basePath || ''}`;
  else if (doc.servers?.[0]?.url) {
    baseUrl = doc.servers[0].url.replace(/\{(\w+)\}/g, (_, v) => doc.servers[0].variables?.[v]?.default ?? v);
  }
  if (!/^https?:\/\//.test(baseUrl)) { warnings.push(`Server URL "${baseUrl || '(none)'}" is relative — set the Base URL.`); baseUrl = 'http://localhost:8080' + (baseUrl.startsWith('/') ? baseUrl : ''); }

  const variables = new Map();
  const auth = { type: 'none' };
  const schemes = isV2 ? doc.securityDefinitions || {} : doc.components?.securitySchemes || {};
  for (const s of Object.values(schemes)) {
    const sc = deref(doc, s);
    if ((sc.type === 'http' && sc.scheme?.toLowerCase() === 'bearer') || sc.type === 'oauth2' || sc.type === 'openIdConnect') { Object.assign(auth, { type: 'bearer', token: '{{token}}' }); variables.set('token', ''); break; }
    if (sc.type === 'apiKey' && sc.in === 'header') { Object.assign(auth, { type: 'apikey', headerName: sc.name, value: '{{apiKey}}' }); variables.set('apiKey', ''); break; }
    if ((sc.type === 'http' && sc.scheme === 'basic') || sc.type === 'basic') { Object.assign(auth, { type: 'basic', username: 'user', password: 'pass' }); break; }
  }

  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const include = (opts.methods || 'get,post,put,patch,delete').split(',');
  const requests = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    const pathItem = deref(doc, item);
    for (const m of methods) {
      const op = pathItem[m];
      if (!op || !include.includes(m)) continue;
      const params = [...(pathItem.parameters || []), ...(op.parameters || [])].map((x) => deref(doc, x));
      let url = p.replace(/\{([^}]+)\}/g, (_, name) => {
        const prm = params.find((x) => x.in === 'path' && x.name === name);
        const ex = prm ? (prm.example ?? sample(doc, prm.schema || { type: prm.type || 'string' })) : '1';
        const varName = name.replace(/[^\w]/g, '_');
        if (!variables.has(varName)) variables.set(varName, String(ex === 'string' ? '1' : ex));
        return `{{${varName}}}`;
      });
      const query = params.filter((x) => x.in === 'query' && (x.required || opts.allQuery));
      if (query.length) {
        url += '?' + query.map((x) => `${encodeURIComponent(x.name)}=${encodeURIComponent(String(x.example ?? sample(doc, x.schema || { type: x.type || 'string' })))}`).join('&');
      }
      const headers = {};
      for (const h of params.filter((x) => x.in === 'header' && x.required)) headers[h.name] = String(h.example ?? sample(doc, h.schema || { type: 'string' }));
      let body = '', bodyType = 'none';
      if (isV2) {
        const bp = params.find((x) => x.in === 'body');
        if (bp) { body = JSON.stringify(sample(doc, bp.schema), null, 2); bodyType = 'json'; }
      } else if (op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const content = rb.content || {};
        const ct = Object.keys(content).find((k) => k.includes('json')) || Object.keys(content)[0];
        if (ct) {
          const media = content[ct];
          const ex = media.example ?? (media.examples ? deref(doc, Object.values(media.examples)[0]).value : undefined) ?? sample(doc, media.schema);
          if (ct.includes('json')) { body = JSON.stringify(ex, null, 2); bodyType = 'json'; }
          else if (ct.includes('x-www-form-urlencoded') && ex && typeof ex === 'object') { body = new URLSearchParams(Object.entries(ex).map(([k, v]) => [k, String(v)])).toString(); bodyType = 'form'; }
          else { body = typeof ex === 'string' ? ex : JSON.stringify(ex); bodyType = 'text'; headers['Content-Type'] = ct; }
        }
      }
      const okCodes = Object.keys(op.responses || {}).filter((c) => /^2\d\d$/.test(c));
      const name = (op.operationId || op.summary || `${m.toUpperCase()} ${p}`).toString().slice(0, 80);
      requests.push(req({
        name, group: (op.tags && op.tags[0]) || '', method: m.toUpperCase(), url, headers, body, bodyType,
        checks: { status: okCodes.length ? okCodes.join(',') : '2xx', maxDuration: '', contains: '' },
        enabled: m === 'get' || !!opts.enableWrites,
      }));
    }
  }
  if (!requests.length) throw new Error('No operations found in the spec.');
  if (!opts.enableWrites && requests.some((r) => !r.enabled)) warnings.push('Write operations (POST/PUT/PATCH/DELETE) were imported disabled so the test does not modify data by accident — enable the ones you want.');
  warnings.push('Path parameters became variables (e.g. {{id}}) with example values — set realistic values or feed them from test data.');
  return {
    name: doc.info?.title ? `${doc.info.title} API test` : undefined,
    baseUrl: baseUrl.replace(/\/$/, ''),
    requests,
    variables: [...variables].map(([name, value]) => ({ name, value })),
    auth,
    warnings,
  };
}

// ---------------- Postman collection v2/v2.1 ----------------
export function fromPostman(text) {
  const col = typeof text === 'string' ? JSON.parse(text) : text;
  if (!col?.item) throw new Error('Not a Postman collection (missing "item").');
  const warnings = [];
  const variables = (col.variable || []).filter((v) => v.key).map((v) => ({ name: v.key, value: String(v.value ?? '') }));
  let auth = { type: 'none' };
  const mapAuth = (a) => {
    if (!a) return null;
    const get = (arr, k) => (Array.isArray(arr) ? arr.find((x) => x.key === k)?.value : arr?.[k]);
    if (a.type === 'bearer') return { type: 'bearer', token: get(a.bearer, 'token') || '' };
    if (a.type === 'basic') return { type: 'basic', username: get(a.basic, 'username') || '', password: get(a.basic, 'password') || '' };
    if (a.type === 'apikey' && (get(a.apikey, 'in') || 'header') === 'header') return { type: 'apikey', headerName: get(a.apikey, 'key') || 'X-API-Key', value: get(a.apikey, 'value') || '' };
    return null;
  };
  auth = mapAuth(col.auth) || auth;

  const requests = [];
  let hasScripts = false;
  const walk = (items, folder) => {
    for (const it of items) {
      if (it.item) { walk(it.item, folder ? `${folder} / ${it.name}` : it.name); continue; }
      const r = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request || {};
      if ((it.event || []).some((e) => e.script?.exec?.join?.('').trim())) hasScripts = true;
      let url = typeof r.url === 'string' ? r.url : r.url?.raw || '';
      if (!url && r.url?.host) url = `${(r.url.protocol || 'https')}://${[].concat(r.url.host).join('.')}/${[].concat(r.url.path || []).join('/')}`;
      url = url.replace(/(^|\/):(\w+)/g, (m, s, n) => `${s}{{${n}}}`); // :param path variables
      const headers = Object.fromEntries((r.header || []).filter((h) => !h.disabled).map((h) => [h.key, h.value]));
      let body = '', bodyType = 'none';
      const b = r.body;
      if (b?.mode === 'raw') { body = b.raw || ''; bodyType = guessBodyType(body, b.options?.raw?.language === 'json' ? 'json' : headers['Content-Type'] || ''); }
      else if (b?.mode === 'urlencoded') { body = (b.urlencoded || []).filter((x) => !x.disabled).map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value || '')}`).join('&'); bodyType = 'form'; }
      else if (b?.mode === 'formdata') { body = (b.formdata || []).filter((x) => !x.disabled && x.type !== 'file').map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value || '')}`).join('&'); bodyType = 'form'; warnings.push(`"${it.name}": multipart form-data was converted to url-encoded.`); }
      else if (b?.mode === 'graphql') { body = JSON.stringify({ query: b.graphql?.query || '', variables: tryJson(b.graphql?.variables) }, null, 2); bodyType = 'json'; }
      const ra = mapAuth(r.auth);
      if (ra?.type === 'bearer' && !headers.Authorization) headers.Authorization = `Bearer ${ra.token}`;
      requests.push(req({ name: (it.name || shortName(r.method || 'GET', url)).slice(0, 80), group: folder || '', method: (r.method || 'GET').toUpperCase(), url, headers, body, bodyType }));
    }
  };
  walk(col.item, '');
  if (hasScripts) warnings.push('The collection has pre-request/test scripts; those are not converted. Add checks/extractions in the request editor.');
  const baseVar = variables.find((v) => ['baseurl', 'base_url', 'url', 'host'].includes(v.name.toLowerCase()));
  return { name: col.info?.name ? `${col.info.name} load test` : undefined, baseUrl: baseVar?.value || mostCommonOrigin(requests.map((r) => r.url)), requests, variables: variables.filter((v) => v !== baseVar), auth, warnings };
}
function tryJson(s) { try { return JSON.parse(s); } catch { return {}; } }

export function fromUrl(url, method = 'GET') {
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  return { baseUrl: new URL(url).origin, requests: [req({ name: shortName(method, url), method, url })], warnings: [] };
}
