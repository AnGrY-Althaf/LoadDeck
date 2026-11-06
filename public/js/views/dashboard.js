import { api, esc, fmt, badge, relTime } from '../ui.js';
import { lineChart, seriesColors } from '../report-view.js';
import { icon } from '../icons.js';
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
      <div><div class="eyebrow">WORKSPACE OVERVIEW</div><h1>Performance overview</h1><p>Understand your limits. Ship your next release with confidence.</p></div>
      <a class="btn primary" href="#/generate">${icon('plus')} Create a test</a>
    </div>
    ${!app.info?.k6Version ? `<div class="warnbox" style="margin-bottom:20px"><b>Connect your test engine.</b> Install k6 with <code>brew install k6</code> or set its path in <a href="#/settings">Settings</a>.</div>` : ''}
    <div class="tiles overview-metrics">
      ${[
        ['code', 'Test scripts', fmt.num(scripts.length), `${scripts.filter(s => s.source !== 'manual').length} created with the builder or AI`, ''],
        ['layers', 'Completed runs', fmt.num(finished.length), `${fmt.num(totalReqs)} API requests recorded`, ''],
        ['check', 'Run success rate', passRate == null ? '—' : fmt.pct(passRate, 0), recent.length ? `Across the last ${recent.length} completed run${recent.length === 1 ? '' : 's'}` : 'Your first run sets the benchmark', passRate != null && passRate < .8 ? 'bad' : ''],
        ['activity', 'Active runs', fmt.num(active.length), active.length ? 'Tests are running on your local engine' : 'Engine standing by for your next test', active.length ? 'good' : ''],
      ].map(([i, k, v, d, cls]) => `<div class="tile ${cls}"><div class="metric-top"><span class="k">${k}</span><span class="metric-icon">${icon(i)}</span></div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join('')}
    </div>
    ${active.length ? `<div class="section-heading"><h2><span class="status-dot"></span> Running now</h2><span class="muted small">Live from your local engine</span></div><div class="list">${active.map(r => `<a class="list-row" href="#/runs/${r.id}">${badge('running')}<div class="grow"><div class="name">${esc(r.name)}</div><div class="muted small">Started ${relTime(r.createdAt)}</div></div><span class="btn sm">Watch live ${icon('arrow')}</span></a>`).join('')}</div>` : ''}

    <div class="overview-grid">
      <section class="card trend-card">
        <div class="section-heading"><div><div class="eyebrow">RELEASE HEALTH</div><h2>Response time trend</h2></div><select id="trend-script" aria-label="Filter response trend by script"><option value="">All scripts</option>${scripts.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="trend-plot"><canvas id="trend"></canvas></div>
        <div class="chart-foot"><span class="chart-key"></span><span>API p95 latency</span><span class="grow"></span><span>Last 30 API runs</span></div>
      </section>
      <section class="card workflow-card">
        <div class="eyebrow">FROM IDEA TO INSIGHT</div><h2>A better test, in three steps.</h2>
        <div class="workflow-step"><span>01</span><div><b>Build your journey</b><p>Import real traffic, use the visual builder, or describe it with AI.</p></div></div>
        <div class="workflow-step"><span>02</span><div><b>Put it under pressure</b><p>Choose a load profile and define what a healthy response looks like.</p></div></div>
        <div class="workflow-step"><span>03</span><div><b>Find your next improvement</b><p>Inspect errors, compare runs, and share a report with your team.</p></div></div>
        <a class="text-link" href="#/generate">${finished.length ? 'Create another test' : 'Build your first test'} ${icon('arrow')}</a>
      </section>
    </div>

    <div class="section-heading"><div><div class="eyebrow">CHOOSE YOUR WORKLOAD</div><h2>One workspace. Every layer.</h2></div><span class="muted small">Built on the real k6 engine</span></div>
    <div class="workload-grid">
      ${[
        ['http', 'server', 'API load', 'Find the throughput and latency limits of your services.', 'Protocol requests · high concurrency'],
        ['browser', 'browser', 'Real browsers', 'See how your application feels to concurrent users.', 'Chromium sessions · Web Vitals'],
        ['hybrid', 'layers', 'Hybrid testing', 'Measure the frontend while your backend is under load.', 'API traffic + browser journeys'],
      ].map(([mode, i, title, desc, note]) => `<a class="workload-card" href="#/generate?engine=${mode}"><span class="workload-icon">${icon(i)}</span><div class="workload-title"><h3>${title}</h3>${icon('arrow')}</div><p>${desc}</p><span class="workload-note">${note}</span></a>`).join('')}
    </div>

    <div class="section-heading"><div><div class="eyebrow">TEST HISTORY</div><h2>Recent runs <span class="section-count">${finished.length}</span></h2></div><a class="text-link" href="#/runs">View all runs ${icon('arrow')}</a></div>
    ${finished.length ? `<div class="list recent-list">${finished.slice(0, 6).map(runRow).join('')}</div>` : `<div class="card history-empty"><div class="empty-symbol">${icon('clock')}</div><div><h3>Your test history starts here</h3><p>Run a test to see results, spot regressions, and build a baseline.</p></div><a class="btn" href="#/generate">Create a test ${icon('arrow')}</a></div>`}
  `;

  let chart = null;
  const drawTrend = () => {
    const sid = el.querySelector('#trend-script').value;
    const pts = finished.filter((r) => r.headline?.reqs > 0 && (!sid || r.scriptId === sid)).slice(0, 30).reverse();
    const col = seriesColors(el);
    chart?.destroy();
    chart = null;
    const canvas = el.querySelector('#trend');
    canvas.parentElement.querySelector('.empty-note')?.remove();
    if (!pts.length) {
      canvas.parentElement.insertAdjacentHTML('beforeend', `<div class="empty-note trend-empty"><span class="empty-symbol">${icon('chart')}</span><b>No performance data yet</b><span>Completed API runs will appear here.<br>Your baseline starts with the first test.</span></div>`);
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
      <div>${r.config?.hasBrowser && !h.reqs ? '<b>Browser journey</b>' : `<b>${fmt.ms(h.p95)}</b> <span class="muted">p95</span> · <b>${fmt.num(h.rps, 1)}</b> <span class="muted">req/s</span>`}</div>
      <div class="muted">${fmt.pct(h.errRate)} errors · ${fmt.num(h.maxVus)} VUs</div>
    </div></a>`;
}
