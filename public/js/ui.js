export { esc, fmt, badge } from './report-view.js';
import { esc } from './report-view.js';

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}

export function modal(title, bodyHtml, { okText = 'OK', cancelText = 'Cancel', danger = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><div class="mb">${bodyHtml}</div>
      <div class="foot">${cancelText ? `<button class="btn" data-a="cancel">${esc(cancelText)}</button>` : ''}<button class="btn ${danger ? 'danger solid' : 'primary'}" data-a="ok">${esc(okText)}</button></div></div>`;
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); bg.querySelector('[data-a=ok]').click(); } };
    bg.addEventListener('click', (e) => {
      if (e.target === bg) close(null);
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close(null);
      if (a === 'ok') close(bg.querySelector('.mb'));
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    onOpen?.(bg.querySelector('.mb'));
    (bg.querySelector('.mb input, .mb textarea') || bg.querySelector('[data-a=ok]')).focus();
  });
}

export const confirmDialog = (title, text, okText = 'Delete') => modal(title, `<p>${esc(text)}</p>`, { okText, danger: true }).then(Boolean);

export function prompt(title, label, value = '') {
  return modal(title, `<label class="f">${esc(label)}<input type="text" id="pv" value="${esc(value)}"></label>`, { okText: 'Save' })
    .then((el) => (el ? el.querySelector('#pv').value.trim() : null));
}

export function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Parse "KEY=value" lines into an object (used for env vars and tags).
export function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
export const kvText = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join('\n');

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('ld-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ld-' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
