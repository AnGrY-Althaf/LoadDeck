import { api, esc, fmt } from './ui.js';
import dashboard from './views/dashboard.js';
import scripts from './views/scripts.js';
import editor from './views/editor.js';
import generator from './views/generator.js';
import runs from './views/runs.js';
import run from './views/run.js';
import compare from './views/compare.js';
import settings from './views/settings.js';

export const app = { info: null, cleanup: null };

const ROUTES = [
  [/^\/$/, dashboard, 'dashboard'],
  [/^\/scripts$/, scripts, 'scripts'],
  [/^\/scripts\/new$/, editor, 'scripts'],
  [/^\/scripts\/([\w-]+)$/, editor, 'scripts'],
  [/^\/generate$/, generator, 'generate'],
  [/^\/generate\/([\w-]+)$/, generator, 'generate'],
  [/^\/runs$/, runs, 'runs'],
  [/^\/runs\/([\w-]+)$/, run, 'runs'],
  [/^\/compare$/, compare, 'compare'],
  [/^\/settings$/, settings, 'settings'],
];

export function navigate(hash) { location.hash = hash; }

// Views can register a guard (e.g. unsaved changes) that may cancel navigation.
let leaveGuard = null;
export function setLeaveGuard(fn) { leaveGuard = fn; }
let currentHash = location.hash;

async function render() {
  const hash = location.hash.slice(1) || '/';
  if (leaveGuard && !leaveGuard()) { history.replaceState(null, '', currentHash || '#/'); return; }
  leaveGuard = null;
  currentHash = location.hash;
  const [pathPart, queryPart] = hash.split('?');
  const query = new URLSearchParams(queryPart || '');
  if (app.cleanup) { try { app.cleanup(); } catch { /* ignore */ } app.cleanup = null; }
  const view = document.getElementById('view');
  for (const [re, fn, nav] of ROUTES) {
    const m = re.exec(pathPart);
    if (!m) continue;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
    view.innerHTML = '';
    window.scrollTo(0, 0);
    try {
      const cleanup = await fn(view, { params: m.slice(1), query });
      if (typeof cleanup === 'function') app.cleanup = cleanup;
    } catch (e) {
      view.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p><a class="btn" href="#/">Back to dashboard</a></div>`;
      console.error(e);
    }
    return;
  }
  view.innerHTML = '<div class="empty"><h3>Page not found</h3><a href="#/">Go to dashboard</a></div>';
}

async function refreshInfo() {
  try {
    app.info = await api('/api/info');
    const v = document.getElementById('k6v');
    v.textContent = app.info.k6Version || '⚠ k6 not found — check Settings';
    v.classList.toggle('bad', !app.info.k6Version);
    renderActive(app.info.active || []);
  } catch { /* server down */ }
}

function renderActive(active) {
  const el = document.getElementById('active-runs');
  const running = active.filter((r) => r.status === 'running');
  el.innerHTML = running.map((r) => `<a href="#/runs/${r.id}"><b>● Running</b> · ${esc(r.scriptName)}<br><span class="muted small">${fmt.dur((Date.now() - r.createdAt) / 1000)}</span></a>`).join('');
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ld-theme', root.dataset.theme); } catch { /* ignore */ }
  window.dispatchEvent(new Event('themechange'));
});
window.addEventListener('beforeunload', (e) => { if (leaveGuard && !leaveGuard(true)) { e.preventDefault(); e.returnValue = ''; } });

window.addEventListener('hashchange', render);
await refreshInfo();
setInterval(refreshInfo, 4000);
render();
