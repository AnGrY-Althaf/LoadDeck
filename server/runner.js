// Spawns k6, tails its JSON output, aggregates live and pushes updates over SSE.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { applySummary } from './summary.js';
import { Aggregator } from './aggregator.js';
import * as store from './store.js';

const active = new Map(); // runId -> state
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const TREND_STATS = 'avg,min,med,max,p(75),p(90),p(95),p(99),count';

export function k6Version() {
  return new Promise((resolve) => {
    execFile(store.getSettings().k6Path, ['version'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : String(out).trim().split('\n')[0]);
    });
  });
}

// Validate a script with `k6 inspect` (parses and evaluates options without running).
export function validateScript(code, env = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loaddeck-'));
    const file = path.join(dir, 'script.js');
    fs.writeFileSync(file, code);
    execFile(store.getSettings().k6Path, ['inspect', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), file], { timeout: 20000, cwd: dir }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) {
        const msg = String(stderr || err.message).replace(/(?:file:\/\/)?[^\s'"]*\/script\.js/g, 'script.js').replace(/^time="[^"]*" level=\w+ msg="?/gm, '').replace(/"\s*$/gm, '');
        resolve({ ok: false, error: msg.trim() });
      } else {
        let options = null;
        try { options = JSON.parse(stdout); } catch { /* ignore */ }
        resolve({ ok: true, options: options && compactOptions(options) });
      }
    });
  });
}

function compactOptions(o) {
  const out = {};
  for (const k of ['vus', 'duration', 'iterations', 'stages', 'scenarios', 'thresholds']) if (o[k] != null) out[k] = o[k];
  return out;
}

export function activeRuns() {
  return [...active.values()].map((s) => s.meta);
}

function buildArgs(cfg, dir) {
  const args = ['run', '--no-color', '-q',
    `--summary-export=${path.join(dir, 'summary.json')}`,
    `--summary-trend-stats=${TREND_STATS}`,
    '--out', `json=${path.join(dir, 'raw.ndjson')}`];
  if (cfg.vus) args.push('--vus', String(parseInt(cfg.vus, 10)));
  if (cfg.duration) args.push('--duration', String(cfg.duration));
  if (cfg.iterations) args.push('--iterations', String(parseInt(cfg.iterations, 10)));
  for (const st of cfg.stages || []) {
    if (st.duration && st.target !== '' && st.target != null) args.push('--stage', `${st.duration}:${parseInt(st.target, 10)}`);
  }
  for (const [k, v] of Object.entries(cfg.env || {})) if (k) args.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(cfg.tags || {})) if (k) args.push('--tag', `${k}=${v}`);
  if (cfg.httpDebug) args.push('--http-debug=full');
  args.push(path.join(dir, 'script.js'));
  return args;
}

export async function startRun(cfg) {
  const settings = store.getSettings();
  const running = [...active.values()].filter((s) => s.meta.status === 'running').length;
  if (running >= settings.maxConcurrentRuns) {
    throw Object.assign(new Error(`Already ${running} run(s) in progress (limit ${settings.maxConcurrentRuns}). Stop one or raise the limit in Settings.`), { status: 409 });
  }

  let code = cfg.code;
  let scriptName = cfg.scriptName || 'Ad-hoc script';
  if (cfg.scriptId) {
    const s = store.getScript(cfg.scriptId);
    if (!s) throw Object.assign(new Error('script not found'), { status: 404 });
    code = s.code;
    scriptName = s.name;
  }
  if (!code) throw Object.assign(new Error('no script code'), { status: 400 });

  const validation = await validateScript(code, cfg.env || {});
  if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 422 });
  const hasBrowser = Object.values(validation.options?.scenarios || {}).some(s => s.options?.browser);
  if (hasBrowser && (cfg.vus || cfg.duration || cfg.iterations || cfg.stages?.length)) {
    throw Object.assign(new Error('Browser and hybrid tests must use script options to preserve their browser scenarios. Change user counts and durations in the builder or script.'), { status: 422 });
  }
  // Validation is asynchronous; recheck capacity before reserving a run slot.
  if ([...active.values()].filter(s => s.meta.status === 'running').length >= settings.maxConcurrentRuns) {
    throw Object.assign(new Error('Concurrent run limit reached.'), { status: 409 });
  }
  const id = store.newId('r');
  const dir = store.createRunDir(id);
  fs.writeFileSync(path.join(dir, 'script.js'), code);

  const config = {
    vus: cfg.vus || null, duration: cfg.duration || null, iterations: cfg.iterations || null,
    stages: (cfg.stages || []).filter((s) => s.duration), env: cfg.env || {}, tags: cfg.tags || {},
    httpDebug: !!cfg.httpDebug,
    browserHeadless: cfg.browserHeadless !== false,
    hasBrowser,
  };
  const meta = {
    id,
    name: cfg.name || `${scriptName} — ${new Date().toLocaleString()}`,
    scriptId: cfg.scriptId || null,
    scriptName,
    notes: cfg.notes || '',
    config,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    headline: null,
    thresholds: null,
  };
  store.saveRunMeta(meta);

  const args = buildArgs(config, dir);
  const logStream = fs.createWriteStream(path.join(dir, 'stdout.log'));
  const state = {
    meta, agg: new Aggregator(), clients: new Set(), logs: [], logBytes: 0,
    offset: 0, decoder: new StringDecoder('utf8'), carry: '', proc: null, timer: null,
    stopRequested: false, command: `k6 ${args.map((a, i) => args[i - 1] === '-e' ? `${a.split('=')[0]}=[redacted]` : (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
  };
  active.set(id, state);

  const proc = spawn(settings.k6Path, args, {
    cwd: dir,
    env: { ...process.env, K6_NO_USAGE_REPORT: 'true', ...(hasBrowser ? { K6_BROWSER_HEADLESS: String(config.browserHeadless) } : {}) },
  });
  state.proc = proc;

  const onOutput = (chunk) => {
    const text = chunk.toString();
    if (state.logBytes < MAX_LOG_BYTES) { logStream.write(text); state.logBytes += text.length; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      state.logs.push(clean);
      if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
      broadcast(state, 'log', { line: clean });
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);

  proc.on('error', (err) => {
    onOutput(Buffer.from(`Failed to start k6 (${settings.k6Path}): ${err.message}\n`));
  });

  state.timer = setInterval(() => {
    readNew(state);
    const points = state.agg.takeNewPoints(false);
    broadcast(state, 'tick', { points, totals: state.agg.liveTotals() });
  }, 1000);

  proc.on('close', (codeNum) => finish(state, codeNum, settings));
  return meta;
}

function readNew(state) {
  const file = path.join(store.runDir(state.meta.id), 'raw.ndjson');
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, state.offset);
      if (n <= 0) break;
      state.offset += n;
      const text = state.carry + state.decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      state.carry = lines.pop();
      for (const l of lines) state.agg.ingestLine(l);
    }
  } finally { fs.closeSync(fd); }
}

function parseThresholds(summary) {
  const list = [];
  if (!summary?.metrics) return list;
  for (const [metric, m] of Object.entries(summary.metrics)) {
    if (!m.thresholds) continue;
    for (const [expr, failed] of Object.entries(m.thresholds)) {
      const stat = (/^\s*([a-z]+(?:\(\d+(?:\.\d+)?\))?)/i.exec(expr) || [])[1];
      let value = null;
      if (stat) {
        const key = stat === 'rate' && m.value !== undefined && m.rate === undefined ? 'value' : stat;
        value = m[key] ?? m.value ?? null;
      }
      list.push({ metric, expr, ok: !failed, value });
    }
  }
  return list;
}

function finish(state, exitCode, settings) {
  clearInterval(state.timer);
  const { meta } = state;
  const dir = store.runDir(meta.id);
  try { readNew(state); } catch { /* ignore */ }
  if (state.carry) { state.agg.ingestLine(state.carry); state.carry = ''; }
  const lastPoints = state.agg.takeNewPoints(true);

  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch { /* none */ }

  const result = state.agg.result();
  const measurement = applySummary(result, summary);
  const thresholds = parseThresholds(summary);
  const report = {
    ...result,
    measurement,
    thresholds,
    k6Metrics: summary?.metrics || {},
    k6Groups: summary?.root_group || null,
    command: state.command,
  };
  store.saveRunReport(meta.id, report);

  let status;
  if (state.stopRequested) status = 'stopped';
  else if (exitCode === 0) status = 'passed';
  else if (exitCode === 99) status = 'failed';
  else status = 'error';
  if (status === 'passed' && thresholds.some((t) => !t.ok)) status = 'failed';

  Object.assign(meta, {
    status,
    exitCode,
    finishedAt: Date.now(),
    thresholds: { total: thresholds.length, failed: thresholds.filter((t) => !t.ok).length },
    headline: {
      reqs: result.totals.reqs,
      rps: result.totals.rps,
      p95: result.latency.p95,
      avg: result.latency.avg,
      errRate: result.totals.errRate,
      maxVus: result.totals.maxVus,
      durationSec: result.durationSec,
      checkRate: result.totals.checkRate,
    },
  });
  store.saveRunMeta(meta);

  if (!settings.keepRawData) fs.rmSync(path.join(dir, 'raw.ndjson'), { force: true });

  broadcast(state, 'tick', { points: lastPoints, totals: state.agg.liveTotals() });
  broadcast(state, 'done', { meta });
  for (const res of state.clients) res.end();
  state.clients.clear();
  // Keep finished state briefly so late subscribers get the final event.
  setTimeout(() => active.delete(meta.id), 10000);
}

function broadcast(state, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.clients) res.write(payload);
}

export function stopRun(id) {
  const state = active.get(id);
  if (!state || state.meta.status !== 'running') return false;
  if (state.stopRequested) {
    state.proc.kill('SIGKILL');
  } else {
    state.stopRequested = true;
    state.proc.kill('SIGINT'); // graceful: k6 finishes iterations and writes the summary
    broadcast(state, 'log', { line: '■ Stop requested — k6 is shutting down gracefully (press Stop again to force kill)…' });
  }
  return true;
}

// SSE subscription. Sends the full history first so a page reload loses nothing.
export function subscribe(id, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const state = active.get(id);
  if (!state) {
    const meta = store.getRunMeta(id);
    res.write(`event: done\ndata: ${JSON.stringify({ meta })}\n\n`);
    res.end();
    return;
  }
  const points = state.agg.series().filter((p) => state.agg.flushedUpTo === null || p.t <= state.agg.flushedUpTo);
  res.write(`event: init\ndata: ${JSON.stringify({ meta: state.meta, points, logs: state.logs.slice(-300), totals: state.agg.liveTotals(), command: state.command })}\n\n`);
  if (state.meta.status !== 'running') {
    res.write(`event: done\ndata: ${JSON.stringify({ meta: state.meta })}\n\n`);
    res.end();
    return;
  }
  state.clients.add(res);
  res.on('close', () => state.clients.delete(res));
}

export function stopAll() {
  for (const s of active.values()) if (s.meta.status === 'running') s.proc.kill('SIGINT');
}

// Runs left as "running" after a crash/restart of the app are marked as interrupted.
export function recoverStaleRuns() {
  for (const m of store.listRuns()) {
    if (m.status === 'running' && !active.has(m.id)) {
      m.status = 'error';
      m.notes = (m.notes ? m.notes + '\n' : '') + 'Interrupted: LoadDeck was restarted while this run was in progress.';
      m.finishedAt = m.finishedAt || Date.now();
      store.saveRunMeta(m);
    }
  }
}
