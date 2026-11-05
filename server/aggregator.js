// Streaming aggregation of k6 NDJSON output (`--out json=...`).
// Memory is bounded: latencies go into log-bucketed histograms (~1% precision)
// instead of being stored, so hour-long soak tests stay cheap.

const LOG_BASE = Math.log(1.01);

export class Histogram {
  constructor() {
    this.buckets = new Map();
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  add(v) {
    this.count++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    const k = v <= 0 ? -100000 : Math.floor(Math.log(v) / LOG_BASE);
    this.buckets.set(k, (this.buckets.get(k) || 0) + 1);
  }

  quantile(p) {
    if (!this.count) return 0;
    const target = Math.max(1, Math.ceil((p / 100) * this.count));
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    let acc = 0;
    for (const k of keys) {
      acc += this.buckets.get(k);
      if (acc >= target) {
        if (k === -100000) return 0;
        const mid = Math.exp((k + 0.5) * LOG_BASE);
        return Math.min(this.max, Math.max(this.min, mid));
      }
    }
    return this.max;
  }

  stats() {
    if (!this.count) return { count: 0, avg: 0, min: 0, max: 0, med: 0, p90: 0, p95: 0, p99: 0 };
    return {
      count: this.count,
      avg: this.sum / this.count,
      min: this.min,
      max: this.max,
      med: this.quantile(50),
      p90: this.quantile(90),
      p95: this.quantile(95),
      p99: this.quantile(99),
    };
  }
}

// Metrics we parse. Everything else is skipped before JSON.parse for speed;
// the k6 summary export still covers all metrics in aggregate.
const WANTED = new Set([
  'http_req_duration',
  'http_req_waiting',
  'vus',
  'iterations',
  'iteration_duration',
  'checks',
  'data_received',
  'data_sent',
]);

function newBucket() {
  return {
    reqs: 0, fails: 0, durSum: 0, hist: new Histogram(),
    vus: null, iters: 0, rx: 0, tx: 0, checksPass: 0, checksFail: 0,
  };
}

export class Aggregator {
  constructor() {
    this.startSec = null;
    this.seconds = new Map(); // epoch second -> bucket
    this.lastPrefix = '';
    this.lastSec = 0;
    this.duration = new Histogram();
    this.waiting = new Histogram();
    this.iterDuration = new Histogram();
    this.endpoints = new Map();
    this.statuses = {};
    this.errors = new Map();
    this.checks = new Map();
    this.totals = { reqs: 0, fails: 0, iters: 0, rx: 0, tx: 0, checksPass: 0, checksFail: 0, maxVus: 0 };
    this.metricDefs = {};
    this.flushedUpTo = null; // last second already sent to live clients
  }

  secOf(time) {
    const prefix = time.slice(0, 19);
    if (prefix !== this.lastPrefix) {
      this.lastPrefix = prefix;
      this.lastSec = Math.floor(Date.parse(time) / 1000);
    }
    return this.lastSec;
  }

  bucket(sec) {
    let b = this.seconds.get(sec);
    if (!b) {
      b = newBucket();
      this.seconds.set(sec, b);
      if (this.startSec === null || sec < this.startSec) this.startSec = sec;
    }
    return b;
  }

  ingestLine(line) {
    if (line.length < 10) return;
    // Fast path: metric name is the first field in k6's JSON output.
    const m = /^\{"metric":"([^"]+)","type":"(Point|Metric)"/.exec(line);
    let name, type;
    if (m) { name = m[1]; type = m[2]; }
    else if (line.startsWith('{"type":"Metric"')) { type = 'Metric'; }
    else return;
    if (type === 'Point' && !WANTED.has(name)) return;

    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type === 'Metric') {
      this.metricDefs[obj.metric] = { type: obj.data.type, contains: obj.data.contains };
      return;
    }
    const d = obj.data;
    const v = d.value;
    const tags = d.tags || {};
    const b = this.bucket(this.secOf(d.time));

    switch (obj.metric) {
      case 'http_req_duration': {
        const failed = tags.expected_response === 'false';
        b.reqs++; b.durSum += v; b.hist.add(v);
        if (failed) b.fails++;
        this.totals.reqs++;
        if (failed) this.totals.fails++;
        this.duration.add(v);

        const key = `${tags.method || ''} ${tags.name || tags.url || ''}`;
        let ep = this.endpoints.get(key);
        if (!ep) {
          ep = { method: tags.method || '', name: tags.name || tags.url || '', group: tags.group || '', count: 0, fails: 0, hist: new Histogram(), statuses: {} };
          this.endpoints.set(key, ep);
        }
        ep.count++; ep.hist.add(v);
        if (failed) ep.fails++;
        const st = tags.status || '0';
        ep.statuses[st] = (ep.statuses[st] || 0) + 1;
        this.statuses[st] = (this.statuses[st] || 0) + 1;

        if (failed) {
          const msg = tags.error || (st === '0' ? 'request failed' : `HTTP ${st}`);
          const ekey = `${tags.error_code || st}|${msg}|${tags.name || tags.url || ''}`;
          const e = this.errors.get(ekey) || { code: tags.error_code || '', status: st, message: msg, endpoint: tags.name || tags.url || '', count: 0 };
          e.count++;
          this.errors.set(ekey, e);
        }
        break;
      }
      case 'http_req_waiting': this.waiting.add(v); break;
      case 'vus':
        b.vus = v;
        if (v > this.totals.maxVus) this.totals.maxVus = v;
        break;
      case 'iterations': b.iters += v; this.totals.iters += v; break;
      case 'iteration_duration': this.iterDuration.add(v); break;
      case 'data_received': b.rx += v; this.totals.rx += v; break;
      case 'data_sent': b.tx += v; this.totals.tx += v; break;
      case 'checks': {
        const cname = tags.check || 'check';
        const c = this.checks.get(cname) || { name: cname, group: tags.group || '', passes: 0, fails: 0 };
        if (v > 0) { c.passes++; b.checksPass++; this.totals.checksPass++; }
        else { c.fails++; b.checksFail++; this.totals.checksFail++; }
        this.checks.set(cname, c);
        break;
      }
    }
  }

  pointFor(sec, b) {
    return {
      t: sec,
      vus: b.vus,
      rps: b.reqs,
      errors: b.fails,
      errRate: b.reqs ? b.fails / b.reqs : 0,
      avg: b.reqs ? b.durSum / b.reqs : null,
      p95: b.reqs ? b.hist.quantile(95) : null,
      p99: b.reqs ? b.hist.quantile(99) : null,
      iters: b.iters,
      rx: b.rx,
      tx: b.tx,
      checksFail: b.checksFail,
    };
  }

  // Seconds that are complete (older than the newest one seen) and not yet flushed.
  takeNewPoints(final = false) {
    const secs = [...this.seconds.keys()].sort((a, b) => a - b);
    if (!secs.length) return [];
    const newest = secs[secs.length - 1];
    const out = [];
    let lastVus = null;
    for (const s of secs) {
      const b = this.seconds.get(s);
      if (b.vus !== null) lastVus = b.vus; else if (lastVus !== null) b.vus = lastVus;
      if (this.flushedUpTo !== null && s <= this.flushedUpTo) continue;
      if (!final && s >= newest) break;
      out.push(this.pointFor(s, b));
      this.flushedUpTo = s;
    }
    return out;
  }

  series() {
    const secs = [...this.seconds.keys()].sort((a, b) => a - b);
    let lastVus = null;
    return secs.map((s) => {
      const b = this.seconds.get(s);
      if (b.vus !== null) lastVus = b.vus; else b.vus = lastVus;
      return this.pointFor(s, b);
    });
  }

  liveTotals() {
    const secs = this.seconds.size;
    return {
      ...this.totals,
      errRate: this.totals.reqs ? this.totals.fails / this.totals.reqs : 0,
      avg: this.duration.count ? this.duration.sum / this.duration.count : 0,
      p95: this.duration.quantile(95),
      elapsed: secs,
    };
  }

  result() {
    const series = this.series();
    const durationSec = series.length ? series[series.length - 1].t - series[0].t + 1 : 0;
    const peakRps = series.reduce((m, p) => Math.max(m, p.rps), 0);
    return {
      startedAt: series.length ? series[0].t * 1000 : null,
      durationSec,
      totals: {
        ...this.totals,
        errRate: this.totals.reqs ? this.totals.fails / this.totals.reqs : 0,
        rps: durationSec ? this.totals.reqs / durationSec : 0,
        peakRps,
        checkRate: (this.totals.checksPass + this.totals.checksFail)
          ? this.totals.checksPass / (this.totals.checksPass + this.totals.checksFail) : null,
      },
      latency: this.duration.stats(),
      ttfb: this.waiting.stats(),
      iterationDuration: this.iterDuration.stats(),
      endpoints: [...this.endpoints.values()]
        .map((e) => ({ method: e.method, name: e.name, group: e.group, count: e.count, fails: e.fails, errRate: e.count ? e.fails / e.count : 0, statuses: e.statuses, ...e.hist.stats(), rps: durationSec ? e.count / durationSec : 0 }))
        .sort((a, b) => b.count - a.count),
      statuses: this.statuses,
      errors: [...this.errors.values()].sort((a, b) => b.count - a.count).slice(0, 100),
      checks: [...this.checks.values()],
      series,
    };
  }
}
