// Report renderer shared by the app and the exported standalone HTML file.
// Depends only on a global `Chart` (Chart.js UMD) and the CSS in report.css.

export const fmt = {
  ms(v) {
    if (v == null || isNaN(v)) return '—';
    if (v === 0) return '0ms';
    if (v < 1) return `${(v * 1000).toFixed(0)}µs`;
    if (v < 1000) return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)}ms`;
    return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`;
  },
  num(v, d = 0) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  },
  pct(v, d = 2) { return v == null || isNaN(v) ? '—' : `${(v * 100).toFixed(d)}%`; },
  bytes(v) {
    if (v == null || isNaN(v)) return '—';
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  dur(sec) {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
  },
  clock(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },
  date(ts) { return ts ? new Date(ts).toLocaleString() : '—'; },
};

// Endpoint label without a duplicated leading method ("POST /x" shown next to a POST badge).
export function epName(e) {
  const n = String(e.name || '');
  return e.method && n.startsWith(e.method + ' ') ? n.slice(e.method.length + 1) : n;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { passed: 'Passed', failed: 'Thresholds failed', error: 'Error', stopped: 'Stopped', running: 'Running' };
export function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function seriesColors(el) {
  return {
    s1: cssVar(el, '--s1', '#2a78d6'),
    s2: cssVar(el, '--s2', '#eb6834'),
    s3: cssVar(el, '--s3', '#1baf7a'),
    crit: cssVar(el, '--crit', '#d03b3b'),
    muted: cssVar(el, '--muted', '#898781'),
    grid: cssVar(el, '--grid', 'rgba(0,0,0,.07)'),
    text: cssVar(el, '--text', '#1b1f24'),
  };
}

// Line chart with a crosshair-style index tooltip. `datasets`: [{label, data, color}]
export function lineChart(canvas, labels, datasets, { yFormat = (v) => v, stepped = false, min = 0 } = {}) {
  const C = window.Chart;
  const col = seriesColors(canvas);
  return new C(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        label: d.label, data: d.data, borderColor: d.color, backgroundColor: d.color,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2,
        pointHoverBorderColor: cssVar(canvas, '--panel', '#fff'), tension: 0.25, stepped, spanGaps: true,
        fill: false,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, position: 'top', align: 'end', labels: { color: col.text, boxWidth: 10, boxHeight: 2, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y == null ? '—' : yFormat(ctx.parsed.y)}` } },
        decimation: { enabled: labels.length > 1500, algorithm: 'min-max' },
      },
      scales: {
        x: { ticks: { color: col.muted, maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } }, grid: { display: false }, border: { color: col.grid } },
        y: { min, ticks: { color: col.muted, maxTicksLimit: 5, callback: (v) => yFormat(v), font: { size: 11 } }, grid: { color: col.grid }, border: { display: false } },
      },
    },
  });
}

export function chartCard(id, title, note = '') {
  return `<div class="chart-card"><div class="ct">${esc(title)}${note ? `<span>${esc(note)}</span>` : ''}</div><div class="cw"><canvas id="${id}"></canvas></div></div>`;
}

// Draws the four standard charts for a series into canvases with the given id prefix.
export function drawSeriesCharts(root, prefix, series, charts = {}) {
  const t0 = series.length ? series[0].t : 0;
  const labels = series.map((p) => fmt.clock(p.t - t0));
  const col = seriesColors(root);
  const get = (id) => root.querySelector(`#${prefix}${id}`);
  const specs = {
    vus: { ds: [{ label: 'VUs', data: series.map((p) => p.vus), color: col.s1 }], o: { stepped: true, yFormat: (v) => fmt.num(v) } },
    rps: { ds: [{ label: 'Requests/s', data: series.map((p) => p.rps), color: col.s1 }], o: { yFormat: (v) => fmt.num(v, 1) } },
    lat: {
      ds: [
        { label: 'avg', data: series.map((p) => p.avg), color: col.s1 },
        { label: 'p95', data: series.map((p) => p.p95), color: col.s2 },
        { label: 'p99', data: series.map((p) => p.p99), color: col.s3 },
      ],
      o: { yFormat: fmt.ms },
    },
    err: { ds: [{ label: 'Failed requests/s', data: series.map((p) => p.errors), color: col.crit }], o: { yFormat: (v) => fmt.num(v, 1) } },
  };
  for (const [k, s] of Object.entries(specs)) {
    const cv = get(k);
    if (!cv) continue;
    if (charts[k]) {
      charts[k].data.labels = labels;
      s.ds.forEach((d, i) => { charts[k].data.datasets[i].data = d.data; });
      charts[k].update('none');
    } else {
      charts[k] = lineChart(cv, labels, s.ds, s.o);
    }
  }
  return charts;
}

export function seriesChartsHtml(prefix) {
  return `<div class="charts">
    ${chartCard(prefix + 'vus', 'Virtual users')}
    ${chartCard(prefix + 'rps', 'Throughput', 'requests per second')}
    ${chartCard(prefix + 'lat', 'Response time', 'http_req_duration')}
    ${chartCard(prefix + 'err', 'Errors', 'failed requests per second')}
  </div>`;
}

// ---------- automatic findings ----------
export function findings(meta, r) {
  const out = [];
  const s = r.series || [];
  const t = r.totals || {};
  if (!t.reqs) {
    out.push({ level: 'critical', text: 'No HTTP requests were recorded. Check the script, the target URL and the run log.' });
    return out;
  }
  const failedTh = (r.thresholds || []).filter((x) => !x.ok);
  if (failedTh.length) out.push({ level: 'critical', text: `${failedTh.length} of ${r.thresholds.length} threshold(s) failed: ${failedTh.map((x) => `<code>${esc(x.metric)} ${esc(x.expr)}</code>`).join(', ')}.` });
  else if ((r.thresholds || []).length) out.push({ level: 'good', text: `All ${r.thresholds.length} threshold(s) passed.` });

  if (t.errRate >= 0.05) out.push({ level: 'critical', text: `High error rate: ${fmt.pct(t.errRate)} of requests failed (${fmt.num(t.fails)}).${r.errors?.[0] ? ` Most common: <b>${esc(r.errors[0].message)}</b> on ${esc(r.errors[0].endpoint)}.` : ''}` });
  else if (t.errRate >= 0.01) out.push({ level: 'warning', text: `Error rate ${fmt.pct(t.errRate)} (${fmt.num(t.fails)} failed requests).${r.errors?.[0] ? ` Most common: <b>${esc(r.errors[0].message)}</b>.` : ''}` });
  else if (t.fails === 0) out.push({ level: 'good', text: 'No failed requests.' });

  // Error onset: first second where errors became significant.
  const firstErr = s.findIndex((p) => p.rps > 0 && p.errRate > 0.05);
  if (firstErr > 0 && t.errRate >= 0.01 && s[firstErr].vus) {
    out.push({ level: 'warning', text: `Errors started at ${fmt.clock(s[firstErr].t - s[0].t)} with about <b>${fmt.num(s[firstErr].vus)} VUs</b> and ${fmt.num(s[firstErr].rps)} req/s.` });
  }

  // Latency degradation: compare early vs late windows of active traffic.
  const active = s.filter((p) => p.rps > 0 && p.p95 != null);
  if (active.length >= 20) {
    const n = Math.max(3, Math.floor(active.length * 0.2));
    const med = (a) => { const x = a.map((p) => p.p95).sort((m, k) => m - k); return x[Math.floor(x.length / 2)]; };
    const early = med(active.slice(0, n)), late = med(active.slice(-n));
    const peak = active.reduce((m, p) => (p.p95 > m.p95 ? p : m), active[0]);
    if (early > 0 && late / early > 1.5) out.push({ level: 'warning', text: `Response time degraded during the test: p95 went from ~${fmt.ms(early)} at the start to ~${fmt.ms(late)} at the end.` });
    if (peak.p95 > 3 * (r.latency?.med || Infinity)) out.push({ level: 'info', text: `Worst second: p95 of ${fmt.ms(peak.p95)} at ${fmt.clock(peak.t - s[0].t)}${peak.vus ? ` (${fmt.num(peak.vus)} VUs)` : ''}.` });

    // Saturation: VUs kept climbing while throughput stopped growing.
    const withVus = active.filter((p) => p.vus);
    if (withVus.length >= 20) {
      const maxV = Math.max(...withVus.map((p) => p.vus));
      const half = withVus.filter((p) => p.vus <= maxV * 0.5);
      const top = withVus.filter((p) => p.vus >= maxV * 0.9);
      if (half.length >= 3 && top.length >= 3) {
        const avg = (a, k) => a.reduce((m, p) => m + p[k], 0) / a.length;
        const rHalf = avg(half, 'rps'), rTop = avg(top, 'rps');
        const vHalf = avg(half, 'vus'), vTop = avg(top, 'vus');
        if (vTop / vHalf > 1.6 && rTop / rHalf < 1.2) {
          out.push({ level: 'warning', text: `Throughput plateaued: VUs grew ${(vTop / vHalf).toFixed(1)}× but requests/s only ${(rTop / rHalf).toFixed(2)}× (~${fmt.num(rTop)} req/s). The system likely hit a capacity limit around <b>${fmt.num(vHalf * (rTop / rHalf))}–${fmt.num(vTop)} VUs</b>.` });
        }
      }
    }
  }

  const eps = (r.endpoints || []).filter((e) => e.count >= 5);
  if (eps.length > 1) {
    const slow = [...eps].sort((a, b) => b.p95 - a.p95)[0];
    if (slow.p95 > 1.3 * (r.latency?.p95 || 0) || slow.p95 > 2 * (r.latency?.med || Infinity)) {
      out.push({ level: 'info', text: `Slowest endpoint: <b>${esc(slow.method)} ${esc(epName(slow))}</b> with p95 ${fmt.ms(slow.p95)} (overall p95 ${fmt.ms(r.latency.p95)}).` });
    }
    const worst = [...eps].sort((a, b) => b.errRate - a.errRate)[0];
    if (worst.errRate >= 0.01) out.push({ level: 'warning', text: `Most failing endpoint: <b>${esc(worst.method)} ${esc(epName(worst))}</b> — ${fmt.pct(worst.errRate)} errors.` });
  }
  const failingChecks = (r.checks || []).filter((c) => c.fails > 0);
  if (failingChecks.length) out.push({ level: 'warning', text: `${failingChecks.length} check(s) had failures, e.g. <b>${esc(failingChecks[0].name)}</b> (${fmt.num(failingChecks[0].fails)} failed).` });
  if (meta.status === 'stopped') out.push({ level: 'info', text: 'The run was stopped manually before the planned end.' });
  return out;
}

// ---------- main renderer ----------
export function renderReport(root, meta, r, { standalone = false } = {}) {
  if (!r) { root.innerHTML = '<p>No report data for this run.</p>'; return; }
  const t = r.totals || {};
  const lat = r.latency || {};
  const th = r.thresholds || [];
  const statusText = {
    passed: ['✓', 'Test passed', th.length ? `All ${th.length} thresholds met.` : 'No thresholds were defined — add some to get a pass/fail verdict.'],
    failed: ['✕', 'Test failed', `${th.filter((x) => !x.ok).length} of ${th.length} thresholds not met.`],
    error: ['!', 'Test errored', `k6 exited with code ${meta.exitCode ?? '?'} — see the log for details.`],
    stopped: ['■', 'Test stopped', 'Stopped manually; results cover the part that ran.'],
  }[meta.status] || ['•', meta.status, ''];

  const cfg = meta.config || {};
  const overrides = [cfg.vus && `${cfg.vus} VUs`, cfg.duration && `duration ${cfg.duration}`, cfg.iterations && `${cfg.iterations} iterations`, cfg.stages?.length && `${cfg.stages.length} stages`].filter(Boolean);

  const tiles = [
    ['Requests', fmt.num(t.reqs), `${fmt.num(t.rps, 1)} req/s avg · peak ${fmt.num(t.peakRps)}`],
    ['p95 response', fmt.ms(lat.p95), `p99 ${fmt.ms(lat.p99)} · max ${fmt.ms(lat.max)}`],
    ['Average response', fmt.ms(lat.avg), `median ${fmt.ms(lat.med)}`],
    ['Error rate', fmt.pct(t.errRate), `${fmt.num(t.fails)} failed`, t.errRate >= 0.01 ? 'bad' : t.reqs ? 'good' : ''],
    ['Checks passed', t.checkRate == null ? '—' : fmt.pct(t.checkRate), `${fmt.num(t.checksPass)} / ${fmt.num(t.checksPass + t.checksFail)}`, t.checkRate != null && t.checkRate < 0.99 ? 'bad' : ''],
    ['Peak VUs', fmt.num(t.maxVus), `${fmt.num(t.iters)} iterations`],
    ['Duration', fmt.dur(r.durationSec), fmt.date(r.startedAt)],
    ['Data', fmt.bytes(t.rx), `received · ${fmt.bytes(t.tx)} sent`],
    ['Time to first byte', fmt.ms(r.ttfb?.p95), 'p95 http_req_waiting'],
  ];

  const statusTotal = Object.values(r.statuses || {}).reduce((a, b) => a + b, 0) || 1;
  const statusRows = Object.entries(r.statuses || {}).sort((a, b) => b[1] - a[1]);

  const html = `
  <div class="rp">
    <div class="rp-head">
      <div style="min-width:0">
        <h1 class="rp-title">${esc(meta.name)}</h1>
        <div class="rp-sub">
          ${badge(meta.status)}
          <span>Script: <b>${esc(meta.scriptName)}</b></span>
          <span>${fmt.date(meta.createdAt)}</span>
          ${overrides.length ? `<span>Overrides: ${esc(overrides.join(', '))}</span>` : ''}
          ${Object.keys(cfg.env || {}).length ? `<span>Env: ${esc(Object.keys(cfg.env).join(', '))}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="rp-verdict ${esc(meta.status)}"><div class="ic">${statusText[0]}</div><div><b>${esc(statusText[1])}</b><div style="color:var(--muted);font-size:13px">${esc(statusText[2])}</div></div></div>
    ${meta.notes ? `<p style="white-space:pre-wrap;color:var(--muted);font-size:13px">${esc(meta.notes)}</p>` : ''}

    <h2>Summary</h2>
    <div class="tiles">${tiles.map(([k, v, d, cls]) => `<div class="tile ${cls || ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join('')}</div>

    <h2>Key findings <small>automatic analysis</small></h2>
    <div class="findings">${findings(meta, r).map((f) => `<div class="finding ${f.level}"><div class="fi">${{ critical: '!', warning: '!', good: '✓', info: 'i' }[f.level]}</div><div>${f.text}</div></div>`).join('')}</div>

    ${th.length ? `<h2>Thresholds</h2>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Result</th><th>Metric</th><th>Condition</th><th class="num">Actual</th></tr></thead><tbody>
      ${th.map((x) => `<tr><td class="${x.ok ? 'good' : 'bad'}">${x.ok ? '✓ pass' : '✕ fail'}</td><td>${esc(x.metric)}</td><td><code>${esc(x.expr)}</code></td><td class="num">${x.value == null ? '—' : esc(fmtThreshold(x))}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <h2>Over time</h2>
    ${seriesChartsHtml('rpc-')}

    <h2>Endpoints <small>${(r.endpoints || []).length} unique · click a column to sort</small></h2>
    <div class="tbl-wrap"><table class="tbl" id="rp-endpoints"><thead><tr>
      <th class="sortable" data-k="name">Endpoint</th><th class="sortable num" data-k="count">Requests</th><th class="sortable num" data-k="rps">req/s</th>
      <th class="sortable num" data-k="errRate">Errors</th><th class="sortable num" data-k="avg">avg</th><th class="sortable num" data-k="med">med</th>
      <th class="sortable num" data-k="p90">p90</th><th class="sortable num" data-k="p95">p95</th><th class="sortable num" data-k="p99">p99</th><th class="sortable num" data-k="max">max</th><th>Status codes</th>
    </tr></thead><tbody></tbody></table></div>

    <div class="charts" style="margin-top:12px">
      <div>
        <h2 style="margin-top:12px">Status codes</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Status</th><th class="num">Count</th><th class="num">Share</th><th style="width:40%"></th></tr></thead><tbody>
        ${statusRows.map(([code, n]) => { const bad = code === '0' || +code >= 400; return `<tr><td class="${bad ? 'bad' : ''}">${code === '0' ? '0 (no response)' : esc(code)}</td><td class="num">${fmt.num(n)}</td><td class="num">${fmt.pct(n / statusTotal, 1)}</td><td><div class="bar ${bad ? 'crit' : ''}" style="width:${Math.max(1, (n / statusTotal) * 100)}%"></div></td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">No HTTP responses</td></tr>'}
        </tbody></table></div>
      </div>
      <div>
        <h2 style="margin-top:12px">Checks</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Check</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Rate</th></tr></thead><tbody>
        ${(r.checks || []).map((c) => { const rate = c.passes / ((c.passes + c.fails) || 1); return `<tr><td class="wrap">${esc(c.name)}</td><td class="num">${fmt.num(c.passes)}</td><td class="num ${c.fails ? 'bad' : ''}">${fmt.num(c.fails)}</td><td class="num ${rate < 1 ? 'bad' : 'good'}">${fmt.pct(rate, 1)}</td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">No checks in this script</td></tr>'}
        </tbody></table></div>
      </div>
    </div>

    ${(r.errors || []).length ? `<h2>Errors <small>top ${r.errors.length}</small></h2>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num">Count</th><th>Status</th><th>Code</th><th>Message</th><th>Endpoint</th></tr></thead><tbody>
      ${r.errors.map((e) => `<tr><td class="num bad">${fmt.num(e.count)}</td><td>${esc(e.status)}</td><td>${esc(e.code)}</td><td class="wrap">${esc(e.message)}</td><td class="ep" title="${esc(e.endpoint)}">${esc(e.endpoint)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <h2>All k6 metrics <small>from the k6 end-of-test summary</small></h2>
    ${k6MetricsTable(r.k6Metrics || {})}

    <details><summary>k6 command</summary><pre class="cmd">${esc(r.command || '')}</pre></details>
  </div>`;
  root.innerHTML = html;

  // Endpoints table with client-side sorting.
  const eps = [...(r.endpoints || [])];
  const tbody = root.querySelector('#rp-endpoints tbody');
  let sortK = 'count', dir = -1;
  const drawEps = () => {
    eps.sort((a, b) => (typeof a[sortK] === 'string' ? a[sortK].localeCompare(b[sortK]) : a[sortK] - b[sortK]) * dir);
    tbody.innerHTML = eps.map((e) => `<tr>
      <td class="ep" title="${esc(e.name)}"><span class="method">${esc(e.method)}</span>${esc(epName(e))}</td>
      <td class="num">${fmt.num(e.count)}</td><td class="num">${fmt.num(e.rps, 1)}</td>
      <td class="num ${e.errRate >= 0.01 ? 'bad' : ''}">${fmt.pct(e.errRate, 1)}</td>
      ${['avg', 'med', 'p90', 'p95', 'p99', 'max'].map((k) => `<td class="num">${fmt.ms(e[k])}</td>`).join('')}
      <td class="muted">${Object.entries(e.statuses || {}).map(([c, n]) => `${c === '0' ? 'none' : c}×${fmt.num(n)}`).join(' ')}</td></tr>`).join('')
      || '<tr><td colspan="11" class="muted">No HTTP requests</td></tr>';
  };
  root.querySelectorAll('#rp-endpoints th.sortable').forEach((th2) => th2.addEventListener('click', () => {
    const k = th2.dataset.k;
    if (sortK === k) dir *= -1; else { sortK = k; dir = k === 'name' ? 1 : -1; }
    drawEps();
  }));
  drawEps();

  if (window.Chart) drawSeriesCharts(root, 'rpc-', r.series || []);
  return root;
}

function fmtThreshold(x) {
  const isTime = /duration|waiting|connecting|blocked|tls|sending|receiving/.test(x.metric) && !/rate|count/.test(x.expr);
  if (isTime) return fmt.ms(x.value);
  if (/^rate/.test(x.expr.trim())) return fmt.pct(x.value);
  return fmt.num(x.value, 2);
}

function k6MetricsTable(metrics) {
  const names = Object.keys(metrics).sort();
  if (!names.length) return '<p class="muted" style="color:var(--muted)">No k6 summary was produced (the run may have failed before starting).</p>';
  const cols = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count', 'rate', 'value'];
  const used = cols.filter((c) => names.some((n) => metrics[n][c] !== undefined));
  const isTime = (n) => /duration|waiting|connecting|blocked|tls_handshaking|sending|receiving/.test(n);
  const cell = (n, c) => {
    const v = metrics[n][c];
    if (v === undefined) return '';
    if (isTime(n) && !['count', 'rate'].includes(c)) return fmt.ms(v);
    if (/data_/.test(n) && c === 'count') return fmt.bytes(v);
    if (c === 'value' && v <= 1 && /failed|checks|rate/.test(n)) return fmt.pct(v);
    return fmt.num(v, 2);
  };
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Metric</th>${used.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead><tbody>
    ${names.map((n) => `<tr><td>${esc(n)}</td>${used.map((c) => `<td class="num">${cell(n, c)}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
}
