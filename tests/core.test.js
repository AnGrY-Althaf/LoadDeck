import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScript } from '../server/generator/builder.js';
import { Aggregator } from '../server/aggregator.js';
import { applySummary } from '../server/summary.js';
import { generationIssues } from '../server/generator/quality.js';
import { findings } from '../public/js/report-view.js';

const point = (metric, value, seconds = 0, tags = {}) => JSON.stringify({ type: 'Point', data: { time: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), value, tags }, metric });
const api = { baseUrl: 'http://localhost:3333', requests: [{ name: 'Health', url: '/health' }], profile: { type: 'constant-rate', rate: 2, duration: '1s', vus: 2, maxVus: 4 }, thresholds: { errorRate: 0, checkRate: 100 } };

test('browser and hybrid scripts preserve distinct workloads, isolation and cleanup', () => {
  const browser = buildScript({ engine: 'browser', baseUrl: 'http://localhost:3333', browser: { steps: [{ action: 'goto', value: '/' }, { action: 'fill', selector: '#password', value: '{{PASSWORD}}' }, { action: 'assertText', selector: 'h1', value: "It's ready" }] } });
  assert.match(browser, /browser\.newContext/);
  assert.match(browser, /finally \{\n    await context\.close/);
  assert.match(browser, /fill\(__ENV.PASSWORD\)/);
  assert.doesNotMatch(browser, /http_req_duration:/);
  assert.match(browser, /browser_web_vital_lcp/);
  const hybrid = buildScript({ ...api, engine: 'hybrid' });
  assert.match(hybrid, /constant-arrival-rate/);
  assert.match(hybrid, /exec: 'browserJourney'/);
  assert.match(hybrid, /dropped_iterations: \['count==0'\]/);
  assert.match(hybrid, /rate<=0/);
  assert.match(hybrid, /rate>=1/);
});

test('browser inputs reject broken journeys before saving', () => {
  for (const browser of [{ vus: -1 }, { vus: 1.5 }, { duration: 'forever' }, { steps: [{ action: 'click', selector: '#go' }] }, { steps: [{ action: 'goto', value: '/' }, { action: 'fill', selector: '' }] }]) {
    assert.throws(() => buildScript({ engine: 'browser', browser }));
  }
  assert.throws(() => buildScript({ requests: [] }), /enabled API request/);
});

test('aggregation is independent of JSON key order and counts dropped load', () => {
  const a = new Aggregator();
  a.ingestLine(point('http_req_duration', 100, 0, { name: '/test', expected_response: 'true', status: '200' }));
  a.ingestLine(point('http_req_failed', 1, 0, { name: '/test' }));
  a.ingestLine(point('dropped_iterations', 7, 5));
  a.ingestLine(point('checks', 1, 5));
  a.ingestLine(point('http_req_duration', NaN));
  const r = a.result();
  assert.equal(r.totals.reqs, 1);
  assert.equal(r.totals.fails, 1);
  assert.equal(r.totals.errRate, 1);
  assert.equal(r.endpoints[0].fails, 1);
  assert.equal(r.totals.dropped, 7);
  assert.equal(a.liveTotals().elapsed, 6);
  assert.equal(r.series[0].errors, 1);
});

test('browser traffic and web vitals remain separate from API latency', () => {
  const a = new Aggregator();
  for (const [metric, value] of [['http_req_duration', 100], ['browser_http_req_duration', 2000], ['browser_http_req_failed', 0], ['browser_web_vital_lcp', 2500]]) a.ingestLine(point(metric, value));
  const r = a.result();
  assert.equal(r.latency.avg, 100);
  assert.equal(r.totals.reqs, 1);
  assert.equal(r.browser.reqs, 1);
  assert.equal(r.browser.latency.avg, 2000);
  assert.equal(r.browser.vitals.browser_web_vital_lcp.p75, 2500);
});

test('summary aggregates use exact k6 percentiles and failure-rate semantics', () => {
  const r = new Aggregator().result();
  const m = applySummary(r, { metrics: {
    http_reqs: { count: 10, rate: 2.75 }, http_req_duration: { 'p(95)': 123.456 },
    http_req_failed: { passes: 2, fails: 8, value: 0.2 },
    browser_http_req_failed: { passes: 1, fails: 9, value: 0.1 },
    browser_web_vital_lcp: { 'p(75)': 2345, count: 4 },
  } });
  assert.equal(r.latency.p95, 123.456);
  assert.equal(r.totals.fails, 2);
  assert.equal(r.totals.rps, 2.75);
  assert.equal(r.browser.reqs, 10);
  assert.equal(r.browser.fails, 1);
  assert.equal(m.complete, true);
  assert.equal(applySummary(r, null).complete, false);
});

test('AI execution-plan review catches valid syntax with wrong workloads', () => {
  assert.match(generationIssues({ scenarios: { main: { executor: 'constant-arrival-rate' } }, thresholds: { checks: [] } }, 'hybrid').join(' '), /Chromium/);
  assert.match(generationIssues({ scenarios: { main: { executor: 'constant-arrival-rate' } }, thresholds: { checks: [] } }).join(' '), /dropped_iterations/);
  assert.deepEqual(generationIssues({ scenarios: { browser: { options: { browser: { type: 'chromium' } } } }, thresholds: { browser_web_vital_lcp: [] } }, 'browser'), []);
});

test('browser-only reports do not incorrectly report no traffic', () => {
  const a = new Aggregator();
  a.ingestLine(point('browser_http_req_duration', 20));
  const r = a.result();
  assert(!findings({}, r).some(f => f.text.includes('No HTTP requests')));
  r.totals.dropped = 3;
  assert(findings({}, r).some(f => f.text.includes('dropped')));
});
