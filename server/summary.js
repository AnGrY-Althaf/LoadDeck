// Preserve k6's exact aggregate values; histogram estimates are for live/endpoint views.
export function applySummary(result, summary) {
  const metrics = summary?.metrics;
  if (!metrics) return { source: 'stream', complete: false };
  const trend = (name, target) => {
    const m = metrics[name];
    if (!m) return;
    for (const [dest, src] of Object.entries({ avg: 'avg', min: 'min', max: 'max', med: 'med', p75: 'p(75)', p90: 'p(90)', p95: 'p(95)', p99: 'p(99)', count: 'count' })) {
      if (Number.isFinite(m[src])) target[dest] = m[src];
    }
  };
  trend('http_req_duration', result.latency);
  trend('http_req_waiting', result.ttfb);
  trend('iteration_duration', result.iterationDuration);
  trend('browser_http_req_duration', result.browser.latency);
  for (const [name, m] of Object.entries(metrics)) {
    if (name.startsWith('browser_web_vital_') && !name.includes('{')) {
      result.browser.vitals[name] ||= {};
      trend(name, result.browser.vitals[name]);
    }
  }
  const t = result.totals;
  if (Number.isFinite(metrics.http_reqs?.count)) t.reqs = metrics.http_reqs.count;
  if (Number.isFinite(metrics.http_reqs?.rate)) t.rps = metrics.http_reqs.rate;
  // Rate sinks count true samples as "passes": for *_failed, true means a failure.
  if (Number.isFinite(metrics.http_req_failed?.value)) t.errRate = metrics.http_req_failed.value;
  if (Number.isFinite(metrics.http_req_failed?.passes)) t.fails = metrics.http_req_failed.passes;
  if (Number.isFinite(metrics.dropped_iterations?.count)) t.dropped = metrics.dropped_iterations.count;
  if (Number.isFinite(metrics.checks?.value)) t.checkRate = metrics.checks.value;
  if (Number.isFinite(metrics.checks?.passes)) t.checksPass = metrics.checks.passes;
  if (Number.isFinite(metrics.checks?.fails)) t.checksFail = metrics.checks.fails;
  if (Number.isFinite(metrics.iterations?.count)) t.iters = metrics.iterations.count;
  const browserFailed = metrics.browser_http_req_failed;
  if (Number.isFinite(browserFailed?.value)) result.browser.errRate = browserFailed.value;
  if (Number.isFinite(browserFailed?.passes)) {
    result.browser.fails = browserFailed.passes;
    if (Number.isFinite(browserFailed.fails)) result.browser.reqs = browserFailed.passes + browserFailed.fails;
  }
  return { source: 'k6-summary', complete: true };
}
