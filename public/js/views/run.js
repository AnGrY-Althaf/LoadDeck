import { api, esc, fmt, badge, toast, modal, confirmDialog, download, prompt } from '../ui.js';
import { navigate, app } from '../app.js';
import { renderReport, seriesChartsHtml, drawSeriesCharts } from '../report-view.js';
import { openRunDialog } from './run-dialog.js';

export default async function run(el, { params }) {
  const id = params[0];
  const { meta } = await api(`/api/runs/${id}`);
  if (meta.status === 'running') return live(el, meta);
  return report(el, id);
}

function logLine(line) {
  const cls = /level=error|ERRO|error:/i.test(line) ? 'lvl-error' : /level=warn|WARN/i.test(line) ? 'lvl-warn' : line.startsWith('■') ? 'sys' : '';
  return `<div class="${cls}">${esc(line)}</div>`;
}

function live(el, meta) {
  el.innerHTML = `
    <div class="page-head">
      <div style="min-width:0"><h1 style="word-break:break-word">${esc(meta.name)}</h1>
        <p class="row">${badge('running')} <span>Script: <b>${esc(meta.scriptName)}</b></span> <span id="elapsed" class="muted"></span></p></div>
      <div class="row"><button class="btn danger solid" id="stop">■ Stop test</button></div>
    </div>
    <div class="tiles live-tiles" id="ltiles"></div>
    <div style="margin-top:14px">${seriesChartsHtml('lv-')}</div>
    <h2 style="font-size:15px;margin:22px 0 8px">Console <span class="muted small" style="font-weight:400">k6 output &amp; script console.log</span></h2>
    <div class="console" id="console"></div>
    <details><summary>k6 command</summary><pre class="cmd" id="cmd" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;white-space:pre-wrap;word-break:break-all;font-size:12px"></pre></details>`;

  const series = [];
  let charts = {};
  let totals = null;
  const con = el.querySelector('#console');
  const appendLogs = (lines) => {
    const stick = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
    con.insertAdjacentHTML('beforeend', lines.map(logLine).join(''));
    while (con.childElementCount > 2000) con.firstElementChild.remove();
    if (stick) con.scrollTop = con.scrollHeight;
  };
  const drawTiles = () => {
    const last = series[series.length - 1] || {};
    const t = totals || {};
    const recent = series.slice(-5);
    const rps5 = recent.length ? recent.reduce((m, p) => m + p.rps, 0) / recent.length : 0;
    el.querySelector('#ltiles').innerHTML = [
      ['Virtual users', fmt.num(last.vus ?? 0), `peak ${fmt.num(t.maxVus || 0)}`],
      ['API requests / s', fmt.num(rps5, 1), 'last 5 seconds'],
      ['API p95 response', fmt.ms(last.p95), `overall ${fmt.ms(t.p95)}`],
      ['API avg response', fmt.ms(last.avg), `overall ${fmt.ms(t.avg)}`],
      ['API error rate', fmt.pct(t.errRate || 0), `${fmt.num(t.fails || 0)} failed`, (t.errRate || 0) >= 0.01 ? 'bad' : ''],
      ['Browser requests', fmt.num(t.browserReqs || 0), 'Chromium traffic, separate from API'],
      ['Dropped iterations', fmt.num(t.dropped || 0), 'scheduled journeys not started', t.dropped ? 'bad' : ''],
      ['API requests', fmt.num(t.reqs || 0), `${fmt.num(t.iters || 0)} iterations`],
      ['Checks failed', fmt.num(t.checksFail || 0), `${fmt.num(t.checksPass || 0)} passed`, t.checksFail ? 'bad' : ''],
    ].map(([k, v, d, c]) => `<div class="tile ${c || ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  };
  const redraw = () => { if (window.Chart) charts = drawSeriesCharts(el, 'lv-', series, charts); drawTiles(); };
  drawTiles();

  const timer = setInterval(() => { el.querySelector('#elapsed').textContent = `· running for ${fmt.dur((Date.now() - meta.createdAt) / 1000)}`; }, 1000);
  const es = new EventSource(`/api/runs/${meta.id}/stream`);
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    series.length = 0; series.push(...d.points);
    totals = d.totals;
    con.innerHTML = '';
    appendLogs(d.logs || []);
    el.querySelector('#cmd').textContent = d.command || '';
    redraw();
  });
  es.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data);
    if (d.points.length) series.push(...d.points);
    totals = d.totals;
    redraw();
  });
  es.addEventListener('log', (e) => appendLogs([JSON.parse(e.data).line]));
  es.addEventListener('done', () => {
    es.close();
    toast('Run finished — opening the report');
    setTimeout(() => { if (location.hash === `#/runs/${meta.id}`) report(el, meta.id); }, 600);
  });
  es.onerror = () => { /* EventSource retries automatically */ };

  el.querySelector('#stop').addEventListener('click', async (e) => {
    const second = e.target.dataset.stopping;
    await api(`/api/runs/${meta.id}/stop`, { method: 'POST' });
    e.target.dataset.stopping = '1';
    e.target.textContent = second ? 'Killing…' : '■ Stopping… (click to force)';
  });
  const onTheme = () => { Object.values(charts).forEach((c) => c.destroy()); charts = {}; redraw(); };
  window.addEventListener('themechange', onTheme);

  const cleanup = () => { es.close(); clearInterval(timer); Object.values(charts).forEach((c) => c.destroy()); window.removeEventListener('themechange', onTheme); };
  // If we switch to the report view in place, make sure live resources are released.
  app.cleanup = cleanup;
  return cleanup;
}

async function report(el, id) {
  if (app.cleanup) { try { app.cleanup(); } catch { /* ignore */ } app.cleanup = null; }
  const { meta, report: rep } = await api(`/api/runs/${id}`);
  // Fresh wrapper so re-rendering never stacks click handlers.
  el.innerHTML = '<div></div>';
  const host = el;
  el = host.firstElementChild;
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <a href="#/runs" class="small">← All runs</a>
      <div class="row">
        <button class="btn sm" data-a="html" title="Self-contained HTML file — open offline, share by email">⇩ HTML report</button>
        <button class="btn sm" data-a="csv">⇩ CSV</button>
        <button class="btn sm" data-a="json">⇩ JSON</button>
        <button class="btn sm" data-a="summary" title="Raw k6 --summary-export output">⇩ k6 summary</button>
        <span style="width:8px"></span>
        <button class="btn sm" data-a="script">Script</button>
        <button class="btn sm" data-a="log">Log</button>
        <button class="btn sm" data-a="compare">Compare…</button>
        <button class="btn sm" data-a="baseline" title="Use as the default comparison baseline for this script">${meta.baseline ? '★ Baseline' : '☆ Set baseline'}</button>
        <button class="btn sm" data-a="rename">Rename</button>
        <button class="btn sm primary" data-a="rerun">↻ Run again</button>
        <button class="btn sm ghost danger" data-a="delete" title="Delete run">✕</button>
      </div>
    </div>
    <div id="rep"></div>`;
  renderReport(el.querySelector('#rep'), meta, rep);

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (['html', 'csv', 'json', 'summary'].includes(a)) return download(`/api/runs/${id}/export/${a}`);
    if (a === 'script') {
      const code = await api(`/api/runs/${id}/script`);
      modal('Script used for this run', '<div class="editor-wrap"><textarea id="sc"></textarea></div>', {
        okText: 'Close', cancelText: '',
        onOpen(mb) { const cm = window.CodeMirror.fromTextArea(mb.querySelector('#sc'), { mode: 'javascript', lineNumbers: true, readOnly: true }); cm.setValue(code); cm.setSize(null, 420); setTimeout(() => cm.refresh(), 10); },
      });
      document.querySelector('.modal').style.width = 'min(960px, 100%)';
    }
    if (a === 'log') {
      const log = await api(`/api/runs/${id}/log`);
      modal('Run log', `<div class="console" style="height:60vh">${(String(log || '(empty)')).split('\n').map(logLine).join('')}</div>`, { okText: 'Close', cancelText: '' });
      document.querySelector('.modal').style.width = 'min(1000px, 100%)';
    }
    if (a === 'compare') {
      const runs = (await api('/api/runs')).filter((r) => r.id !== id && r.status !== 'running');
      if (!runs.length) return toast('No other runs to compare with yet');
      const same = runs.filter((r) => r.scriptId === meta.scriptId);
      const pick = same.find((r) => r.baseline) || same[0] || runs[0];
      const res = await modal('Compare with…', `<label class="f">Baseline run<select id="cmp">${runs.map((r) => `<option value="${r.id}" ${r.id === pick.id ? 'selected' : ''}>${r.baseline ? '★ ' : ''}${esc(r.name)} · ${fmt.date(r.createdAt)}</option>`).join('')}</select></label>`, { okText: 'Compare' });
      if (res) navigate(`#/compare?a=${res.querySelector('#cmp').value}&b=${id}`);
    }
    if (a === 'baseline') {
      await api(`/api/runs/${id}`, { method: 'PATCH', body: { baseline: !meta.baseline } });
      report(host, id);
    }
    if (a === 'rename') {
      const name = await prompt('Rename run', 'Name', meta.name);
      if (name) { await api(`/api/runs/${id}`, { method: 'PATCH', body: { name } }); report(host, id); }
    }
    if (a === 'rerun') {
      const c = meta.config || {};
      const preset = {
        mode: c.stages?.length ? 'stages' : c.iterations ? 'iterations' : c.vus || c.duration ? 'quick' : 'script',
        browserHeadless: c.browserHeadless,
        vus: c.vus || 10, duration: c.duration || '30s', iterations: c.iterations || 100,
        stages: (c.stages || []).map((s) => `${s.duration}:${s.target}`).join('\n') || undefined,
        env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        tags: Object.entries(c.tags || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      };
      Object.keys(preset).forEach((k) => preset[k] === undefined && delete preset[k]);
      let script = null;
      if (meta.scriptId) script = await api(`/api/scripts/${meta.scriptId}`).catch(() => null);
      if (!script) script = { name: meta.scriptName, code: await api(`/api/runs/${id}/script`) };
      openRunDialog(script, preset);
    }
    if (a === 'delete' && await confirmDialog('Delete run?', 'The run, its report and logs will be permanently removed.')) {
      await api(`/api/runs/${id}`, { method: 'DELETE' });
      navigate('#/runs');
    }
  });
}
