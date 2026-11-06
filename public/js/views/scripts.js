import { api, esc, badge, relTime, toast, confirmDialog } from '../ui.js';
import { openRunDialog } from './run-dialog.js';

const SOURCE = { ai: '✦ AI', manual: 'Hand-written', builder: 'Builder', url: 'URL', curl: 'cURL', har: 'HAR recording', openapi: 'OpenAPI', postman: 'Postman' };

export default async function scripts(el) {
  let list = await api('/api/scripts');
  const draw = (filter = '') => {
    const f = filter.toLowerCase();
    const shown = list.filter((s) => !f || s.name.toLowerCase().includes(f) || (s.description || '').toLowerCase().includes(f));
    el.querySelector('#slist').innerHTML = shown.length ? shown.map((s) => `
      <div class="list-row" data-id="${s.id}">
        <div class="grow" style="min-width:0">
          <a class="name" href="#/scripts/${s.id}">${esc(s.name)}</a> <span class="pill">${esc(SOURCE[s.source] || s.source)}</span>
          <div class="muted small">${s.description ? esc(s.description) + ' · ' : ''}updated ${relTime(s.updatedAt)} · ${s.runCount} run${s.runCount === 1 ? '' : 's'}</div>
        </div>
        ${s.lastRun ? `<a href="#/runs/${s.lastRun.id}" title="Last run">${badge(s.lastRun.status)}</a>` : '<span class="muted small">never run</span>'}
        <div class="row">
          <button class="btn sm primary" data-a="run">▶ Run</button>
          <a class="btn sm" href="#/scripts/${s.id}">Edit</a>
          ${s.generator ? `<a class="btn sm" href="#/generate/${s.id}" title="Edit with the visual generator">Builder</a>` : ''}
          <button class="btn sm ghost" data-a="dup" title="Duplicate">⧉</button>
          <button class="btn sm ghost danger" data-a="del" title="Delete">✕</button>
        </div>
      </div>`).join('')
      : `<div class="empty"><h3>${list.length ? 'No matching scripts' : 'No scripts yet'}</h3><p>Generate one from a URL, cURL, HAR, OpenAPI or Postman — or write it by hand.</p>
         <div class="row" style="justify-content:center"><a class="btn primary" href="#/generate">✦ Generate</a><a class="btn" href="#/scripts/new">Write by hand</a></div></div>`;
  };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Scripts</h1><p>Your k6 test scripts. Each run keeps a snapshot of the script it used.</p></div>
      <div class="row"><input type="text" id="q" aria-label="Search scripts" placeholder="Search scripts…" style="width:200px">
        <a class="btn" href="#/scripts/new">New script</a><a class="btn primary" href="#/generate">✦ Generate</a></div>
    </div>
    <div class="list" id="slist"></div>`;
  draw();
  el.querySelector('#q').addEventListener('input', (e) => draw(e.target.value));
  el.querySelector('#slist').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-a]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    const s = list.find((x) => x.id === id);
    if (btn.dataset.a === 'run') openRunDialog(s);
    if (btn.dataset.a === 'dup') { await api(`/api/scripts/${id}/duplicate`, { method: 'POST' }); list = await api('/api/scripts'); draw(el.querySelector('#q').value); toast('Script duplicated'); }
    if (btn.dataset.a === 'del' && await confirmDialog('Delete script?', `"${s.name}" will be deleted. Past runs and their reports are kept.`)) {
      await api(`/api/scripts/${id}`, { method: 'DELETE' });
      list = list.filter((x) => x.id !== id);
      draw(el.querySelector('#q').value);
      toast('Script deleted');
    }
  });
}
