import { api, esc, fmt, badge } from '../ui.js';
import { navigate } from '../app.js';
import { lineChart, seriesColors, chartCard, epName } from '../report-view.js';

export default async function compare(el, { query }) {
  const runs = (await api('/api/runs')).filter((r) => r.status !== 'running' && r.headline);
  const a = query.get('a'), b = query.get('b');
  const opts = (sel) => runs.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${r.baseline ? '★ ' : ''}${esc(r.name)} — ${fmt.date(r.createdAt)}</option>`).join('');

  el.innerHTML = `
    <div class="page-head"><div><h1>Compare runs</h1><p>Baseline vs candidate — spot regressions before they ship.</p></div></div>
    <div class="card"><div class="grid2">
      <label class="f">A · Baseline<select id="ca"><option value="">Choose a run…</option>${opts(a)}</select></label>
      <label class="f">B · Candidate<select id="cb"><option value="">Choose a run…</option>${opts(b)}</select></label>
    </div></div>
    <div id="cres"></div>`;
  const go = () => { const x = el.querySelector('#ca').value, y = el.querySelector('#cb').value; if (x && y) navigate(`#/compare?a=${x}&b=${y}`); };
  el.querySelector('#ca').addEventListener('change', go);
  el.querySelector('#cb').addEventListener('change', go);
  if (!runs.length) { el.querySelector('#cres').innerHTML = '<div class="empty"><h3>No finished runs yet</h3></div>'; return; }
  if (!a || !b) { el.querySelector('#cres').innerHTML = '<p class="muted" style="margin-top:14px">Pick two runs. Tip: select two rows on the Runs page and press “Compare selected”.</p>'; return; }

  const [A, B] = await Promise.all([api(`/api/runs/${a}`), api(`/api/runs/${b}`)]);
  const ra = A.report || {}, rb = B.report || {};
  // [label, getter, formatter, higherIsBetter]
  const rows = [
    ['Requests', (r) => r.totals?.reqs, (v) => fmt.num(v), null],
    ['Avg throughput (req/s)', (r) => r.totals?.rps, (v) => fmt.num(v, 1), true],
    ['Peak throughput (req/s)', (r) => r.totals?.peakRps, (v) => fmt.num(v), true],
    ['Average response', (r) => r.latency?.avg, fmt.ms, false],
    ['Median response', (r) => r.latency?.med, fmt.ms, false],
    ['p90 response', (r) => r.latency?.p90, fmt.ms, false],
    ['p95 response', (r) => r.latency?.p95, fmt.ms, false],
    ['p99 response', (r) => r.latency?.p99, fmt.ms, false],
    ['Max response', (r) => r.latency?.max, fmt.ms, false],
    ['Error rate', (r) => r.totals?.errRate, (v) => fmt.pct(v), false],
    ['Check pass rate', (r) => r.totals?.checkRate, (v) => (v == null ? '—' : fmt.pct(v)), true],
    ['Peak VUs', (r) => r.totals?.maxVus, (v) => fmt.num(v), null],
    ['Duration', (r) => r.durationSec, fmt.dur, null],
  ];
  const delta = (va, vb, better) => {
    if (va == null || vb == null) return '<span class="muted">—</span>';
    if (va === 0 && vb === 0) return '<span class="muted">0%</span>';
    const pct = va === 0 ? Infinity : ((vb - va) / Math.abs(va)) * 100;
    const txt = pct === Infinity ? 'new' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
    if (better === null || Math.abs(pct) < 3) return `<span class="muted">${txt}</span>`;
    const worse = better ? vb < va : vb > va;
    return `<span class="${worse ? 'delta-up' : 'delta-down'}">${vb > va ? '▲' : '▼'} ${txt} ${worse ? 'worse' : 'better'}</span>`;
  };

  const p95a = ra.latency?.p95, p95b = rb.latency?.p95;
  const change = p95a ? ((p95b - p95a) / p95a) * 100 : 0;
  const errA = ra.totals?.errRate || 0, errB = rb.totals?.errRate || 0;
  const verdict = Math.abs(change) < 5 && Math.abs(errB - errA) < 0.005
    ? ['good', 'No significant change between the runs (p95 within ±5%, error rate within 0.5 pts).']
    : change > 10 || errB - errA > 0.01
      ? ['critical', `Regression: p95 ${change > 0 ? 'increased' : 'changed'} by ${change.toFixed(1)}% (${fmt.ms(p95a)} → ${fmt.ms(p95b)}), error rate ${fmt.pct(errA)} → ${fmt.pct(errB)}.`]
      : change < -5 ? ['good', `Improvement: p95 dropped by ${Math.abs(change).toFixed(1)}% (${fmt.ms(p95a)} → ${fmt.ms(p95b)}).`]
        : ['warning', `Minor change: p95 ${change > 0 ? '+' : ''}${change.toFixed(1)}%, error rate ${fmt.pct(errA)} → ${fmt.pct(errB)}.`];

  // Endpoint join on method + name.
  const key = (e) => `${e.method} ${e.name}`;
  const ma = new Map((ra.endpoints || []).map((e) => [key(e), e]));
  const mb = new Map((rb.endpoints || []).map((e) => [key(e), e]));
  const keys = [...new Set([...ma.keys(), ...mb.keys()])];

  el.querySelector('#cres').innerHTML = `
    <div class="rp">
      <div class="findings" style="margin-top:14px"><div class="finding ${verdict[0]}"><div class="fi">${verdict[0] === 'good' ? '✓' : '!'}</div><div>${esc(verdict[1])}</div></div></div>
      <h2>Headline metrics</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Metric</th>
        <th class="num">A · <a href="#/runs/${a}">${esc(A.meta.name.slice(0, 40))}</a> ${badge(A.meta.status)}</th>
        <th class="num">B · <a href="#/runs/${b}">${esc(B.meta.name.slice(0, 40))}</a> ${badge(B.meta.status)}</th><th class="num">Change</th></tr></thead><tbody>
        ${rows.map(([l, g, f, better]) => `<tr><td>${l}</td><td class="num">${f(g(ra))}</td><td class="num">${f(g(rb))}</td><td class="num">${delta(g(ra), g(rb), better)}</td></tr>`).join('')}
      </tbody></table></div>
      <h2>Over time <small>aligned by elapsed time</small></h2>
      <div class="charts">${chartCard('c-p95', 'p95 response time')}${chartCard('c-rps', 'Throughput', 'requests per second')}${chartCard('c-vus', 'Virtual users')}${chartCard('c-err', 'Errors', 'failed requests per second')}</div>
      <h2>Endpoints</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Endpoint</th><th class="num">Requests A</th><th class="num">Requests B</th><th class="num">p95 A</th><th class="num">p95 B</th><th class="num">p95 change</th><th class="num">Errors A</th><th class="num">Errors B</th></tr></thead><tbody>
        ${keys.map((k) => { const x = ma.get(k), y = mb.get(k); const e = x || y; return `<tr><td class="ep" title="${esc(e.name)}"><span class="method">${esc(e.method)}</span>${esc(epName(e))}</td>
          <td class="num">${fmt.num(x?.count)}</td><td class="num">${fmt.num(y?.count)}</td><td class="num">${fmt.ms(x?.p95)}</td><td class="num">${fmt.ms(y?.p95)}</td>
          <td class="num">${delta(x?.p95, y?.p95, false)}</td><td class="num">${x ? fmt.pct(x.errRate, 1) : '—'}</td><td class="num">${y ? fmt.pct(y.errRate, 1) : '—'}</td></tr>`; }).join('')}
      </tbody></table></div>
    </div>`;

  let charts = [];
  const drawCharts = () => {
    charts.forEach((c) => c.destroy());
    const col = seriesColors(el.querySelector('.rp'));
    const sa = ra.series || [], sb = rb.series || [];
    const n = Math.max(sa.length, sb.length);
    const labels = Array.from({ length: n }, (_, i) => fmt.clock(i));
    const pick = (s, k) => Array.from({ length: n }, (_, i) => (s[i] ? s[i][k] : null));
    const mk = (id, k, f) => lineChart(el.querySelector('#' + id), labels, [
      { label: 'A · baseline', data: pick(sa, k), color: col.s1 },
      { label: 'B · candidate', data: pick(sb, k), color: col.s2 },
    ], { yFormat: f });
    charts = [mk('c-p95', 'p95', fmt.ms), mk('c-rps', 'rps', (v) => fmt.num(v, 1)), mk('c-vus', 'vus', (v) => fmt.num(v)), mk('c-err', 'errors', (v) => fmt.num(v, 1))];
  };
  if (window.Chart) drawCharts();
  window.addEventListener('themechange', drawCharts);
  return () => { charts.forEach((c) => c.destroy()); window.removeEventListener('themechange', drawCharts); };
}
