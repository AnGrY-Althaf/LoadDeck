// Client for POST /api/ai/generate, which answers with a server-sent-event stream.
// handlers: { status, thinking, text, text_start, done, error }
export async function streamAi(body, handlers, signal) {
  let res;
  try {
    res = await fetch('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) return;
    handlers.error?.({ message: `Could not reach LoadDeck: ${e.message}` });
    return;
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    handlers.error?.({ message: j.error || `HTTP ${res.status}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!ev || data == null) continue;
        if (ev === 'done' || ev === 'error') finished = true;
        handlers[ev]?.(JSON.parse(data));
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    handlers.error?.({ message: `Connection lost: ${e.message}` });
    return;
  }
  if (!finished && !signal?.aborted) handlers.error?.({ message: 'The generation stopped unexpectedly.' });
}

export function usageText(u) {
  if (!u) return '';
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(u.input)} input / ${k(u.output)} output tokens`;
}

// Provider picker: lists configured providers; remembers the last choice per browser.
export function providerPicker(info, id = 'aiprov') {
  const list = (info?.ai?.providers || []).filter((p) => p.configured);
  if (!list.length) return '';
  let pick = info.ai.active;
  try { const saved = localStorage.getItem('ld-ai-provider'); if (saved && list.some((p) => p.id === saved)) pick = saved; } catch { /* ignore */ }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<select id="${id}" style="width:auto;max-width:340px" title="AI provider and model (change models in Settings)">${list.map((p) => `<option value="${p.id}" ${p.id === pick ? 'selected' : ''}>${esc(p.label)} · ${esc(p.model)}</option>`).join('')}</select>`;
}
export function rememberProvider(id) { try { localStorage.setItem('ld-ai-provider', id); } catch { /* ignore */ } }
