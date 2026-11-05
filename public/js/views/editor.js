import { api, esc, toast, confirmDialog, modal } from '../ui.js';
import { streamAi, usageText, providerPicker, rememberProvider } from '../ai.js';
import { navigate, setLeaveGuard, app } from '../app.js';
import { openRunDialog } from './run-dialog.js';

const TEMPLATE = `import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://quickpizza.grafana.com';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(\`\${BASE_URL}/\`, { tags: { name: 'Home' } });
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
`;

const SNIPPETS = {
  'HTTP GET + check': `const res = http.get(\`\${BASE_URL}/path\`, { tags: { name: 'Get item' } });
check(res, { 'status is 200': (r) => r.status === 200 });`,
  'HTTP POST JSON': `const res = http.post(\`\${BASE_URL}/api/items\`, JSON.stringify({ name: 'test' }), {
  headers: { 'Content-Type': 'application/json' },
  tags: { name: 'Create item' },
});
check(res, { 'created': (r) => r.status === 201 });`,
  'Group': `group('Checkout', () => {
  // requests…
});`,
  'Extract JSON value': `const token = res.json('access_token');`,
  'Random think time': `sleep(1 + Math.random() * 2);`,
  'Setup (login once)': `export function setup() {
  const res = http.post(\`\${BASE_URL}/login\`, JSON.stringify({ user: 'u', pass: 'p' }), { headers: { 'Content-Type': 'application/json' } });
  return { token: res.json('token') };
}
// then: export default function (data) { … data.token … }`,
  'Custom trend metric': `import { Trend } from 'k6/metrics';
const checkoutTime = new Trend('checkout_duration', true);
// checkoutTime.add(res.timings.duration);`,
  'Constant arrival-rate scenario': `export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: 50, timeUnit: '1s', duration: '5m',
      preAllocatedVUs: 20, maxVUs: 200,
    },
  },
};`,
  'Per-endpoint threshold': `// in options.thresholds:
'http_req_duration{name:Login}': ['p(95)<300'],`,
  'Batch parallel requests': `const responses = http.batch([
  ['GET', \`\${BASE_URL}/a\`, null, { tags: { name: 'A' } }],
  ['GET', \`\${BASE_URL}/b\`, null, { tags: { name: 'B' } }],
]);`,
  'Test data from CSV': `import { SharedArray } from 'k6/data';
// Paste CSV in the Generator's "Data" tab to embed it, or reference a file next to the script.
const users = new SharedArray('users', () => [{ username: 'alice' }, { username: 'bob' }]);
// const user = users[__VU % users.length];`,
};

export default async function editor(el, { params }) {
  const id = params[0];
  let script = id ? await api(`/api/scripts/${id}`) : { name: 'New script', description: '', code: TEMPLATE };
  let dirty = !id;

  el.innerHTML = `
    <div class="page-head">
      <div class="grow" style="min-width:260px">
        <input type="text" id="sname" value="${esc(script.name)}" style="font-size:18px;font-weight:650;border-color:transparent;background:transparent;padding-left:4px" aria-label="Script name">
        <input type="text" id="sdesc" value="${esc(script.description || '')}" placeholder="Add a description…" class="small" style="border-color:transparent;background:transparent;padding:2px 4px;color:var(--muted)">
      </div>
      <div class="row">
        <span class="muted small" id="dirty"></span>
        ${script.generator ? `<a class="btn" href="#/generate/${script.id}" title="Re-open the visual builder (overwrites manual edits when you generate)">Open in builder</a>` : ''}
        <select id="snip" style="width:auto"><option value="">Insert snippet…</option>${Object.keys(SNIPPETS).map((k) => `<option>${esc(k)}</option>`).join('')}</select>
        <button class="btn" id="askai" title="Ask an AI model to change this script">✦ Ask AI</button>
        <button class="btn" id="validate">Validate</button>
        <button class="btn" id="save">Save <span class="muted small">⌘S</span></button>
        <button class="btn primary" id="run">▶ Run</button>
        ${id ? '<button class="btn ghost danger" id="del" title="Delete script">✕</button>' : ''}
      </div>
    </div>
    <div class="split">
      <div class="editor-wrap"><textarea id="code"></textarea></div>
      <div>
        <div class="card"><h3>Validation</h3><div id="vout" class="validate-out muted">Press <b>Validate</b> to check syntax and resolved options with <code>k6 inspect</code>.</div></div>
        <div class="card"><h3>Tips</h3><ul class="small muted" style="margin:0;padding-left:16px;line-height:1.7">
          <li>Tag requests with <code>tags: { name: '…' }</code> so reports group them nicely.</li>
          <li>Use <code>__ENV.X</code> for values you set per run (Run → Environment).</li>
          <li>Thresholds turn a run into a pass/fail verdict.</li>
          <li>⌘/Ctrl+F search · ⌘/ comment line.</li></ul></div>
      </div>
    </div>`;

  const cm = window.CodeMirror.fromTextArea(el.querySelector('#code'), {
    mode: 'javascript', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, indentUnit: 2, tabSize: 2,
    extraKeys: {
      'Cmd-S': () => save(), 'Ctrl-S': () => save(), 'Cmd-/': 'toggleComment', 'Ctrl-/': 'toggleComment',
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
    },
  });
  cm.setValue(script.code);
  cm.clearHistory();
  const setDirty = (v) => { dirty = v; el.querySelector('#dirty').textContent = v ? '● unsaved' : ''; };
  setDirty(dirty);
  cm.on('change', () => setDirty(true));
  el.querySelector('#sname').addEventListener('input', () => setDirty(true));
  el.querySelector('#sdesc').addEventListener('input', () => setDirty(true));
  setLeaveGuard((silent) => !dirty || (!silent && window.confirm('You have unsaved changes. Leave anyway?')));

  async function save() {
    const body = { name: el.querySelector('#sname').value.trim() || 'Untitled script', description: el.querySelector('#sdesc').value.trim(), code: cm.getValue() };
    try {
      script = script.id ? await api(`/api/scripts/${script.id}`, { method: 'PUT', body }) : await api('/api/scripts', { method: 'POST', body: { ...body, source: 'manual' } });
      setDirty(false);
      toast('Saved');
      if (!id) { setLeaveGuard(null); navigate(`#/scripts/${script.id}`); }
      return script;
    } catch (e) { toast(e.message, true); return null; }
  }

  el.querySelector('#save').addEventListener('click', save);
  el.querySelector('#validate').addEventListener('click', async () => {
    const out = el.querySelector('#vout');
    out.className = 'validate-out muted';
    out.textContent = 'Checking…';
    const r = await api('/api/validate', { method: 'POST', body: { code: cm.getValue() } });
    if (r.ok) {
      out.className = 'validate-out ok';
      out.innerHTML = `✓ Script is valid.<pre style="color:var(--text);margin:8px 0 0;white-space:pre-wrap">${esc(JSON.stringify(r.options, null, 2))}</pre>`;
    } else {
      out.className = 'validate-out err';
      out.textContent = r.error;
      const m = /script\.js:\s*Line (\d+):(\d+)/i.exec(r.error) || /:(\d+):(\d+)/.exec(r.error);
      if (m) { cm.setCursor({ line: +m[1] - 1, ch: +m[2] - 1 }); cm.focus(); }
    }
  });
  el.querySelector('#askai').addEventListener('click', async () => {
    if (!app.info?.ai?.configured) { toast('Set up an AI provider in Settings → AI providers first', true); return; }
    const box = await modal('Ask AI to change this script', `
      <label class="f">What should change?<textarea id="aiq" rows="4" style="font-family:inherit;font-size:14px" placeholder="e.g. Add a checkout step after the cart, ramp to 300 VUs instead of 60, and add a threshold that search p95 stays under 200ms"></textarea></label>
      <label class="f" style="margin-top:10px">Provider ${providerPicker(app.info, 'aiprov')}</label>
      <p class="muted small">The AI edits the whole script, k6 checks it, and the result replaces the editor content. You can undo with ⌘Z.</p>`, { okText: '✦ Apply' });
    if (!box) return;
    const instruction = box.querySelector('#aiq').value.trim();
    const provider = box.querySelector('#aiprov')?.value;
    if (provider) rememberProvider(provider);
    if (!instruction) return;
    const ctrl = new AbortController();
    const prog = document.createElement('div');
    prog.className = 'modal-bg';
    prog.innerHTML = `<div class="modal"><h2>✦ AI is editing the script</h2><p class="muted" id="aist">Thinking…</p>
      <pre class="small muted" id="aith" style="white-space:pre-wrap;max-height:240px;overflow:auto"></pre><div class="foot"><button class="btn" id="aicancel">Cancel</button></div></div>`;
    document.body.appendChild(prog);
    prog.querySelector('#aicancel').addEventListener('click', () => ctrl.abort());
    const st = prog.querySelector('#aist');
    let thinking = '';
    await streamAi({ prompt: instruction, currentCode: cm.getValue(), provider }, {
      provider: (d) => { prog.querySelector('h2').textContent = `✦ ${d.label} (${d.model}) is editing the script`; },
      status: (d) => { st.textContent = d.phase === 'validating' ? 'Checking the result with k6…' : d.phase === 'repairing' ? `k6 rejected it — fixing (attempt ${d.attempt + 1})…` : d.attempt > 1 ? `Fixing (attempt ${d.attempt})…` : 'Thinking…'; },
      thinking: (d) => { thinking += d.text; prog.querySelector('#aith').textContent = thinking.slice(-3000); },
      text: () => { st.textContent = 'Writing the updated script…'; },
      done: (d) => {
        cm.replaceRange(d.code, { line: 0, ch: 0 }, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
        const out = el.querySelector('#vout');
        out.className = `validate-out ${d.valid ? 'ok' : 'err'}`;
        out.textContent = (d.valid ? `✓ ${d.provider} updated the script and k6 accepted it.` : `The AI's version still fails validation:\n${d.error}`) + (d.notes ? `\n\nAssumptions to check:\n${d.notes}` : '') + `\n\n(${d.provider} · ${d.model}${d.usage?.output ? ` · ${usageText(d.usage)}` : ''} · ⌘Z to undo)`;
        toast(d.valid ? 'Script updated by AI — review the changes' : 'Updated, but k6 still reports an error', !d.valid);
      },
      error: (d) => toast(d.message, true),
    }, ctrl.signal);
    prog.remove();
  });
  el.querySelector('#snip').addEventListener('change', (e) => {
    const s = SNIPPETS[e.target.value];
    if (s) { cm.replaceSelection(s + '\n'); cm.focus(); }
    e.target.value = '';
  });
  el.querySelector('#run').addEventListener('click', async () => {
    if (dirty) { const s = await save(); if (!s) return; }
    setLeaveGuard(null);
    openRunDialog(script);
  });
  el.querySelector('#del')?.addEventListener('click', async () => {
    if (!await confirmDialog('Delete script?', `"${script.name}" will be deleted. Past runs are kept.`)) return;
    await api(`/api/scripts/${script.id}`, { method: 'DELETE' });
    setLeaveGuard(null);
    navigate('#/scripts');
  });
  setTimeout(() => cm.refresh(), 0);
  return () => setLeaveGuard(null);
}
