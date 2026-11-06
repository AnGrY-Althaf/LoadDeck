import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { buildScript } from '../server/generator/builder.js';

const k6Available = spawnSync('k6', ['version']).status === 0;

test('real k6 API, concurrent Chromium and hybrid runs produce trustworthy reports', { skip: !k6Available, timeout: 90000 }, async t => {
  let pendingPages = 0, peakPages = 0;
  const target = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/api/health')) { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    pendingPages++; peakPages = Math.max(peakPages, pendingPages);
    setTimeout(() => {
      pendingPages--;
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body><h1>Test application</h1><input id="name"><button id="go" onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Continue</button><p id="result"></p></body></html>');
    }, 250);
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(() => target.close());
  const baseUrl = `http://127.0.0.1:${target.address().port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'loaddeck-test-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  // Reserve an available app port, then let the child bind it.
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const app = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), LOADDECK_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; app.stdout.on('data', b => { logs += b; }); app.stderr.on('data', b => { logs += b; });
  t.after(async () => { if (app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit'); } });
  const root = `http://127.0.0.1:${port}`;
  async function api(url, body) {
    const res = await fetch(root + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json)); return json;
  }
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) assert.fail(logs);
    try { await api('/api/settings'); break; } catch (e) { if (i === 79) throw e; await delay(100); }
  }
  const definitions = {
    http: { engine: 'http', baseUrl, requests: [{ name: 'Health', url: '/api/health' }], profile: { type: 'constant-rate', rate: 2, duration: '2s', vus: 2, maxVus: 4 }, thresholds: { p95: 1000, errorRate: 1, checkRate: 99 } },
    browser: { engine: 'browser', baseUrl, browser: { vus: 2, duration: '2s', lcp: 10000, steps: [
      { action: 'goto', value: '/' }, { action: 'fill', selector: '#name', value: '{{TEST_NAME}}' },
      { action: 'click', selector: '#go' }, { action: 'wait', selector: '#result' }, { action: 'assertText', selector: '#result', value: 'Hello LoadDeck' },
    ] } },
  };
  definitions.hybrid = { ...definitions.http, engine: 'hybrid', browser: definitions.browser.browser };
  for (const [engine, def] of Object.entries(definitions)) {
    await t.test(engine, async () => {
      const code = buildScript(def);
      const validation = await api('/api/validate', { code }); assert.equal(validation.ok, true, validation.error);
      const meta = await api('/api/runs', { code, scriptName: `Integration ${engine}`, env: { TEST_NAME: 'LoadDeck' } });
      let result;
      for (let i = 0; i < 200; i++) {
        result = await api(`/api/runs/${meta.id}`);
        if (result.meta.status !== 'running') break;
        await delay(200);
      }
      const log = await fetch(root + `/api/runs/${meta.id}/log`).then(r => r.text());
      assert.equal(result.meta.status, 'passed', log);
      assert.equal(result.report.measurement.source, 'k6-summary');
      assert(!result.report.command.includes('TEST_NAME=LoadDeck'));
      if (engine !== 'browser') {
        assert(result.report.totals.reqs > 0);
        assert.equal(result.report.latency.p95, result.report.k6Metrics.http_req_duration['p(95)']);
      } else assert.equal(result.report.totals.reqs, 0);
      if (engine !== 'http') {
        assert(result.report.browser.reqs > 0);
        assert(result.report.browser.vitals.browser_web_vital_lcp.count > 0);
        assert.equal(result.report.browser.errRate, 0);
        assert.equal(result.report.totals.checksFail, 0);
        const invalid = await fetch(root + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, vus: 3, duration: '1s' }) });
        assert.equal(invalid.status, 422);
      }
      const exported = await fetch(root + `/api/runs/${meta.id}/export/html`).then(r => r.text());
      assert(exported.includes('Browser experience'));
    });
  }
  await t.test('request failures and undelivered arrival load fail for the right reasons', async () => {
    const cases = [
      { ...definitions.http, requests: [{ name: 'Missing', url: '/not-found' }] },
      { ...definitions.http, profile: { type: 'constant-rate', rate: 20, duration: '1s', vus: 1, maxVus: 1 }, thinkTime: { min: 0.2, max: 0.2 } },
    ];
    for (const [i, def] of cases.entries()) {
      const meta = await api('/api/runs', { code: buildScript(def), scriptName: 'Expected failure' });
      let result;
      for (let n = 0; n < 100; n++) {
        result = await api(`/api/runs/${meta.id}`);
        if (result.meta.status !== 'running') break;
        await delay(200);
      }
      assert.equal(result.meta.status, 'failed');
      if (i === 0) {
        assert(result.report.totals.reqs > 0);
        assert.equal(result.report.totals.errRate, 1);
        assert.equal(result.report.totals.fails, result.report.totals.reqs);
        assert.equal(result.report.endpoints[0].fails, result.report.endpoints[0].count);
      } else {
        assert(result.report.totals.dropped > 0);
        assert.equal(result.report.totals.errRate, 0);
        assert(result.report.thresholds.some(th => th.metric === 'dropped_iterations' && !th.ok));
      }
    }
  });
  assert(peakPages >= 2, `Expected parallel browser navigations, observed ${peakPages}`);
});
