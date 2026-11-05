// AI provider registry. Claude uses the Anthropic SDK; every other provider is reached
// through the OpenAI-compatible Chat Completions API that they all expose.
import Anthropic from '@anthropic-ai/sdk';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', kind: 'anthropic', defaultModel: 'claude-opus-5-5', env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'], keyUrl: 'https://platform.openai.com/api-keys', usageInStream: true, noMaxTokens: true },
  gemini: { label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyUrl: 'https://aistudio.google.com/apikey' },
  nvidia: { label: 'NVIDIA NIM', kind: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', env: ['NVIDIA_API_KEY'], keyUrl: 'https://build.nvidia.com' },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], keyUrl: 'https://console.groq.com/keys' },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'], keyUrl: 'https://openrouter.ai/keys' },
  mistral: { label: 'Mistral AI', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'], keyUrl: 'https://console.mistral.ai/api-keys' },
  deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', env: ['DEEPSEEK_API_KEY'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  together: { label: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'], keyUrl: 'https://api.together.ai/settings/api-keys' },
  xai: { label: 'xAI Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', env: ['XAI_API_KEY'], keyUrl: 'https://console.x.ai' },
  ollama: { label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', env: [], noKey: true },
  custom: { label: 'Custom OpenAI-compatible', kind: 'openai', baseUrl: '', env: ['CUSTOM_AI_API_KEY'], keyOptional: true, customBase: true },
};

const DEFAULT_MAX_TOKENS = 8192;

export function providerConfig(settings, id) {
  const def = PROVIDERS[id];
  const cfg = settings.ai?.providers?.[id] || {};
  const envKey = def.env.map((e) => process.env[e]).find(Boolean) || '';
  return {
    id,
    ...def,
    apiKey: cfg.apiKey || envKey,
    keySource: cfg.apiKey ? 'settings' : envKey ? 'env' : '',
    model: cfg.model || def.defaultModel || '',
    baseUrl: (cfg.baseUrl || def.baseUrl || '').replace(/\/+$/, ''),
    maxTokens: cfg.maxTokens ? parseInt(cfg.maxTokens, 10) : null,
  };
}

export function isConfigured(c) {
  if (!c.model) return false;
  if (c.kind === 'openai' && !c.baseUrl) return false;
  return c.noKey || c.keyOptional || !!c.apiKey;
}

// Public view for the browser: never includes the key itself.
export function publicProviders(settings) {
  return Object.keys(PROVIDERS).map((id) => {
    const c = providerConfig(settings, id);
    return {
      id, label: c.label, kind: c.kind, model: c.model, baseUrl: c.baseUrl, defaultBaseUrl: PROVIDERS[id].baseUrl || '',
      maxTokens: c.maxTokens || '', keyUrl: c.keyUrl || '', noKey: !!c.noKey, keyOptional: !!c.keyOptional, customBase: !!c.customBase,
      keySet: !!c.apiKey, keySource: c.keySource, keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : '', envVars: c.env,
      configured: isConfigured(c),
    };
  });
}

export function activeProviderId(settings) {
  const want = settings.ai?.active;
  if (want && PROVIDERS[want]) return want;
  return Object.keys(PROVIDERS).find((id) => isConfigured(providerConfig(settings, id))) || 'anthropic';
}

// ---------- errors ----------
export class ProviderError extends Error {}

function httpError(c, status, body) {
  let msg = body;
  try { const j = JSON.parse(body); msg = j.error?.message || j.message || j.detail || (Array.isArray(j) && j[0]?.error?.message) || body; } catch { /* plain text */ }
  msg = String(msg).slice(0, 400);
  if (status === 401 || status === 403) return new ProviderError(`${c.label} rejected the API key (${status}). Check it in Settings → AI providers. ${msg}`);
  if (status === 404) return new ProviderError(`${c.label}: model or endpoint not found (404) — check the model name "${c.model}". ${msg}`);
  if (status === 429) return new ProviderError(`${c.label} rate limit or quota reached (429). ${msg}`);
  if (status === 400 && /max_tokens|max tokens|maximum/i.test(msg)) return new ProviderError(`${c.label} rejected the output length: ${msg} — lower "Max output tokens" for this provider in Settings.`);
  return new ProviderError(`${c.label} error ${status}: ${msg}`);
}

function anthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError('Claude rejected the API key. Check it in Settings → AI providers or the ANTHROPIC_API_KEY variable.');
  if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Claude API permission denied: ${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return new ProviderError(`Claude model not found: ${e.message}`);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('Claude API rate limit reached — wait a moment and try again.');
  if (e instanceof Anthropic.BadRequestError) return new ProviderError(`Claude API rejected the request: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('Could not reach the Claude API. Check your internet connection or proxy.');
  if (e instanceof Anthropic.APIError) return new ProviderError(`Claude API error ${e.status ?? ''}: ${e.message}`);
  if (/authentication|apiKey|api key/i.test(e?.message || '')) return new ProviderError('No Claude API key configured. Add one in Settings → AI providers.');
  return e;
}

// ---------- model listing ----------
export async function listModels(c, signal) {
  if (c.kind === 'anthropic') {
    try {
      const client = new Anthropic(c.apiKey ? { apiKey: c.apiKey } : {});
      const ids = [];
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
      return ids;
    } catch (e) { throw anthropicError(e); }
  }
  if (!c.baseUrl) throw new ProviderError('Set the base URL first.');
  let res;
  try {
    res = await fetch(`${c.baseUrl}/models`, { headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}, signal });
  } catch (e) { throw new ProviderError(`Could not reach ${c.label} at ${c.baseUrl}: ${e.cause?.code || e.message}`); }
  const body = await res.text();
  if (!res.ok) throw httpError(c, res.status, body);
  let j;
  try { j = JSON.parse(body); } catch { throw new ProviderError(`${c.label} returned an unexpected model list.`); }
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).map((id) => id.replace(/^models\//, '')).sort();
}

// ---------- one model turn ----------
// history: [{ role: 'user'|'assistant', content }] where assistant content may be the
// provider's raw block list (Anthropic) so thinking blocks are passed back unchanged.
// Returns { text, raw, stop: 'end'|'length'|'refusal', usage: {input, output, cacheRead}, model, refusalText }
export async function runTurn(c, { system, history, emit, signal }) {
  return c.kind === 'anthropic' ? anthropicTurn(c, { system, history, emit, signal }) : openaiTurn(c, { system, history, emit, signal });
}

async function anthropicTurn(c, { system, history, emit, signal }) {
  try {
    const client = new Anthropic(c.apiKey ? { apiKey: c.apiKey } : {});
    const stream = client.beta.messages.stream({
      model: c.model,
      max_tokens: c.maxTokens || 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      // Server-side fallback: if a safety classifier declines, the API retries on Anthropic's recommended model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: history,
    }, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') emit('text', { text: event.delta.text });
        else if (event.delta.type === 'thinking_delta') emit('thinking', { text: event.delta.thinking });
      }
    }
    const final = await stream.finalMessage();
    return {
      text: final.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      raw: final.content,
      stop: final.stop_reason === 'refusal' ? 'refusal' : final.stop_reason === 'max_tokens' ? 'length' : 'end',
      refusalText: final.stop_details?.explanation || '',
      usage: { input: final.usage?.input_tokens || 0, output: final.usage?.output_tokens || 0, cacheRead: final.usage?.cache_read_input_tokens || 0 },
      model: final.model,
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    throw anthropicError(e);
  }
}

async function openaiTurn(c, { system, history, emit, signal }) {
  const body = {
    model: c.model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content) }))],
  };
  const maxTokens = c.maxTokens || (c.noMaxTokens ? null : DEFAULT_MAX_TOKENS);
  if (maxTokens) body.max_tokens = maxTokens;
  if (c.usageInStream) body.stream_options = { include_usage: true };
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
  if (c.id === 'openrouter') { headers['HTTP-Referer'] = 'http://localhost'; headers['X-Title'] = 'LoadDeck'; }

  let res;
  try {
    res = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ProviderError(`Could not reach ${c.label} at ${c.baseUrl}: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw httpError(c, res.status, await res.text());

  let text = '', finish = null, model = c.model;
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    // Some servers ignore stream:true and answer with one JSON object.
    const j = await res.json();
    const ch = j.choices?.[0];
    text = ch?.message?.content || '';
    if (ch?.message?.reasoning_content) emit('thinking', { text: ch.message.reasoning_content });
    if (text) emit('text', { text });
    finish = ch?.finish_reason;
    usage.input = j.usage?.prompt_tokens || 0; usage.output = j.usage?.completion_tokens || 0;
    return { text, raw: text, stop: finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'end', usage, model: j.model || model };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ProviderError(`${c.label}: ${j.error.message || JSON.stringify(j.error)}`);
      if (j.model) model = j.model;
      if (j.usage) { usage.input = j.usage.prompt_tokens || usage.input; usage.output = j.usage.completion_tokens || usage.output; }
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) emit('thinking', { text: reasoning });
      if (typeof d.content === 'string' && d.content) { text += d.content; emit('text', { text: d.content }); }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  // Some reasoning models inline their reasoning in <think> tags; keep it out of the script.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  return { text, raw: text, stop: finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'end', usage, model };
}
