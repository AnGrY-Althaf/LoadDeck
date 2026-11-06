// Validate the execution plan returned by k6, rather than claiming syntax proves correctness.
export function generationIssues(options = {}, engine = '') {
  const issues = [];
  const scenarios = Object.values(options?.scenarios || {});
  const browser = scenarios.some(s => s.options?.browser?.type === 'chromium');
  const api = scenarios.some(s => !s.options?.browser);
  const thresholds = options?.thresholds || {};
  if (['browser', 'hybrid'].includes(engine) && !browser) issues.push('The selected test type requires a Chromium browser scenario.');
  if (engine === 'hybrid' && !api) issues.push('Hybrid tests need a separate API load scenario alongside the browser scenario.');
  if (engine === 'http' && browser) issues.push('The selected API test type must use protocol scenarios.');
  if (!Object.keys(thresholds).length) issues.push('Add meaningful pass/fail thresholds; script loading alone does not verify application behaviour.');
  if (scenarios.some(s => /arrival-rate$/.test(s.executor)) && !Object.keys(thresholds).some(k => k.startsWith('dropped_iterations'))) {
    issues.push('Add dropped_iterations count==0 so an arrival-rate test cannot pass without delivering its scheduled load.');
  }
  if (engine === 'browser' && Object.keys(thresholds).some(k => k.startsWith('http_req_'))) issues.push('Browser-only scripts require browser metrics, rather than protocol HTTP thresholds.');
  if (browser && !Object.keys(thresholds).some(k => k.startsWith('browser_web_vital_'))) issues.push('Add browser web vital thresholds to measure the rendered application.');
  return issues;
}
