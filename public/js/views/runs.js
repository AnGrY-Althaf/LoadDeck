import { api, esc, fmt, badge, relTime, toast, confirmDialog } from '../ui.js';
import { navigate } from '../app.js';

export default async function runs(el, { query }) {
  let list = await api('/api/runs');
  const scripts = [...new Map(list.map((r) => [r.scriptId || r.scriptName, r.scriptName])).entries()];
  const sel = new Set();
  let fScript = query.get('script') || '', fStatus = '';

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Runs &amp; reports</h1><p>Every run keeps its report, log and the exact script used.</p></div>
      <div class="row">
        <select id="fs" style="width:auto"><option value="">All scripts</option>${scripts.map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('')}</select>
        <select id="fst" style="width:auto"><option value="">Any status</option><option value="passed">Passed</option><option value="failed">Thresholds failed</option><option value="error">Error</option><option value="stopped">Stopped</option><option value="running">Running</option></select>
        <button class="btn" id="cmp" disabled>Compare selected</button>
        <button class="btn danger" id="del" disabled>Delete selected</button>
      </div>
    </div>
    <div class="tbl-wrap"><table class="tbl" id="rt"><thead><tr><th style="width:28px"></th><th>Run</th><th>Status</th><th>Started</th><th class="num">Duration</th><th class="num">VUs</th><th class="num">Requests</th><th class="num">req/s</th><th class="num">p95</th><th class="num">Errors</th><th class="num">Thresholds</th></tr></thead><tbody></tbody></table></div>`;
  el.querySelector('#fs').value = fScript;

  const draw = () => {
    const shown = list.filter((r) => (!fScript || (r.scriptId || r.scriptName) === fScript) && (!fStatus || r.status === fStatus));
    el.querySelector('#rt tbody').innerHTML = shown.map((r) => {
      const h = r.headline || {};
      return `<tr data-id="${r.id}" style="cursor:pointer">
        <td><input type="checkbox" ${sel.has(r.id) ? 'checked' : ''} ${r.status === 'running' ? 'disabled' : ''}></td>
        <td style="max-width:360px;overflow:hidden;text-overflow:ellipsis">${r.baseline ? '<span title="Baseline">★</span> ' : ''}<b>${esc(r.name)}</b><div class="muted small">${esc(r.scriptName)}</div></td>
        <td>${badge(r.status)}</td><td class="muted">${relTime(r.createdAt)}</td>
        <td class="num">${fmt.dur(h.durationSec)}</td><td class="num">${fmt.num(h.maxVus)}</td><td class="num">${fmt.num(h.reqs)}</td>
        <td class="num">${fmt.num(h.rps, 1)}</td><td class="num">${fmt.ms(h.p95)}</td>
        <td class="num ${h.errRate >= 0.01 ? 'bad' : ''}">${fmt.pct(h.errRate)}</td>
        <td class="num ${r.thresholds?.failed ? 'bad' : ''}">${r.thresholds ? (r.thresholds.total ? `${r.thresholds.total - r.thresholds.failed}/${r.thresholds.total}` : '—') : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="11"><div class="empty"><h3>No runs${list.length ? ' match the filters' : ' yet'}</h3><p>Run a script to see its report here.</p></div></td></tr>`;
    el.querySelector('#cmp').disabled = sel.size !== 2;
    el.querySelector('#del').disabled = !sel.size;
  };
  draw();

  el.querySelector('#fs').addEventListener('change', (e) => { fScript = e.target.value; draw(); });
  el.querySelector('#fst').addEventListener('change', (e) => { fStatus = e.target.value; draw(); });
  el.querySelector('#rt tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (e.target.type === 'checkbox') { e.target.checked ? sel.add(tr.dataset.id) : sel.delete(tr.dataset.id); draw(); return; }
    navigate(`#/runs/${tr.dataset.id}`);
  });
  el.querySelector('#cmp').addEventListener('click', () => {
    const [a, b] = [...sel].map((x) => list.find((r) => r.id === x)).sort((x, y) => x.createdAt - y.createdAt);
    navigate(`#/compare?a=${a.id}&b=${b.id}`);
  });
  el.querySelector('#del').addEventListener('click', async () => {
    if (!await confirmDialog(`Delete ${sel.size} run(s)?`, 'Their reports and logs will be permanently removed.')) return;
    for (const id of sel) await api(`/api/runs/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
    sel.clear();
    list = await api('/api/runs');
    draw();
  });
}
