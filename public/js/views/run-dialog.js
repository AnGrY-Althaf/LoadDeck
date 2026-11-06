import { api, esc, modal, toast, parseKv, kvText, store } from '../ui.js';
import { navigate } from '../app.js';

// Run configuration dialog. `script` is {id, name} or {code, name} for ad-hoc runs.
export async function openRunDialog(script, preset = null) {
  const remembered = store.get(`run-${script.id || 'adhoc'}`, {});
  const cfg = { mode: 'script', vus: 10, duration: '30s', iterations: 100, stages: '30s:10\n1m:10\n30s:0', env: '', tags: '', ...remembered, ...(preset || {}) };

  const body = `
    <p class="muted small" style="margin-top:-6px">Script: <b>${esc(script.name)}</b></p>
    <label class="f">Run name (optional)<input type="text" id="rn" placeholder="e.g. Release 2.4 — checkout stress"></label>
    <div style="margin-top:12px" class="f"><span>Load</span>
      <div class="row" id="rmode">
        ${[['script', 'Use script options'], ['quick', 'VUs + duration'], ['stages', 'Ramping stages'], ['iterations', 'Fixed iterations']]
    .map(([v, l]) => `<label class="check"><input type="radio" name="rmode" value="${v}" ${cfg.mode === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
    </div>
    <div id="m-quick" class="fields" style="margin-top:8px">
      <label class="f">Virtual users<input type="number" id="rv" min="1" value="${esc(cfg.vus)}"></label>
      <label class="f">Duration<input type="text" id="rd" value="${esc(cfg.duration)}" placeholder="30s, 5m, 1h"></label>
    </div>
    <div id="m-iterations" class="fields" style="margin-top:8px">
      <label class="f">Virtual users<input type="number" id="riv" min="1" value="${esc(cfg.vus)}"></label>
      <label class="f">Total iterations<input type="number" id="ri" min="1" value="${esc(cfg.iterations)}"></label>
    </div>
    <div id="m-stages" style="margin-top:8px">
      <label class="f">Stages — one per line as <code>duration:targetVUs</code><textarea id="rs" rows="4">${esc(cfg.stages)}</textarea></label>
    </div>
    <p class="muted small" id="m-note" style="margin:6px 0 0">Overrides replace the scenarios defined in the script.</p>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="rbhead" ${cfg.browserHeadless === false ? 'checked' : ''}> Show browser windows (browser / hybrid scripts)</label>
    <p class="muted small">Browser and hybrid tests require Use script options. Browser windows open on the machine running LoadDeck.</p>
    <details style="margin-top:12px" ${cfg.env || cfg.tags ? 'open' : ''}><summary>Environment variables, tags &amp; debugging</summary>
      <div class="grid2" style="margin-top:8px">
        <label class="f">Environment (<code>-e</code>) — KEY=value per line<textarea id="re" rows="4" placeholder="BASE_URL=https://staging.example.com&#10;TOKEN=abc">${esc(cfg.env)}</textarea></label>
        <label class="f">Tags (<code>--tag</code>) — key=value per line<textarea id="rt" rows="4" placeholder="release=2.4&#10;env=staging">${esc(cfg.tags)}</textarea></label>
      </div>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="rh"> Log full HTTP requests/responses (<code>--http-debug=full</code>, use with 1 VU)</label>
    </details>
    <label class="f" style="margin-top:12px">Notes (optional)<textarea id="rnotes" rows="2" placeholder="What are you testing / what changed?"></textarea></label>`;

  const result = await modal('Run test', body, {
    okText: '▶ Start run',
    onOpen(mb) {
      const sync = () => {
        const m = mb.querySelector('input[name=rmode]:checked').value;
        for (const k of ['quick', 'stages', 'iterations']) mb.querySelector(`#m-${k}`).classList.toggle('hidden', m !== k);
        mb.querySelector('#m-note').classList.toggle('hidden', m === 'script');
      };
      mb.querySelector('#rmode').addEventListener('change', sync);
      sync();
    },
  });
  if (!result) return;
  const mb = result;
  const mode = mb.querySelector('input[name=rmode]:checked').value;
  const saved = {
    browserHeadless: !mb.querySelector('#rbhead').checked,
    mode, vus: mb.querySelector(mode === 'iterations' ? '#riv' : '#rv').value, duration: mb.querySelector('#rd').value,
    iterations: mb.querySelector('#ri').value, stages: mb.querySelector('#rs').value, env: mb.querySelector('#re').value, tags: mb.querySelector('#rt').value,
  };
  store.set(`run-${script.id || 'adhoc'}`, saved);

  const req = {
    scriptId: script.id || undefined,
    code: script.id ? undefined : script.code,
    scriptName: script.name,
    name: mb.querySelector('#rn').value.trim() || undefined,
    notes: mb.querySelector('#rnotes').value.trim(),
    env: parseKv(saved.env),
    tags: parseKv(saved.tags),
    httpDebug: mb.querySelector('#rh').checked,
    browserHeadless: saved.browserHeadless,
  };
  if (mode === 'quick') Object.assign(req, { vus: saved.vus, duration: saved.duration });
  if (mode === 'iterations') Object.assign(req, { vus: saved.vus, iterations: saved.iterations });
  if (mode === 'stages') {
    req.stages = saved.stages.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [d, t] = l.split(':'); return { duration: d.trim(), target: (t || '0').trim() }; });
  }
  try {
    const meta = await api('/api/runs', { method: 'POST', body: req });
    navigate(`#/runs/${meta.id}`);
  } catch (e) { toast(e.message, true); }
}

export { kvText };
