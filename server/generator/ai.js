// AI script generation. Works with any configured provider (Claude, OpenAI, Gemini, NVIDIA, …):
// streams progress, validates the result with `k6 inspect`, and feeds k6's error back to the
// model to fix (up to MAX_ATTEMPTS) if the script is rejected.
import { PROVIDERS, providerConfig, isConfigured, activeProviderId, runTurn, ProviderError } from './providers.js';

const MAX_ATTEMPTS = 3;

const SYSTEM = `You write k6 load-testing scripts for LoadDeck, a GUI that runs scripts with the k6 CLI (k6 v1+/v2, ES modules).

Write scripts that run unmodified with \`k6 run script.js\`:
- Use only k6 built-in modules (k6, k6/http, k6/data, k6/execution, k6/metrics, k6/encoding, k6/crypto, k6/ws). Remote jslib imports may not be reachable from the user's machine, so avoid them unless the request truly needs one. Node.js APIs and npm packages are not available.
- Read the target from \`const BASE_URL = __ENV.BASE_URL || '<default>'\` and take secrets (tokens, passwords) from __ENV with placeholder defaults, never hard-coded real credentials.
- Give every request \`tags: { name: '<short readable name>' }\` so reports group dynamic URLs, and add \`check()\` calls that verify status and, where useful, response content.
- Model the load the user describes with \`options.scenarios\` (ramping-vus, constant-arrival-rate, ramping-arrival-rate, etc.) and add thresholds that turn the run into a pass/fail verdict (p95/p99 latency, http_req_failed, checks). If the user gives no numbers, choose modest, safe defaults (for example a short ramp to 10–20 VUs).
- Use group() for multi-step journeys, chain values between requests (tokens, ids) via res.json(...), add realistic think time with sleep(), and use SharedArray for test data.
- Keep comments brief and useful.

Reply with exactly one \`\`\`javascript fenced block containing the complete script, followed by at most four short bullet points listing assumptions the user should check (endpoints you guessed, payload shapes, credentials to supply via environment variables). No other prose.`;

function userPrompt({ prompt, baseUrl, reference, currentCode, loadHint }) {
  const parts = [];
  if (currentCode) {
    parts.push(`Here is the current k6 script:\n\n\`\`\`javascript\n${currentCode}\n\`\`\``);
    parts.push(`Change it as follows, keeping everything else intact, and return the complete updated script:\n\n${prompt}`);
  } else {
    parts.push(`Write a k6 load test for this:\n\n${prompt}`);
  }
  if (baseUrl) parts.push(`Base URL of the system under test: ${baseUrl}`);
  if (loadHint) parts.push(`Load profile and SLAs to use (from the LoadDeck UI):\n${loadHint}`);
  if (reference) parts.push(`Reference material provided by the user (API docs, spec, sample requests):\n\n<reference>\n${reference}\n</reference>`);
  return parts.join('\n\n');
}

export function extractScript(text) {
  const fences = [...text.matchAll(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/g)];
  if (fences.length) {
    const code = fences.sort((a, b) => b[1].length - a[1].length)[0][1].trim() + '\n';
    const notes = text.replace(/```(?:javascript|js|typescript|ts)?\s*\n[\s\S]*?```/g, '').trim();
    return { code, notes };
  }
  // No fence: accept the reply as code only if it looks like a k6 script.
  if (/from\s+['"]k6/.test(text)) return { code: text.trim() + '\n', notes: '' };
  return { code: '', notes: text.trim() };
}

export function aiConfigured(settings) {
  return Object.keys(PROVIDERS).some((id) => isConfigured(providerConfig(settings, id)));
}

/**
 * @param input  { prompt, baseUrl?, reference?, currentCode?, loadHint?, provider? }
 * @param ctx    { settings, validate(code) -> {ok, error}, emit(event, data), signal }
 */
export async function generateScript(input, { settings, validate, emit, signal }) {
  const id = input.provider && PROVIDERS[input.provider] ? input.provider : activeProviderId(settings);
  const c = providerConfig(settings, id);
  if (input.model) c.model = String(input.model);
  if (!isConfigured(c)) {
    emit('error', { message: `${c.label} is not set up yet. Add ${c.noKey ? 'a model' : 'an API key and model'} in Settings → AI providers.` });
    return;
  }
  emit('provider', { id, label: c.label, model: c.model });

  const history = [{ role: 'user', content: userPrompt(input) }];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let last = { code: '', notes: '', error: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    emit('status', { phase: 'generating', attempt });
    let r;
    try {
      r = await runTurn(c, { system: SYSTEM, history, emit, signal });
    } catch (e) {
      if (signal?.aborted) { emit('error', { message: 'Cancelled.' }); return; }
      emit('error', { message: e instanceof ProviderError ? e.message : `${c.label}: ${e.message}` });
      return;
    }
    usage.input += r.usage.input; usage.output += r.usage.output; usage.cacheRead += r.usage.cacheRead;

    if (r.stop === 'refusal') {
      emit('error', { message: `${c.label} declined this request${r.refusalText ? `: ${r.refusalText}` : '.'} Try rephrasing the description.` });
      return;
    }
    const { code, notes } = extractScript(r.text);
    if (!code) {
      emit('error', { message: r.stop === 'length' ? `The response was cut off before the script was complete. Raise "Max output tokens" for ${c.label} in Settings, or ask for a narrower test.` : `The model did not return a script. ${notes.slice(0, 400)}` });
      return;
    }

    emit('status', { phase: 'validating', attempt });
    const v = await validate(code);
    last = { code, notes, error: v.ok ? null : v.error };
    if (v.ok) {
      emit('done', { code, notes, valid: true, attempts: attempt, usage, provider: c.label, model: r.model || c.model, options: v.options });
      return;
    }
    if (attempt === MAX_ATTEMPTS) break;
    emit('status', { phase: 'repairing', attempt, error: v.error });
    // Append-only history: keep the full assistant turn (Claude's thinking blocks included) and add the feedback.
    history.push({ role: 'assistant', content: r.raw });
    history.push({ role: 'user', content: `k6 rejected the script when loading it:\n\n${v.error}\n\nFix the problem and return the complete corrected script in the same format.` });
  }
  emit('done', { code: last.code, notes: last.notes, valid: false, error: last.error, attempts: MAX_ATTEMPTS, usage, provider: c.label, model: c.model });
}
