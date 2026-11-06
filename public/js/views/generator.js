import { api, esc, toast, readFile, store, fmt } from '../ui.js';
import { navigate, setLeaveGuard, app } from '../app.js';
import { lineChart, seriesColors } from '../report-view.js';
import { openRunDialog } from './run-dialog.js';
import { icon } from '../icons.js';
import { streamAi, usageText, providerPicker, rememberProvider } from '../ai.js';

const SOURCES = {
  ai: { label: '✦ Describe with AI', help: '' },
  url: { label: 'URL', help: 'Start from a single endpoint. You can add more requests afterwards.', placeholder: 'https://api.example.com/health' },
  curl: { label: 'cURL', help: 'Paste one or more cURL commands — e.g. from browser DevTools → Network → right-click → Copy as cURL.', placeholder: "curl 'https://api.example.com/login' -H 'Content-Type: application/json' --data-raw '{\"user\":\"demo\",\"pass\":\"secret\"}'" },
  har: { label: 'HAR recording', help: 'Record a user journey in the browser (DevTools → Network → ⋯ → Save all as HAR) and drop the file here. Static assets are filtered out.', placeholder: 'Drop a .har file or paste its JSON…', file: '.har,.json' },
  openapi: { label: 'OpenAPI / Swagger', help: 'Import an OpenAPI 3 or Swagger 2 spec (JSON or YAML). Every operation becomes a request with example payloads.', placeholder: 'Drop openapi.yaml / swagger.json or paste it…', file: '.json,.yaml,.yml' },
  postman: { label: 'Postman', help: 'Import a Postman collection (v2/v2.1 export). Folders become groups, {{variables}} are kept.', placeholder: 'Drop a Postman collection .json or paste it…', file: '.json' },
};
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PROFILE_FIELDS = {
  smoke: [['vus', 'Virtual users'], ['duration', 'Duration']],
  load: [['vus', 'Target VUs'], ['rampUp', 'Ramp-up'], ['duration', 'Hold for'], ['rampDown', 'Ramp-down']],
  stress: [['vus', 'Peak VUs'], ['rampUp', 'Ramp per step'], ['duration', 'Hold per step'], ['rampDown', 'Ramp-down']],
  spike: [['vus', 'Spike VUs'], ['duration', 'Hold spike for']],
  soak: [['vus', 'Target VUs'], ['rampUp', 'Ramp-up'], ['duration', 'Hold for'], ['rampDown', 'Ramp-down']],
  breakpoint: [['rate', 'Final iterations/s'], ['duration', 'Ramp duration'], ['maxVus', 'Max VUs']],
  'constant-rate': [['rate', 'Iterations / second'], ['duration', 'Duration'], ['vus', 'Pre-allocated VUs'], ['maxVus', 'Max VUs']],
  iterations: [['vus', 'Virtual users'], ['iterations', 'Total iterations']],
  custom: [],
};

let seq = 0;
const newReq = (o = {}) => ({ id: `n${Date.now().toString(36)}${seq++}`, enabled: true, name: '', group: '', method: 'GET', url: '', headers: {}, body: '', bodyType: 'none', checks: { status: '2xx', maxDuration: '', contains: '' }, extract: [], thinkTime: '', slaP95: '', ...o });

function defaultDef() {
  return {
    engine: 'http', browser: { vus: 2, duration: '1m', lcp: 2500, steps: [{ action: 'goto', value: '/', selector: '' }] },
    name: 'New load test', baseUrl: '', requests: [], variables: [], data: { csv: '', mode: 'sequential' }, defaultHeaders: {},
    auth: { type: 'none' }, profile: { type: 'load', ...(app.info?.profiles?.load?.defaults || {}) },
    thresholds: { p95: 500, p99: '', errorRate: 1, checkRate: 99, abortOnFail: false }, thinkTime: { min: 1, max: 3 }, options: { insecure: false }, source: 'builder',
  };
}

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((x, k) => (x[k] ??= {}), o); t[last] = v; };
const headersText = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const parseHeaders = (t) => Object.fromEntries(String(t).split('\n').map((l) => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean));
const varsText = (vs) => (vs || []).map((v) => `${v.name}=${v.value ?? ''}`).join('\n');
const parseVars = (t) => String(t).split('\n').map((l) => { const i = l.indexOf('='); const n = (i > 0 ? l.slice(0, i) : l).trim(); return n ? { name: n, value: i > 0 ? l.slice(i + 1).trim() : '' } : null; }).filter(Boolean);

function durSec(d) {
  if (d == null || d === '') return 0;
  if (!isNaN(d)) return +d;
  let s = 0;
  for (const m of String(d).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) s += +m[1] * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  return s;
}

// Approximate VU / rate curve for the profile preview chart.
function profileShape(p) {
  const d = { ...(app.info?.profiles?.[p.type]?.defaults || {}), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null)) };
  const vus = +d.vus || 1;
  let stages = [];
  let unit = 'VUs';
  switch (p.type) {
    case 'smoke': stages = [[0, vus], [durSec(d.duration), vus]]; return { pts: [[0, vus], [durSec(d.duration), vus]], unit };
    case 'stress': for (const f of [0.25, 0.5, 0.75, 1]) { const t = Math.max(1, Math.round(vus * f)); stages.push([d.rampUp, t], [d.duration, t]); } stages.push([d.rampDown, 0]); break;
    case 'spike': { const b = Math.max(1, Math.round(vus * 0.1)); stages = [['10s', b], ['30s', b], ['10s', vus], [d.duration, vus], ['10s', b], ['30s', b], ['10s', 0]]; break; }
    case 'breakpoint': unit = 'iterations/s'; return { pts: [[0, 1], [durSec(d.duration), +d.rate || 100]], unit };
    case 'constant-rate': unit = 'iterations/s'; return { pts: [[0, +d.rate], [durSec(d.duration), +d.rate]], unit };
    case 'iterations': return { pts: [[0, vus], [Math.max(10, (+d.iterations || 10) / vus), vus]], unit, approx: true };
    case 'custom': stages = (d.stages || []).map((s) => [s.duration, +s.target || 0]); break;
    default: stages = [[d.rampUp, vus], [d.duration, vus], [d.rampDown, 0]];
  }
  const pts = [[0, 0]];
  let t = 0;
  for (const [du, target] of stages) { t += durSec(du); pts.push([t, target]); }
  return { pts, unit };
}

export default async function generator(el, { params, query }) {
  const scriptId = params[0] || null;
  let script = null;
  let def;
  if (scriptId) {
    script = await api(`/api/scripts/${scriptId}`);
    def = script.generator ? structuredClone(script.generator) : defaultDef();
    if (!script.generator) toast('This script was not made with the builder — starting a fresh definition.', true);
  } else {
    def = store.get('gen-draft', null) || defaultDef();
  }
  const requestedEngine = query?.get('engine');
  if (!scriptId && ['http', 'browser', 'hybrid'].includes(requestedEngine)) def.engine = requestedEngine;
  let tab = def.engine === 'browser' ? 'browser' : def.requests.length ? 'requests' : 'source';
  let source = def.engine === 'browser' || query?.get('source') === 'ai' ? 'ai' : store.get('gen-source', 'curl');
  let open = new Set();
  let warnings = [];
  let previewCm = null, previewCode = '';
  let profileChart = null;
  let dirty = false;

  const persist = () => { dirty = true; if (!scriptId) store.set('gen-draft', def); };
  setLeaveGuard((silent) => !dirty || !scriptId || (!silent && window.confirm('Unsaved builder changes. Leave anyway?')));

  el.innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">DESIGN YOUR WORKLOAD</div><h1>${scriptId ? `Builder · ${esc(script.name)}` : 'Build a performance test'}</h1><p>Start with a real journey. Define the load. Know what good looks like.</p></div>
      <div class="row"><button class="btn ghost" id="reset">${scriptId ? 'Revert' : 'Start over'}</button></div>
    </div>
    <fieldset class="engine-picker" id="engine">
      <legend>What would you like to test?</legend>
      <div class="engine-options">${[
        ['http', 'server', 'API load', 'Send protocol requests to test service capacity.'],
        ['browser', 'browser', 'Real browsers', 'Run user journeys and measure the frontend.'],
        ['hybrid', 'layers', 'Hybrid', 'Test the user experience under API load.'],
      ].map(([v, i, title, help]) => `<label class="engine-option"><input type="radio" name="engine" value="${v}" ${(def.engine || 'http') === v ? 'checked' : ''}>${icon(i)}<span><b>${title}</b><small>${help}</small></span><span class="selection-dot" aria-hidden="true"></span></label>`).join('')}</div>
    </fieldset>
    <div class="tabs" id="tabs"></div>
    <div id="pane"></div>
    <div class="sticky-bar row">
      <div class="builder-name"><input type="text" id="gname" aria-label="Test name" value="${esc(def.name)}" placeholder="Test name"><span class="muted small" id="gsum"></span></div>
      <button class="btn" id="preview">Preview script</button>
      <button class="btn" id="save">${scriptId ? 'Update script' : 'Save as script'}</button>
      <button class="btn primary" id="saverun">Save &amp; run ▶</button>
    </div>`;

  let pane = el.querySelector('#pane');
  const drawTabs = () => {
    const n = def.requests.length;
    const steps = def.engine === 'browser'
      ? [['browser', 'Browser journey'], ['preview', 'Review script']]
      : [['source', 'Import'], ['requests', `Requests <span class="count">${n}</span>`], ...(def.engine === 'hybrid' ? [['browser', 'Browser journey']] : []), ['profile', 'Load & SLAs'], ['data', 'Data & auth'], ['preview', 'Review script']];
    el.querySelector('#tabs').innerHTML = steps.map(([k, l], i) => `<button data-tab="${k}" ${tab === k ? 'aria-current="step"' : ''} class="${tab === k ? 'on' : ''}"><span class="step-number">${i + 1}</span>${l}</button>`).join('') + (def.engine === 'browser' ? `<button class="ai-option ${tab === 'source' ? 'on' : ''}" data-tab="source" ${tab === 'source' ? 'aria-current="step"' : ''}>${icon('spark')} AI assistant</button>` : '');
    const on = def.requests.filter((r) => r.enabled !== false).length;
    const browserSummary = `${def.browser?.vus || 2} browser${Number(def.browser?.vus) === 1 ? '' : 's'} · ${def.browser?.duration || '1m'}`;
    el.querySelector('#gsum').textContent = def.engine === 'browser' ? browserSummary : `${on} API request${on === 1 ? '' : 's'} · ${app.info?.profiles?.[def.profile.type]?.label || def.profile.type}${def.engine === 'hybrid' ? ` + ${browserSummary}` : ''}`;
  };

  function draw() {
    aiAbort?.abort();
    el.querySelectorAll('#engine input').forEach(input => { input.checked = input.value === (def.engine || 'http'); });
    drawTabs();
    // The AI panel has its own save buttons; the builder bar would only confuse there.
    el.querySelector('.sticky-bar').classList.toggle('hidden', tab === 'source' && (source === 'ai' || def.engine === 'browser'));
    profileChart?.destroy(); profileChart = null;
    previewCm = null;
    // Fresh pane element each time so per-tab listeners never accumulate.
    const fresh = pane.cloneNode(false);
    pane.replaceWith(fresh);
    pane = fresh;
    ({ source: drawSource, requests: drawRequests, profile: drawProfile, browser: drawBrowser, data: drawData, preview: drawPreview })[tab]();
  }

  // ---------- 1. Source ----------
  // ---------- 1a. AI (Claude) ----------
  let aiAbort = null;
  function loadHint() {
    const p = def.profile || {};
    const label = app.info?.profiles?.[p.type]?.label || p.type;
    const params = Object.entries(p).filter(([k, v]) => k !== 'type' && v !== '' && v != null).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    const t = def.thresholds || {};
    const th = [t.p95 && `p95 < ${t.p95}ms`, t.p99 && `p99 < ${t.p99}ms`, t.errorRate !== '' && t.errorRate != null && `error rate <= ${t.errorRate}%`, t.checkRate !== '' && t.checkRate != null && `checks >= ${t.checkRate}%`].filter(Boolean).join(', ');
    const tt = def.thinkTime || {};
    return `Profile: ${label}${params ? ` (${params})` : ''}\nThresholds: ${th || 'none'}${tt.min || tt.max ? `\nThink time between iterations: ${tt.min || 0}–${tt.max || tt.min}s` : ''}`;
  }
  const liveCode = (t) => { const m = /```[a-z]*\n([\s\S]*?)(?:```|$)/.exec(t); return m ? m[1] : ''; };

  function drawAi() {
    const configured = app.info?.ai?.configured;
    pane.innerHTML = `
      <div class="row" id="srcs" style="margin-bottom:12px">${Object.entries(SOURCES).filter(([k]) => def.engine !== 'browser' || k === 'ai').map(([k, v]) => `<button class="btn ${k === source ? 'primary' : ''}" data-src="${k}">${v.label}</button>`).join('')}</div>
      ${configured ? '' : `<div class="warnbox" style="margin-bottom:12px"><b>Set up an AI provider first.</b> Add an API key for Claude, OpenAI, Gemini, NVIDIA, Groq, OpenRouter, Mistral, DeepSeek, Ollama or any OpenAI-compatible endpoint in <a href="#/settings">Settings → AI providers</a>.</div>`}
      <div class="card">
        <p class="muted" style="margin-top:0">Describe the test in plain English. The AI writes the k6 script, k6 checks it, and the AI fixes anything k6 rejects. The selected test type above applies to AI generation too. Validation checks script loading; endpoints, selectors and runtime behaviour still need a smoke test.</p>
        <label class="f">What should the test do?<textarea id="aiprompt" rows="5" style="font-family:inherit;font-size:14px" placeholder="e.g. Log in with POST /api/login using users from a CSV, browse 3 random products, add one to the cart and check out. Ramp to 200 users over 5 minutes, hold for 10. p95 under 400ms and under 1% errors.">${esc(store.get('ai-prompt', ''))}</textarea></label>
        <div class="grid2" style="margin-top:10px">
          <label class="f">Base URL (optional)<input type="text" id="aibase" class="mono" value="${esc(def.baseUrl || '')}" placeholder="https://api.example.com"></label>
          <div class="${def.engine === 'browser' ? 'hidden' : ''}" style="display:flex;align-items:flex-end;padding-bottom:6px"><label class="check"><input type="checkbox" id="aiload" ${store.get('ai-useload', false) ? 'checked' : ''}> Use the configured load profile &amp; SLAs (${esc(app.info?.profiles?.[def.profile.type]?.label || def.profile.type)})</label></div>
        </div>
        <details style="margin-top:6px"><summary>Reference material (optional) — API docs, an OpenAPI spec, sample requests</summary>
          <textarea id="airef" rows="6" placeholder="Paste anything that helps the AI get endpoints and payloads right…"></textarea>
          <div class="drop" id="aidrop" style="margin-top:8px">Drop a file here or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">browse<input type="file" id="aifile" hidden></label> <span id="aifname" class="small"></span></div>
        </details>
        <div class="row" style="margin-top:14px">
          ${providerPicker(app.info)}
          <button class="btn primary" id="aigo" ${configured ? '' : 'disabled'}>✦ Generate</button>
          <button class="btn hidden" id="aistop">Cancel</button>
          <span class="muted small" id="aistatus"></span>
        </div>
      </div>
      <div class="card hidden" id="aiout" style="margin-top:12px">
        <details id="aithink"><summary>Model reasoning</summary><div class="small muted" id="aithinktext" style="white-space:pre-wrap;max-height:220px;overflow:auto"></div></details>
        <div class="editor-wrap" style="margin-top:8px"><textarea id="aicode"></textarea></div>
        <div id="ainotes" class="small" style="margin-top:10px"></div>
        <div class="row" style="margin-top:12px">
          <input type="text" id="ainame" placeholder="Script name" style="max-width:320px">
          <span class="grow"></span>
          <span class="muted small" id="aiusage"></span>
          <button class="btn" id="aicopy">Copy</button>
          <button class="btn" id="aisave">Save as script</button>
          <button class="btn primary" id="aisaverun">Save &amp; run ▶</button>
        </div>
      </div>`;

    pane.querySelector('#srcs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-src]');
      if (b) { source = b.dataset.src; store.set('gen-source', source); warnings = []; draw(); }
    });
    const promptEl = pane.querySelector('#aiprompt');
    promptEl.addEventListener('input', () => store.set('ai-prompt', promptEl.value));
    pane.querySelector('#aiload').addEventListener('change', (e) => store.set('ai-useload', e.target.checked));
    const drop = pane.querySelector('#aidrop');
    const takeFile = async (f) => { if (!f) return; pane.querySelector('#airef').value = await readFile(f); pane.querySelector('#aifname').textContent = `✓ ${f.name}`; };
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
    pane.querySelector('#aifile').addEventListener('change', (e) => takeFile(e.target.files[0]));

    const out = pane.querySelector('#aiout');
    const status = pane.querySelector('#aistatus');
    const cm = window.CodeMirror.fromTextArea(pane.querySelector('#aicode'), { mode: 'javascript', lineNumbers: true, matchBrackets: true });
    cm.setSize(null, 460);
    let result = null;

    const go = async () => {
      const prompt = promptEl.value.trim();
      if (!prompt) return toast('Describe what the test should do', true);
      const goBtn = pane.querySelector('#aigo'), stopBtn = pane.querySelector('#aistop');
      goBtn.disabled = true; stopBtn.classList.remove('hidden');
      out.classList.remove('hidden');
      pane.querySelector('#ainotes').innerHTML = '';
      pane.querySelector('#aiusage').textContent = '';
      pane.querySelector('#aithinktext').textContent = '';
      cm.setOption('readOnly', true);
      let text = '';
      let thinking = '';
      result = null;
      aiAbort = new AbortController();
      const t0 = Date.now();
      const tick = setInterval(() => { status.dataset.t = `${Math.round((Date.now() - t0) / 1000)}s`; status.textContent = `${status.dataset.msg || ''} · ${status.dataset.t}`; }, 1000);
      const setStatus = (m) => { status.dataset.msg = m; status.textContent = `${m}${status.dataset.t ? ` · ${status.dataset.t}` : ''}`; };
      const provSel = pane.querySelector('#aiprov');
      if (provSel) rememberProvider(provSel.value);
      setStatus('Thinking…');
      await streamAi({
        prompt,
        engine: def.engine || 'http',
        browser: def.browser,
        baseUrl: pane.querySelector('#aibase').value.trim(),
        reference: pane.querySelector('#airef').value,
        loadHint: def.engine !== 'browser' && pane.querySelector('#aiload').checked ? loadHint() : '',
        provider: provSel?.value,
      }, {
        provider: (d) => { status.title = `${d.label} · ${d.model}`; },
        status: (d) => {
          if (d.phase === 'generating') { text = ''; setStatus(d.attempt > 1 ? `Fixing the script (attempt ${d.attempt})…` : 'Thinking…'); }
          if (d.phase === 'validating') setStatus('Checking the script with k6…');
          if (d.phase === 'repairing') pane.querySelector('#ainotes').innerHTML = `<div class="warnbox">k6 rejected attempt ${d.attempt}: <code>${esc(String(d.error).slice(0, 300))}</code> — asking the AI to fix it.</div>`;
        },
        thinking: (d) => { thinking += d.text; pane.querySelector('#aithinktext').textContent = thinking; },
        text: (d) => {
          text += d.text;
          setStatus('Writing the script…');
          const code = liveCode(text);
          if (code) { cm.setValue(code); cm.scrollIntoView({ line: cm.lineCount() - 1, ch: 0 }); }
        },
        done: (d) => {
          result = d;
          cm.setValue(d.code);
          cm.setOption('readOnly', false);
          const notes = d.notes ? `<div style="margin-top:8px"><b>Assumptions to check</b><div style="white-space:pre-wrap;color:var(--muted)">${esc(d.notes)}</div></div>` : '';
          pane.querySelector('#ainotes').innerHTML = (d.valid
            ? `<div style="color:var(--good)">✓ k6 accepted the script${d.attempts > 1 ? ` (fixed after ${d.attempts - 1} rejected attempt${d.attempts > 2 ? 's' : ''})` : ''}.</div>`
            : `<div class="warnbox">k6 still rejects this script after ${d.attempts} attempts: <code>${esc(String(d.error).slice(0, 400))}</code><br>You can edit it here or save it and fix it in the editor.</div>`) + notes;
          pane.querySelector('#aiusage').textContent = `${d.provider} · ${d.model}${d.usage?.output ? ` · ${usageText(d.usage)}` : ''}`;
          const nm = pane.querySelector('#ainame');
          if (!nm.value) nm.value = prompt.split(/[.\n]/)[0].slice(0, 60);
          setStatus(d.valid ? 'Done' : 'Done with errors');
        },
        error: (d) => { setStatus(''); pane.querySelector('#ainotes').innerHTML = `<div class="warnbox" style="border-color:var(--bad)"><b>Generation failed.</b> ${esc(d.message)}</div>`; cm.setOption('readOnly', false); },
      }, aiAbort.signal);
      clearInterval(tick);
      delete status.dataset.t;
      if (aiAbort?.signal.aborted) setStatus('Cancelled');
      aiAbort = null;
      goBtn.disabled = false; stopBtn.classList.add('hidden');
    };
    pane.querySelector('#aigo').addEventListener('click', go);
    pane.querySelector('#aistop').addEventListener('click', () => aiAbort?.abort());
    pane.querySelector('#aicopy').addEventListener('click', () => { navigator.clipboard?.writeText(cm.getValue()); toast('Copied to clipboard'); });
    const saveAi = async (andRun) => {
      const code = cm.getValue();
      if (!code.trim()) return toast('Nothing to save yet', true);
      try {
        const s = await api('/api/scripts', { method: 'POST', body: { name: pane.querySelector('#ainame').value.trim() || 'AI-generated test', description: promptEl.value.trim().slice(0, 160), code, source: 'ai' } });
        toast('Script saved');
        setLeaveGuard(null);
        if (andRun) openRunDialog(s); else navigate(`#/scripts/${s.id}`);
      } catch (e) { toast(e.message, true); }
    };
    pane.querySelector('#aisave').addEventListener('click', () => saveAi(false));
    pane.querySelector('#aisaverun').addEventListener('click', () => saveAi(true));
  }

  function drawSource() {
    if (source === 'ai' || def.engine === 'browser') return drawAi();
    const s = SOURCES[source];
    pane.innerHTML = `
      <div class="row" id="srcs" style="margin-bottom:12px">${Object.entries(SOURCES).filter(([k]) => def.engine !== 'browser' || k === 'ai').map(([k, v]) => `<button class="btn ${k === source ? 'primary' : ''}" data-src="${k}">${v.label}</button>`).join('')}</div>
      <div class="card">
        <p class="muted" style="margin-top:0">${esc(s.help)}</p>
        ${source === 'url'
    ? `<div class="row"><select id="umethod" style="width:110px">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select><input type="text" id="itext" class="grow" placeholder="${esc(s.placeholder)}" style="flex:1"></div>`
    : `<textarea id="itext" rows="10" placeholder="${esc(s.placeholder)}"></textarea>`}
        ${s.file ? `<div class="drop" id="drop" style="margin-top:10px">Drop a file here or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">browse<input type="file" id="ifile" accept="${s.file}" hidden></label><div id="fname" class="small"></div></div>` : ''}
        ${source === 'har' ? `<div class="row" style="margin-top:10px;gap:16px">
          <label class="f" style="min-width:260px">Only these domains (comma-separated, optional)<input type="text" id="hdomains" placeholder="api.example.com, example.com"></label>
          <label class="check"><input type="checkbox" id="hstatic"> Include static assets (images, CSS, JS, fonts)</label>
          <label class="check"><input type="checkbox" id="hcookies"> Keep recorded Cookie headers</label></div>` : ''}
        ${source === 'openapi' ? `<div class="row" style="margin-top:10px;gap:16px">
          <label class="check"><input type="checkbox" id="owrites"> Enable write operations (POST/PUT/PATCH/DELETE)</label>
          <label class="check"><input type="checkbox" id="oquery"> Include optional query parameters</label></div>` : ''}
        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="doimport">Import</button>
          ${def.requests.length ? `<label class="check"><input type="checkbox" id="iappend"> Append to the ${def.requests.length} existing request(s) instead of replacing</label>` : ''}
        </div>
      </div>
      ${warnings.length ? `<div class="warnbox" style="margin-top:12px"><b>Import notes</b><ul style="margin:6px 0 0;padding-left:18px">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <p class="muted small" style="margin-top:14px">Or skip importing and <a href="#" id="manual">add requests by hand →</a></p>`;

    let fileText = null;
    pane.querySelector('#srcs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-src]');
      if (b) { source = b.dataset.src; store.set('gen-source', source); warnings = []; draw(); }
    });
    const drop = pane.querySelector('#drop');
    const takeFile = async (f) => {
      if (!f) return;
      fileText = await readFile(f);
      pane.querySelector('#fname').textContent = `✓ ${f.name} (${fmt.bytes(f.size)})`;
      if (fileText.length < 300000) pane.querySelector('#itext').value = fileText;
      else pane.querySelector('#itext').value = '', pane.querySelector('#itext').placeholder = `Using ${f.name} (too large to show)`;
    };
    if (drop) {
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
      pane.querySelector('#ifile').addEventListener('change', (e) => takeFile(e.target.files[0]));
    }
    pane.querySelector('#manual').addEventListener('click', (e) => { e.preventDefault(); if (!def.requests.length) def.requests.push(newReq({ name: 'Request 1', url: '/' })); open.add(def.requests[def.requests.length - 1].id); tab = 'requests'; persist(); draw(); });
    pane.querySelector('#doimport').addEventListener('click', async () => {
      const text = pane.querySelector('#itext').value.trim() || fileText;
      if (!text) return toast('Paste something or drop a file first', true);
      const options = {
        method: pane.querySelector('#umethod')?.value,
        domains: pane.querySelector('#hdomains')?.value, includeStatic: pane.querySelector('#hstatic')?.checked, keepCookies: pane.querySelector('#hcookies')?.checked,
        enableWrites: pane.querySelector('#owrites')?.checked, allQuery: pane.querySelector('#oquery')?.checked,
      };
      try {
        const r = await api('/api/generate/import', { method: 'POST', body: { type: source, text, options } });
        const append = pane.querySelector('#iappend')?.checked;
        def.requests = append ? [...def.requests, ...r.requests] : r.requests;
        if (!append || !def.baseUrl) def.baseUrl = r.baseUrl || def.baseUrl;
        if (r.variables?.length) { const have = new Set(def.variables.map((v) => v.name)); def.variables.push(...r.variables.filter((v) => !have.has(v.name))); }
        if (r.auth && r.auth.type !== 'none') def.auth = r.auth;
        if (r.name && (!append || def.name === 'New load test')) { def.name = r.name; el.querySelector('#gname').value = r.name; }
        if (r.thinkTime) def.thinkTime = r.thinkTime;
        def.source = source;
        warnings = r.warnings || [];
        open = new Set(def.requests.length <= 3 ? def.requests.map((x) => x.id) : []);
        persist();
        toast(`Imported ${r.requests.length} request(s)`);
        tab = 'requests';
        draw();
        if (warnings.length) pane.insertAdjacentHTML('afterbegin', `<div class="warnbox" style="margin-bottom:12px"><b>Import notes</b><ul style="margin:6px 0 0;padding-left:18px">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- 2. Requests ----------
  function reqCard(r, i) {
    const isOpen = open.has(r.id);
    return `<div class="req ${r.enabled === false ? 'off' : ''}" data-i="${i}">
      <div class="req-head" data-a="toggle">
        <input type="checkbox" data-a="enable" ${r.enabled !== false ? 'checked' : ''} title="Include in script">
        <span class="m ${esc(r.method)}">${esc(r.method)}</span>
        <span class="u" title="${esc(r.url)}"><b style="font-family:system-ui">${esc(r.name || '(unnamed)')}</b> <span class="muted">${esc(r.url)}</span></span>
        ${r.group ? `<span class="g">▸ ${esc(r.group)}</span>` : ''}
        ${r.thinkTime ? `<span class="g">⏱ ${esc(r.thinkTime)}s</span>` : ''}
        <button class="btn icon sm ghost" data-a="up" title="Move up">↑</button>
        <button class="btn icon sm ghost" data-a="down" title="Move down">↓</button>
        <button class="btn icon sm ghost" data-a="dup" title="Duplicate">⧉</button>
        <button class="btn icon sm ghost danger" data-a="del" title="Remove">✕</button>
      </div>
      ${isOpen ? `<div class="req-body">
        <div class="fields">
          <label class="f">Name (used in reports)<input type="text" data-r="name" value="${esc(r.name)}"></label>
          <label class="f">Group / step<input type="text" data-r="group" value="${esc(r.group)}" placeholder="e.g. Login"></label>
          <label class="f">Method<select data-r="method">${METHODS.map((m) => `<option ${m === r.method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        </div>
        <label class="f">URL — absolute, or a path relative to the base URL. Use <code>{{name}}</code> for variables.<input type="text" data-r="url" value="${esc(r.url)}" class="mono"></label>
        <div class="grid2">
          <label class="f">Headers — one <code>Name: value</code> per line<textarea data-r="headers" rows="4" class="mono">${esc(headersText(r.headers))}</textarea></label>
          <label class="f"><span>Body <select data-r="bodyType" style="width:auto;padding:2px 6px;margin-left:6px">${['none', 'json', 'form', 'text'].map((t) => `<option ${t === r.bodyType ? 'selected' : ''}>${t}</option>`).join('')}</select></span>
            <textarea data-r="body" rows="4" class="mono" ${r.bodyType === 'none' ? 'disabled placeholder="No body"' : ''}>${esc(r.body)}</textarea></label>
        </div>
        <div class="fields">
          <label class="f">Expected status<input type="text" data-r="checks.status" value="${esc(r.checks?.status ?? '2xx')}" placeholder="200, 2xx, 200,201"></label>
          <label class="f">Check: faster than (ms)<input type="number" data-r="checks.maxDuration" value="${esc(r.checks?.maxDuration ?? '')}"></label>
          <label class="f">Check: body contains<input type="text" data-r="checks.contains" value="${esc(r.checks?.contains ?? '')}"></label>
          <label class="f">SLA: p95 below (ms)<input type="number" data-r="slaP95" value="${esc(r.slaP95 ?? '')}" title="Adds a per-endpoint threshold"></label>
          <label class="f">Think time after (s)<input type="number" step="0.1" data-r="thinkTime" value="${esc(r.thinkTime ?? '')}"></label>
        </div>
        <div>
          <div class="f" style="margin-bottom:6px"><span>Extract values from the response for later requests (use as <code>{{name}}</code>)</span></div>
          ${(r.extract || []).map((x, j) => `<div class="kv-row" data-j="${j}">
            <input type="text" data-x="name" value="${esc(x.name)}" placeholder="variable name">
            <select data-x="from">${[['json', 'JSON path'], ['header', 'Header'], ['regex', 'Regex']].map(([v, l]) => `<option value="${v}" ${x.from === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input type="text" data-x="path" value="${esc(x.path)}" placeholder="${x.from === 'header' ? 'Location' : x.from === 'regex' ? 'token=(\\w+)' : 'data.token'}" class="mono">
            <button class="btn icon sm ghost danger" data-a="xdel">✕</button></div>`).join('')}
          <button class="btn sm" data-a="xadd">+ Extract value</button>
        </div>
      </div>` : ''}
    </div>`;
  }

  function drawRequests() {
    pane.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <label class="f grow" style="max-width:520px">Base URL (override at run time with <code>-e BASE_URL=…</code>)<input type="text" id="baseUrl" value="${esc(def.baseUrl)}" placeholder="https://api.example.com" class="mono"></label>
        <span class="grow"></span>
        <button class="btn sm" data-bulk="expand">Expand all</button><button class="btn sm" data-bulk="collapse">Collapse all</button>
        <button class="btn sm" data-bulk="on">Enable all</button><button class="btn sm" data-bulk="off">Disable all</button>
      </div>
      <div id="reqs">${def.requests.map(reqCard).join('') || '<div class="card empty"><h3>No requests yet</h3><p>Import from the first tab or add one by hand.</p></div>'}</div>
      <button class="btn" id="addreq" style="margin-top:6px">+ Add request</button>`;

    pane.querySelector('#baseUrl').addEventListener('input', (e) => { def.baseUrl = e.target.value.trim(); persist(); });
    pane.querySelector('#addreq').addEventListener('click', () => {
      const last = def.requests[def.requests.length - 1];
      const r = newReq({ name: `Request ${def.requests.length + 1}`, url: '/', group: last?.group || '' });
      def.requests.push(r); open.add(r.id); persist(); draw();
    });
    pane.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.bulk;
      if (k === 'expand') open = new Set(def.requests.map((r) => r.id));
      if (k === 'collapse') open.clear();
      if (k === 'on' || k === 'off') { def.requests.forEach((r) => { r.enabled = k === 'on'; }); persist(); }
      draw();
    }));
    const box = pane.querySelector('#reqs');
    box.addEventListener('click', (e) => {
      const card = e.target.closest('[data-i]');
      if (!card) return;
      const i = +card.dataset.i;
      const r = def.requests[i];
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'enable') { r.enabled = e.target.checked; persist(); card.classList.toggle('off', !r.enabled); drawTabs(); e.stopPropagation(); return; }
      if (a === 'toggle' && !e.target.closest('button,input')) { open.has(r.id) ? open.delete(r.id) : open.add(r.id); draw(); return; }
      if (a === 'up' && i > 0) [def.requests[i - 1], def.requests[i]] = [def.requests[i], def.requests[i - 1]];
      else if (a === 'down' && i < def.requests.length - 1) [def.requests[i + 1], def.requests[i]] = [def.requests[i], def.requests[i + 1]];
      else if (a === 'dup') { const c = { ...structuredClone(r), id: newReq().id, name: r.name + ' (copy)' }; def.requests.splice(i + 1, 0, c); open.add(c.id); }
      else if (a === 'del') def.requests.splice(i, 1);
      else if (a === 'xadd') (r.extract ||= []).push({ name: '', from: 'json', path: '' });
      else if (a === 'xdel') r.extract.splice(+e.target.closest('[data-j]').dataset.j, 1);
      else return;
      persist(); draw();
    });
    const onEdit = (e) => {
      const card = e.target.closest('[data-i]');
      if (!card) return;
      const r = def.requests[+card.dataset.i];
      const k = e.target.dataset.r;
      if (k) {
        let v = e.target.value;
        if (k === 'headers') v = parseHeaders(v);
        setPath(r, k, v);
        if (k === 'bodyType' || k === 'method') { persist(); draw(); return; }
        if (k === 'name' || k === 'url') {
          const u = card.querySelector('.u');
          u.innerHTML = `<b style="font-family:system-ui">${esc(r.name || '(unnamed)')}</b> <span class="muted">${esc(r.url)}</span>`;
        }
      }
      const x = e.target.dataset.x;
      if (x) {
        r.extract[+e.target.closest('[data-j]').dataset.j][x] = e.target.value;
      }
      persist();
    };
    box.addEventListener('input', onEdit);
    box.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') onEdit(e); });
  }

  function drawBrowser() {
    def.browser ||= { vus: 2, duration: '1m', lcp: 2500, steps: [{ action: 'goto', value: '/', selector: '' }] };
    const b = def.browser;
    pane.innerHTML = `<div class="card">
      <div class="eyebrow">SIMULATE REAL USERS</div><h3 class="builder-heading">Browser journey</h3>
      <p class="muted small">Build the steps each user will follow in an isolated Chromium session. Start with 2–5 users; Chrome or Chromium must be installed on the LoadDeck server.</p>
      <label class="f">Base URL<input type="text" id="browserbase" value="${esc(def.baseUrl)}" placeholder="https://staging.example.com" class="mono"></label>
      <div class="fields">
        <label class="f">Concurrent browser users<input type="number" min="1" max="100" data-browser="vus" value="${esc(b.vus)}"></label>
        <label class="f">Browser duration<input type="text" data-browser="duration" value="${esc(b.duration)}"></label>
        <label class="f">p75 LCP below (ms)<input type="number" min="1" data-browser="lcp" value="${esc(b.lcp)}"></label>
      </div>
      <details class="builder-help"><summary>Credentials, timing &amp; browser setup</summary><p class="muted small">Browser duration is independent of the API load profile. Align them to observe frontend behaviour throughout the test. Navigation paths use the Base URL above (shared with Requests). API auth, headers and CSV data apply to API requests; use Fill with <code>{{USERNAME}}</code> or <code>{{PASSWORD}}</code> to read browser credentials from run environment variables.</p></details>
      <div id="browsersteps">${b.steps.map((step, i) => `<div class="row" data-step="${i}" style="margin-bottom:8px;align-items:center">
        <span>${i + 1}.</span>
        <select aria-label="Action for step ${i + 1}" data-step-field="action" style="max-width:170px">${[['goto', 'Navigate'], ['fill', 'Fill input'], ['click', 'Click'], ['wait', 'Wait for visible'], ['assertText', 'Check text']].map(([v,l]) => `<option value="${v}" ${step.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="grow mono" data-step-field="selector" aria-label="CSS selector for step ${i + 1}" ${step.action === 'goto' ? 'disabled' : ''} placeholder="${step.action === 'goto' ? 'No selector needed' : 'CSS selector, e.g. #login'}" value="${esc(step.selector)}">
        <input class="grow mono" data-step-field="value" aria-label="Value for step ${i + 1}" ${['click', 'wait'].includes(step.action) ? 'disabled' : ''} placeholder="${step.action === 'goto' ? 'Page path, e.g. /login' : step.action === 'fill' ? 'Input value or {{ENV_VAR}}' : step.action === 'assertText' ? 'Expected text' : 'No value needed'}" value="${esc(step.value)}">
        <button class="btn sm" data-step-up="${i}" aria-label="Move step up">↑</button>
        <button class="btn sm danger" data-step-delete="${i}" aria-label="Delete step">✕</button>
      </div>`).join('')}</div>
      <button class="btn sm" id="browseradd">+ Add step</button>
      <p class="muted small">Use waits after clicks to confirm the destination is ready. Checks verify navigation status and expected text; failed checks affect the test verdict.</p>
    </div>`;
    pane.addEventListener('input', e => {
      if (e.target.id === 'browserbase') def.baseUrl = e.target.value.trim();
      if (e.target.dataset.browser) b[e.target.dataset.browser] = e.target.value;
      const row = e.target.closest('[data-step]');
      if (row && e.target.dataset.stepField) b.steps[+row.dataset.step][e.target.dataset.stepField] = e.target.value;
      persist(); drawTabs();
    });
    pane.addEventListener('change', e => {
      const row = e.target.closest('[data-step]');
      if (row && e.target.dataset.stepField) { b.steps[+row.dataset.step][e.target.dataset.stepField] = e.target.value; persist(); if (e.target.dataset.stepField === 'action') draw(); }
    });
    pane.addEventListener('click', e => {
      if (e.target.id === 'browseradd') b.steps.push({ action: 'click', selector: '', value: '' });
      else if (e.target.hasAttribute('data-step-delete')) b.steps.splice(+e.target.dataset.stepDelete, 1);
      else if (e.target.hasAttribute('data-step-up')) { const i = +e.target.dataset.stepUp; if (i > 0) [b.steps[i-1], b.steps[i]] = [b.steps[i], b.steps[i-1]]; }
      else return;
      persist(); draw();
    });
  }

  // ---------- 3. Profile ----------
  function drawProfile() {
    const profiles = app.info?.profiles || {};
    const p = def.profile;
    const fields = PROFILE_FIELDS[p.type] || [];
    const t = def.thresholds || {};
    pane.innerHTML = `
      <div class="profiles" id="profiles">${Object.entries(profiles).map(([k, v]) => `<button class="profile ${k === p.type ? 'on' : ''}" data-p="${k}"><b>${esc(v.label)}</b><span>${esc(v.hint)}</span></button>`).join('')}</div>
      <div class="grid2" style="margin-top:12px">
        <div class="card">
          <h3>${esc(profiles[p.type]?.label || p.type)} settings</h3>
          ${fields.length ? `<div class="fields">${fields.map(([k, l]) => `<label class="f">${esc(l)}<input type="text" data-b="profile.${k}" value="${esc(p[k] ?? '')}" placeholder="${esc(profiles[p.type]?.defaults?.[k] ?? '')}"></label>`).join('')}</div>` : ''}
          ${p.type === 'custom' ? `<label class="f">Stages — one per line, <code>duration:target VUs</code><textarea id="stages" rows="6" class="mono">${esc((p.stages || profiles.custom?.defaults?.stages || []).map((s) => `${s.duration}:${s.target}`).join('\n'))}</textarea></label>` : ''}
          <p class="muted small">Durations like <code>30s</code>, <code>5m</code>, <code>1h30m</code>. ${['breakpoint', 'constant-rate'].includes(p.type) ? 'Arrival-rate executors start iterations at a fixed pace (open model): if the system slows down, k6 adds VUs up to the max.' : 'VU-based executors loop the flow as fast as each VU can (closed model) — think time controls the pace.'}</p>
          <div style="position:relative;height:170px;margin-top:6px"><canvas id="pchart"></canvas></div>
          <p class="muted small" id="pnote" style="margin:4px 0 0"></p>
        </div>
        <div class="card">
          <h3>SLAs / thresholds <span class="muted small" style="font-weight:400">— decide pass or fail</span></h3>
          <div class="fields">
            <label class="f">p95 response below (ms)<input type="number" data-b="thresholds.p95" value="${esc(t.p95 ?? '')}"></label>
            <label class="f">p99 response below (ms)<input type="number" data-b="thresholds.p99" value="${esc(t.p99 ?? '')}"></label>
            <label class="f">Error rate at most (%)<input type="number" step="0.1" data-b="thresholds.errorRate" value="${esc(t.errorRate ?? '')}"></label>
            <label class="f">Checks passing at least (%)<input type="number" step="0.1" data-b="thresholds.checkRate" value="${esc(t.checkRate ?? '')}"></label>
          </div>
          <label class="check" style="margin-top:10px"><input type="checkbox" data-bc="thresholds.abortOnFail" ${t.abortOnFail ? 'checked' : ''}> Abort the test as soon as a threshold fails ${p.type === 'breakpoint' ? '(always on for breakpoint)' : ''}</label>
          <p class="muted small">Set per-endpoint SLAs in the Requests step.</p>
          <div class="sep"></div>
          <h3>Think time between iterations</h3>
          <div class="fields">
            <label class="f">Min seconds<input type="number" step="0.1" data-b="thinkTime.min" value="${esc(def.thinkTime?.min ?? '')}"></label>
            <label class="f">Max seconds<input type="number" step="0.1" data-b="thinkTime.max" value="${esc(def.thinkTime?.max ?? '')}"></label>
          </div>
          <p class="muted small">A random pause at the end of every iteration to mimic real users. Leave empty for none.</p>
        </div>
      </div>`;

    const drawShape = () => {
      const { pts, unit, approx } = profileShape(def.profile);
      const total = pts[pts.length - 1][0];
      // Resample into evenly spaced points for a time axis.
      const N = 60, labels = [], vals = [];
      for (let i = 0; i <= N; i++) {
        const x = (total * i) / N;
        let y = pts[pts.length - 1][1];
        for (let j = 1; j < pts.length; j++) {
          if (x <= pts[j][0]) { const [x0, y0] = pts[j - 1], [x1, y1] = pts[j]; y = x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); break; }
        }
        labels.push(fmt.dur(x)); vals.push(Math.round(y * 10) / 10);
      }
      profileChart?.destroy();
      profileChart = lineChart(pane.querySelector('#pchart'), labels, [{ label: unit, data: vals, color: seriesColors(pane).s1 }], { yFormat: (v) => fmt.num(v) });
      profileChart.data.datasets[0].tension = 0;
      profileChart.update('none');
      pane.querySelector('#pnote').textContent = `${approx ? 'Approximate — depends on iteration speed. ' : ''}Planned duration ≈ ${fmt.dur(total)} · peak ${fmt.num(Math.max(...pts.map((x) => x[1])))} ${unit}`;
    };
    if (window.Chart) drawShape();

    pane.querySelector('#profiles').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      def.profile = { type: b.dataset.p, ...(profiles[b.dataset.p]?.defaults || {}) };
      if (b.dataset.p === 'breakpoint') def.thresholds.abortOnFail = true;
      persist(); draw();
    });
    pane.addEventListener('input', (e) => {
      const k = e.target.dataset.b;
      if (k) { setPath(def, k, e.target.value); persist(); if (k.startsWith('profile.')) drawShape(); }
      if (e.target.id === 'stages') {
        def.profile.stages = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [d, tg] = l.split(':'); return { duration: d.trim(), target: +(tg || 0) }; });
        persist(); drawShape();
      }
    });
    pane.addEventListener('change', (e) => { const k = e.target.dataset.bc; if (k) { setPath(def, k, e.target.checked); persist(); } });
  }

  // ---------- 4. Data & auth ----------
  function drawData() {
    const a = def.auth || { type: 'none' };
    pane.innerHTML = `
      <div class="grid2">
        <div class="card">
          <h3>Authentication</h3>
          <div class="fields">
            <label class="f">Type<select id="atype">${[['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key header']].map(([v, l]) => `<option value="${v}" ${a.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            ${a.type === 'bearer' ? `<label class="f" style="grid-column:span 2">Token (or <code>{{token}}</code> variable)<input type="text" data-b="auth.token" value="${esc(a.token || '')}" class="mono"></label>` : ''}
            ${a.type === 'basic' ? `<label class="f">Username<input type="text" data-b="auth.username" value="${esc(a.username || '')}"></label><label class="f">Password<input type="text" data-b="auth.password" value="${esc(a.password || '')}"></label>` : ''}
            ${a.type === 'apikey' ? `<label class="f">Header name<input type="text" data-b="auth.headerName" value="${esc(a.headerName || 'X-API-Key')}"></label><label class="f">Value<input type="text" data-b="auth.value" value="${esc(a.value || '')}" class="mono"></label>` : ''}
          </div>
          <p class="muted small">Tip: keep secrets out of scripts — use a variable like <code>{{token}}</code> here and pass <code>TOKEN=…</code> as an environment variable when you run.</p>
          <div class="sep"></div>
          <h3>Default headers <span class="muted small" style="font-weight:400">sent with every request</span></h3>
          <textarea id="dheaders" rows="4" class="mono" placeholder="Accept: application/json&#10;User-Agent: LoadDeck">${esc(headersText(def.defaultHeaders))}</textarea>
          <label class="check" style="margin-top:10px"><input type="checkbox" data-bc="options.insecure" ${def.options?.insecure ? 'checked' : ''}> Skip TLS certificate verification (self-signed staging certs)</label>
        </div>
        <div class="card">
          <h3>Variables</h3>
          <p class="muted small" style="margin-top:0">One <code>name=default</code> per line. Use as <code>{{name}}</code> in URLs, headers and bodies; override at run time with <code>-e NAME=value</code>. Built-ins: <code>{{$uuid}}</code> <code>{{$timestamp}}</code> <code>{{$randomInt}}</code> <code>{{$vu}}</code> <code>{{$iter}}</code>.</p>
          <textarea id="vars" rows="5" class="mono" placeholder="userId=42&#10;token=">${esc(varsText(def.variables))}</textarea>
          <div class="sep"></div>
          <h3>Test data (CSV)</h3>
          <p class="muted small" style="margin-top:0">First row = column names. Each iteration gets one row; columns are usable as <code>{{column}}</code>. Embedded in the script and shared across VUs.</p>
          <textarea id="csv" rows="6" class="mono" placeholder="username,password&#10;alice,secret1&#10;bob,secret2">${esc(def.data?.csv || '')}</textarea>
          <div class="row" style="margin-top:8px">
            <label class="btn sm">Load CSV file<input type="file" id="csvfile" accept=".csv,text/csv" hidden></label>
            <label class="f" style="display:flex;align-items:center;gap:6px">Row selection
              <select data-b="data.mode" style="width:auto;margin-top:0">${[['sequential', 'Sequential (each iteration next row)'], ['random', 'Random'], ['perVu', 'One row per VU']].map(([v, l]) => `<option value="${v}" ${def.data?.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <span class="muted small" id="csvinfo"></span>
          </div>
        </div>
      </div>`;
    const csvInfo = () => {
      const lines = (def.data?.csv || '').split('\n').filter((l) => l.trim());
      pane.querySelector('#csvinfo').textContent = lines.length > 1 ? `${lines.length - 1} rows · columns: ${lines[0]}` : '';
    };
    csvInfo();
    pane.querySelector('#atype').addEventListener('change', (e) => { def.auth = { type: e.target.value }; persist(); draw(); });
    pane.addEventListener('input', (e) => {
      const k = e.target.dataset.b;
      if (k) setPath(def, k, e.target.value);
      if (e.target.id === 'dheaders') def.defaultHeaders = parseHeaders(e.target.value);
      if (e.target.id === 'vars') def.variables = parseVars(e.target.value);
      if (e.target.id === 'csv') { def.data = { ...def.data, csv: e.target.value }; csvInfo(); }
      persist();
    });
    pane.addEventListener('change', (e) => {
      const k = e.target.dataset.bc;
      if (k) { setPath(def, k, e.target.checked); persist(); }
      if (e.target.dataset.b) { setPath(def, e.target.dataset.b, e.target.value); persist(); }
    });
    pane.querySelector('#csvfile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await readFile(f);
      def.data = { ...def.data, csv: text };
      pane.querySelector('#csv').value = text;
      csvInfo(); persist();
    });
  }

  // ---------- 5. Preview ----------
  async function generate() {
    def.name = el.querySelector('#gname').value.trim() || 'Load test';
    const { code } = await api('/api/generate/build', { method: 'POST', body: { def } });
    previewCode = code;
    return code;
  }
  async function drawPreview() {
    pane.innerHTML = `<div class="row" style="margin-bottom:8px"><span class="muted small grow">Generated from your settings. Save it to edit freely in the code editor.</span>
      <button class="btn sm" id="copy">Copy</button><button class="btn sm" id="val">Validate with k6</button></div>
      <div class="editor-wrap"><textarea id="pcode"></textarea></div><div id="pval" class="validate-out small" style="margin-top:8px"></div>`;
    const code = await generate().catch((e) => { toast(e.message, true); return ''; });
    previewCm = window.CodeMirror.fromTextArea(pane.querySelector('#pcode'), { mode: 'javascript', lineNumbers: true, readOnly: true });
    previewCm.setValue(code);
    previewCm.getWrapperElement().classList.add('short');
    previewCm.setSize(null, 'calc(100vh - 300px)');
    pane.querySelector('#copy').addEventListener('click', () => { navigator.clipboard?.writeText(code); toast('Copied to clipboard'); });
    pane.querySelector('#val').addEventListener('click', async () => {
      const out = pane.querySelector('#pval');
      out.textContent = 'Checking…'; out.className = 'validate-out small muted';
      const r = await api('/api/validate', { method: 'POST', body: { code } });
      out.className = `validate-out small ${r.ok ? 'ok' : 'err'}`;
      out.textContent = r.ok ? '✓ k6 accepted the script.' : r.error;
    });
  }

  async function save(andRun) {
    if (def.engine !== 'browser' && !def.requests.some((r) => r.enabled !== false && r.url)) return toast('Add at least one enabled request first', true);
    try {
      const code = await generate();
      const body = { name: def.name, code, source: def.source || 'builder', generator: def, description: el.querySelector('#gsum').textContent };
      const s = scriptId ? await api(`/api/scripts/${scriptId}`, { method: 'PUT', body }) : await api('/api/scripts', { method: 'POST', body });
      dirty = false;
      if (!scriptId) store.set('gen-draft', null);
      toast(scriptId ? 'Script updated' : 'Script saved');
      setLeaveGuard(null);
      if (andRun) openRunDialog(s);
      else navigate(`#/scripts/${s.id}`);
    } catch (e) { toast(e.message, true); }
  }

  el.querySelector('#engine').addEventListener('change', e => { def.engine = e.target.value; persist(); tab = def.engine !== 'http' ? 'browser' : def.requests.length ? 'requests' : 'source'; draw(); });
  el.querySelector('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; draw(); } });
  el.querySelector('#gname').addEventListener('input', (e) => { def.name = e.target.value; persist(); });
  el.querySelector('#preview').addEventListener('click', () => { tab = 'preview'; draw(); });
  el.querySelector('#save').addEventListener('click', () => save(false));
  el.querySelector('#saverun').addEventListener('click', () => save(true));
  el.querySelector('#reset').addEventListener('click', () => {
    if (!window.confirm(scriptId ? 'Discard builder changes?' : 'Clear the current draft?')) return;
    def = scriptId && script.generator ? structuredClone(script.generator) : defaultDef();
    if (!scriptId) store.set('gen-draft', null);
    dirty = false; warnings = []; tab = 'source';
    el.querySelector('#gname').value = def.name;
    draw();
  });
  const onTheme = () => { if (tab === 'profile') draw(); };
  window.addEventListener('themechange', onTheme);
  draw();
  return () => { aiAbort?.abort(); profileChart?.destroy(); window.removeEventListener('themechange', onTheme); setLeaveGuard(null); };
}
