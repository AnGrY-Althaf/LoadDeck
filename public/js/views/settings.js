import { api, esc, toast } from '../ui.js';
import { app } from '../app.js';

export default async function settings(el) {
  const info = await api('/api/info');
  const s = info.settings;
  let ai = info.ai;
  let openId = null;

  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Stored in <code>data/settings.json</code> (readable only by your user).</p></div></div>
    <div class="card" id="aicard"></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card">
        <h3>k6</h3>
        <label class="f">k6 binary<input type="text" id="k6Path" value="${esc(s.k6Path)}" class="mono" placeholder="k6 or /opt/homebrew/bin/k6"></label>
        <p class="small ${info.k6Version ? 'muted' : ''}" style="${info.k6Version ? '' : 'color:var(--bad)'}">${info.k6Version ? `✓ ${esc(info.k6Version)}` : '✕ k6 not found at this path. Install it with brew install k6 (macOS), winget install k6 (Windows) or see grafana.com/docs/k6.'}</p>
        <label class="f">Max concurrent runs<input type="number" id="maxConcurrentRuns" min="1" max="20" value="${esc(s.maxConcurrentRuns)}"></label>
        <p class="muted small">Runs on the same machine compete for CPU and network — for accurate numbers run one heavy test at a time.</p>
      </div>
      <div class="card">
        <h3>Storage</h3>
        <label class="check"><input type="checkbox" id="keepRawData" ${s.keepRawData ? 'checked' : ''}> Keep raw k6 metric stream (<code>raw.ndjson</code>) for each run</label>
        <p class="muted small">Off by default: reports are computed while the test runs, so the raw per-request data (which can be gigabytes) is deleted afterwards. Turn on if you want to post-process it with other tools.</p>
      </div>
    </div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="save">Save k6 &amp; storage settings</button></div>`;

  const card = el.querySelector('#aicard');
  const status = (p) => (p.configured
    ? `<span class="badge passed">${p.keySource === 'env' ? 'Ready · key from environment' : p.noKey ? 'Ready · local' : 'Ready'}</span>`
    : p.keySet || p.noKey || p.keyOptional ? '<span class="badge stopped">Needs a model</span>' : '<span class="pill">Not set up</span>');

  function drawAi() {
    const configured = ai.providers.filter((p) => p.configured);
    card.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <h3 style="margin:0">AI providers <span class="muted small" style="font-weight:400">— used by “Describe with AI” and “Ask AI”</span></h3>
        <label class="f" style="display:flex;align-items:center;gap:8px">Default provider
          <select id="active" style="width:auto;margin-top:0">${ai.providers.map((p) => `<option value="${p.id}" ${p.id === ai.active ? 'selected' : ''} ${p.configured ? '' : 'disabled'}>${esc(p.label)}${p.configured ? ` · ${esc(p.model)}` : ' (not set up)'}</option>`).join('')}</select></label>
      </div>
      <p class="muted small" style="margin-top:0">Add a key for any provider you use; you can pick the provider per generation. Keys stay on this machine and are never sent to the browser. ${configured.length ? '' : '<b>No provider is set up yet.</b>'}</p>
      <div class="list" id="plist">${ai.providers.map((p) => `
        <div class="prov" data-id="${p.id}" style="border-bottom:1px solid var(--border)">
          <div class="list-row" style="border:0;cursor:pointer" data-a="toggle">
            <div class="grow"><b>${esc(p.label)}</b>${p.id === ai.active && p.configured ? ' <span class="pill">default</span>' : ''}
              <div class="muted small mono">${p.model ? esc(p.model) : 'no model chosen'}${p.kind === 'openai' && p.baseUrl ? ` · ${esc(p.baseUrl)}` : ''}${p.keySet ? ` · key ${esc(p.keyHint)}` : ''}</div></div>
            ${status(p)}
            <span class="muted">${openId === p.id ? '▴' : '▾'}</span>
          </div>
          ${openId === p.id ? form(p) : ''}
        </div>`).join('')}</div>`;
  }

  function form(p) {
    const keyField = p.noKey ? '<p class="muted small" style="margin:0">Runs locally — no API key needed. Start Ollama and pull a model first (e.g. <code>ollama pull &lt;model&gt;</code>).</p>'
      : `<label class="f">API key${p.keyOptional ? ' (optional)' : ''}${p.keyUrl ? ` · <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">get a key ↗</a>` : ''}
          <input type="password" data-f="apiKey" class="mono" autocomplete="off" placeholder="${p.keySet ? (p.keySource === 'env' ? `Using ${esc(p.envVars.join(' / '))} from the environment — paste to override` : `Saved key ${esc(p.keyHint)} — leave empty to keep it`) : 'Paste your API key'}"></label>`;
    return `<div class="req-body" style="border-top:1px solid var(--border)">
      ${keyField}
      <div class="fields" style="grid-template-columns:minmax(0,2fr) auto minmax(0,1fr)">
        <label class="f">Model<input type="text" data-f="model" class="mono" list="models-${p.id}" value="${esc(p.model)}" placeholder="Click “Load models” or type a model id"><datalist id="models-${p.id}"></datalist></label>
        <div style="display:flex;align-items:flex-end"><button class="btn" data-a="models">Load models</button></div>
        <label class="f">Max output tokens<input type="number" data-f="maxTokens" value="${esc(p.maxTokens)}" placeholder="${p.kind === 'anthropic' ? '64000' : p.id === 'openai' ? 'provider default' : '8192'}"></label>
      </div>
      ${p.kind === 'openai' ? `<label class="f">Base URL${p.customBase ? ' (your OpenAI-compatible endpoint, e.g. Azure, LM Studio, vLLM, LiteLLM)' : ''}<input type="text" data-f="baseUrl" class="mono" value="${esc(p.baseUrl)}" placeholder="${esc(p.defaultBaseUrl || 'https://my-gateway.example.com/v1')}"></label>` : ''}
      <div class="small" data-out></div>
      <div class="row">
        <button class="btn primary" data-a="save">Save</button>
        <button class="btn" data-a="saveactive">Save &amp; make default</button>
        ${p.keySet && p.keySource === 'settings' ? '<button class="btn danger" data-a="clear">Remove saved key</button>' : ''}
        ${p.kind === 'anthropic' ? '<span class="muted small">Uses adaptive thinking, high effort and Anthropic\'s server-side refusal fallback.</span>' : ''}
      </div>
    </div>`;
  }

  drawAi();
  card.addEventListener('change', async (e) => {
    if (e.target.id !== 'active') return;
    ai = await api('/api/ai/active', { method: 'PUT', body: { id: e.target.value } });
    app.info = await api('/api/info');
    toast(`Default AI provider: ${ai.activeLabel}`);
    drawAi();
  });
  card.addEventListener('click', async (e) => {
    const box = e.target.closest('.prov');
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!box || !a) return;
    const id = box.dataset.id;
    if (a === 'toggle') { openId = openId === id ? null : id; drawAi(); return; }
    const val = (f) => box.querySelector(`[data-f="${f}"]`)?.value ?? undefined;
    const out = box.querySelector('[data-out]');
    if (a === 'models') {
      const btn = e.target.closest('button');
      btn.disabled = true; out.className = 'small muted'; out.textContent = 'Contacting the provider…';
      try {
        const { models } = await api(`/api/ai/providers/${id}/models`, { method: 'POST', body: { apiKey: val('apiKey') || undefined, baseUrl: val('baseUrl') || undefined } });
        box.querySelector(`#models-${id}`).innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
        out.className = 'small'; out.style.color = 'var(--good)';
        out.textContent = `✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available. Click the Model field to pick one.`;
        const mf = box.querySelector('[data-f="model"]');
        if (!mf.value && models.length) mf.focus();
      } catch (err) { out.className = 'small'; out.style.color = 'var(--bad)'; out.textContent = err.message; }
      btn.disabled = false;
      return;
    }
    if (a === 'save' || a === 'saveactive') {
      try {
        ai = await api(`/api/ai/providers/${id}`, { method: 'PUT', body: { apiKey: val('apiKey'), model: val('model'), baseUrl: val('baseUrl'), maxTokens: val('maxTokens'), makeActive: a === 'saveactive' } });
        app.info = await api('/api/info');
        const p = ai.providers.find((x) => x.id === id);
        toast(p.configured ? `${p.label} saved${a === 'saveactive' ? ' and set as default' : ''}` : `${p.label} saved — still needs ${p.model ? 'a key' : 'a model'}`, !p.configured);
        drawAi();
      } catch (err) { toast(err.message, true); }
    }
    if (a === 'clear') {
      ai = await api(`/api/ai/providers/${id}`, { method: 'PUT', body: { clearKey: true } });
      app.info = await api('/api/info');
      toast('Saved key removed');
      drawAi();
    }
  });

  el.querySelector('#save').addEventListener('click', async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: { k6Path: el.querySelector('#k6Path').value, maxConcurrentRuns: el.querySelector('#maxConcurrentRuns').value, keepRawData: el.querySelector('#keepRawData').checked } });
      app.info = await api('/api/info');
      toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  });
}
