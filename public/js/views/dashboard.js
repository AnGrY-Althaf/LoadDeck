import { api, esc, fmt, badge, relTime } from '../ui.js';
import { lineChart, seriesColors } from '../report-view.js';
import { app } from '../app.js';

export default async function dashboard(el) {
  const [scripts, runs] = await Promise.all([api('/api/scripts'), api('/api/runs')]);
  const finished = runs.filter((r) => r.status !== 'running');
  const recent = finished.slice(0, 20);
  const passRate = recent.length ? recent.filter((r) => r.status === 'passed').length / recent.length : null;
  const active = runs.filter((r) => r.status === 'running');
  const totalReqs = finished.reduce((m, r) => m + (r.headline?.reqs || 0), 0);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Load &amp; stress testing on k6 — generate scripts, run them, read the reports.</p></div>
      <div class="row">
        <a class="btn" href="#/scripts/new">New script</a>
        <a class="btn primary" href="#/generate">✦ Generate a test</a>
      </div>
    </div>
    ${!app.info?.k6Version ? `<div class="warnbox" style="margin-bottom:14px"><b>k6 was not found.</b> Install it with <code>brew install k6</code> or set the binary path in <a href="#/settings">Settings</a>.</div>` : ''}
    <div class="tiles">
      <div class="tile"><div class="k">Scripts</div><div class="v">${scripts.length}</div><div class="d">${scripts.filter((s) => s.source !== 'manual').length} generated</div></div>
      <div class="tile"><div class="k">Runs</div><div class="v">${finished.length}</div><div class="d">${fmt.num(totalReqs)} requests sent in total</div></div>
      <div class="tile ${passRate != null && passRate < 0.8 ? 'bad' : passRate != null ? 'good' : ''}"><div class="k">Pass rate (last ${recent.length})</div><div class="v">${passRate == null ? '—' : fmt.pct(passRate, 0)}</div><div class="d">runs meeting all thresholds</div></div>
      <div class="tile"><div class="k">Running now</div><div class="v">${active.length}</div><div class="d">${active.length ? active.map((r) => esc(r.scriptName)).join(', ') : 'idle'}</div></div>
    </div>

    ${active.length ? `<h2 style="font-size:15px;margin:24px 0 10px">Live runs</h2><div class="list">${active.map((r) => `
      <a class="list-row" href="#/runs/${r.id}" style="text-decoration:none">${badge('running')}<div class="grow"><div class="name">${esc(r.name)}</div><div class="muted small">started ${relTime(r.createdAt)}</div></div><span class="btn sm">Watch live →</span></a>`).join('')}</div>` : ''}

    <div class="grid2" style="margin-top:24px">
      <div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0">p95 response time per run</h3><select id="trend-script" style="width:auto;max-width:220px"><option value="">All scripts</option>${scripts.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div style="position:relative;height:220px"><canvas id="trend"></canvas></div>
        <p class="muted small" style="margin:6px 0 0">Spot regressions: each point is one finished run (oldest → newest).</p>
      </div>
      <div class="card">
        <h3>Quick start</h3>
        <ol style="margin:0;padding-left:18px;line-height:1.9">
          <li><a href="#/generate">Generate a script</a> from a URL, cURL, a browser HAR recording, OpenAPI or Postman.</li>
          <li>Pick a load profile (smoke, load, stress, spike, soak, breakpoint) and SLAs.</li>
          <li>Run it and watch live charts; stop any time.</li>
          <li>Open the report, export it as HTML/CSV/JSON, or compare against a baseline run.</li>
        </ol>
      </div>
    </div>

    <h2 style="font-size:15px;margin:24px 0 10px">Recent runs</h2>
    ${finished.length ? `<div class="list">${finished.slice(0, 8).map(runRow).join('')}</div><p><a href="#/runs">All runs →</a></p>`
    : `<div class="card empty"><h3>No runs yet</h3><p>Generate or write a script, then press Run.</p></div>`}
  `;

  let chart = null;
  const drawTrend = () => {
    const sid = el.querySelector('#trend-script').value;
    const pts = finished.filter((r) => r.headline && (!sid || r.scriptId === sid)).slice(0, 30).reverse();
    const col = seriesColors(el);
    chart?.destroy();
    chart = null;
    const canvas = el.querySelector('#trend');
    canvas.parentElement.querySelector('.empty-note')?.remove();
    if (!pts.length) {
      canvas.parentElement.insertAdjacentHTML('beforeend', '<div class="empty-note muted" style="position:absolute;inset:0;display:grid;place-items:center">No finished runs yet</div>');
      return;
    }
    chart = lineChart(canvas, pts.map((r) => new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), [
      { label: 'p95', data: pts.map((r) => r.headline.p95), color: col.s1 },
    ], { yFormat: fmt.ms });
    chart.options.plugins.tooltip.callbacks.title = (items) => pts[items[0].dataIndex]?.name || '';
    chart.data.datasets[0].pointRadius = 3;
    chart.update();
  };
  el.querySelector('#trend-script').addEventListener('change', drawTrend);
  if (window.Chart) drawTrend();
  const onTheme = () => drawTrend();
  window.addEventListener('themechange', onTheme);
  return () => { chart?.destroy(); window.removeEventListener('themechange', onTheme); };
}

export function runRow(r) {
  const h = r.headline || {};
  return `<a class="list-row" href="#/runs/${r.id}" style="text-decoration:none;color:inherit">
    ${badge(r.status)}
    <div class="grow" style="min-width:0"><div class="name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</div>
      <div class="muted small">${esc(r.scriptName)} · ${relTime(r.createdAt)}${h.durationSec ? ` · ${fmt.dur(h.durationSec)}` : ''}</div></div>
    <div class="small" style="text-align:right;white-space:nowrap">
      <div><b>${fmt.ms(h.p95)}</b> <span class="muted">p95</span> · <b>${fmt.num(h.rps, 1)}</b> <span class="muted">req/s</span></div>
      <div class="muted">${fmt.pct(h.errRate)} errors · ${fmt.num(h.maxVus)} VUs</div>
    </div></a>`;
}
