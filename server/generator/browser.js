// Browser journeys deliberately use only built-in k6 APIs.
const quote = (value) => JSON.stringify(String(value ?? ''));
const durationPattern = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;

export function browserConfig(input = {}) {
  const vus = Number(input.vus ?? 2);
  if (!Number.isInteger(vus) || vus < 1 || vus > 100) throw new Error('Browser users must be an integer between 1 and 100. Start with 2–5; Chromium uses substantial CPU and memory.');
  const duration = input.duration || '1m';
  if (!durationPattern.test(duration)) throw new Error('Browser duration must be a duration such as 30s or 5m.');
  const steps = input.steps?.length ? input.steps : [{ action: 'goto', value: '/' }];
  if (steps[0].action !== 'goto') throw new Error('Start the browser journey with a navigation.');
  for (const s of steps) {
    if (!['goto', 'click', 'fill', 'wait', 'assertText'].includes(s.action)) throw new Error(`Unknown browser action: ${s.action}`);
    if (['click', 'fill', 'wait', 'assertText'].includes(s.action) && !s.selector?.trim()) throw new Error(`A selector is required for ${s.action}.`);
    if (s.action === 'goto' && !s.value?.trim()) throw new Error('Navigation requires a URL or path.');
  }
  const lcp = Number(input.lcp ?? 2500);
  if (!Number.isFinite(lcp) || lcp <= 0) throw new Error('LCP threshold must be positive.');
  return { ...input, vus, duration, lcp, steps };
}

export function browserScenario(b) {
  return { executor: 'constant-vus', exec: 'browserJourney', vus: b.vus, duration: b.duration, options: { browser: { type: 'chromium' } } };
}

export function browserJourney(b) {
  const out = [
    'export async function browserJourney() {',
    '  // A fresh context gives each journey isolated cookies and storage.',
    '  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });',
    '  try {',
    '    const page = await context.newPage();',
    "    page.setDefaultTimeout(15000);",
  ];
  b.steps.forEach((s, i) => {
    const locator = `page.locator(${quote(s.selector)})`;
    if (s.action === 'goto') {
      const target = /^https?:\/\//.test(s.value) ? quote(s.value) : `BASE_URL + ${quote('/' + s.value.replace(/^\/+/, ''))}`;
      out.push(`    const navigation${i} = await page.goto(${target}, { waitUntil: 'load', timeout: 30000 });`,
        `    check(navigation${i}, { ${quote(`Navigation ${i + 1}: successful response`)}: r => r !== null && r.status() >= 200 && r.status() < 400 });`);
    }
    if (s.action === 'click') out.push(`    await ${locator}.click();`);
    if (s.action === 'fill') {
      if (/^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/.test(s.value || '')) {
        const key = s.value.slice(2, -2);
        out.push(`    if (!__ENV.${key}) throw new Error(${quote(`Supply ${key} in run environment variables`)});`, `    await ${locator}.fill(__ENV.${key});`);
      } else out.push(`    await ${locator}.fill(${quote(s.value)});`);
    }
    if (s.action === 'wait') out.push(`    await ${locator}.waitFor({ state: 'visible' });`);
    if (s.action === 'assertText') out.push(`    const text${i} = await ${locator}.textContent();`, `    check(text${i}, { ${quote(`${s.selector}: contains ${s.value}`)}: text => typeof text === 'string' && text.includes(${quote(s.value)}) });`);
  });
  out.push('  } finally {', '    await context.close();', '  }', '}', '');
  return out.join('\n');
}
