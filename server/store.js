// Plain-file storage under ./data so everything is easy to back up, diff or delete.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = process.env.LOADDECK_DATA || path.join(ROOT, 'data');
const SCRIPTS = path.join(DATA, 'scripts');
const RUNS = path.join(DATA, 'runs');
const SETTINGS = path.join(DATA, 'settings.json');

for (const d of [DATA, SCRIPTS, RUNS]) fs.mkdirSync(d, { recursive: true });

const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
export function safeId(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('invalid id'), { status: 400 });
  return id;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(prefix) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  k6Path: 'k6',
  keepRawData: false,
  maxConcurrentRuns: 3,
  // AI providers: { active: 'openai', providers: { openai: { apiKey, model, baseUrl, maxTokens } } }
  ai: { active: '', providers: {} },
};
export function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS, {}) };
  s.ai = { active: s.ai?.active || '', providers: { ...(s.ai?.providers || {}) } };
  // Migrate the single Claude key used by earlier versions.
  if (s.anthropicApiKey && !s.ai.providers.anthropic?.apiKey) {
    s.ai.providers.anthropic = { ...(s.ai.providers.anthropic || {}), apiKey: s.anthropicApiKey };
  }
  delete s.anthropicApiKey;
  return s;
}
// Settings safe to send to the browser: API keys never leave the server.
export function publicSettings() {
  const { ai, ...rest } = getSettings();
  return rest;
}
export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJson(SETTINGS, s);
  try { fs.chmodSync(SETTINGS, 0o600); } catch { /* best effort */ }
  return s;
}
export function updateAiProvider(id, patch) {
  const s = getSettings();
  const cur = { ...(s.ai.providers[id] || {}) };
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) cur.apiKey = patch.apiKey.trim();
  if (patch.clearKey === true) delete cur.apiKey;
  for (const k of ['model', 'baseUrl', 'maxTokens']) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] ?? '').trim();
    if (v) cur[k] = v; else delete cur[k];
  }
  s.ai.providers[id] = cur;
  if (patch.makeActive) s.ai.active = id;
  return saveSettings({ ai: s.ai });
}
export function setActiveAiProvider(id) {
  const s = getSettings();
  s.ai.active = id;
  return saveSettings({ ai: s.ai });
}

// ---------- scripts ----------
export function listScripts() {
  return fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(SCRIPTS, f)))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getScript(id) {
  safeId(id);
  const meta = readJson(path.join(SCRIPTS, `${id}.json`));
  if (!meta) return null;
  const code = fs.readFileSync(path.join(SCRIPTS, `${id}.js`), 'utf8');
  return { ...meta, code };
}
export function saveScript({ id, name, description = '', code, source = 'manual', generator = null }) {
  const now = Date.now();
  const existing = id ? getScript(id) : null;
  const sid = existing ? existing.id : newId('s');
  const meta = {
    id: sid,
    name: name || existing?.name || 'Untitled script',
    description,
    source: existing?.source || source,
    generator: generator ?? existing?.generator ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(SCRIPTS, `${sid}.js`), code ?? '');
  writeJson(path.join(SCRIPTS, `${sid}.json`), meta);
  return { ...meta, code };
}
export function deleteScript(id) {
  safeId(id);
  for (const ext of ['.js', '.json']) fs.rmSync(path.join(SCRIPTS, id + ext), { force: true });
}

// ---------- runs ----------
export function runDir(id) { return path.join(RUNS, safeId(id)); }
export function createRunDir(id) { const d = runDir(id); fs.mkdirSync(d, { recursive: true }); return d; }
export function saveRunMeta(meta) { writeJson(path.join(runDir(meta.id), 'meta.json'), meta); }
export function getRunMeta(id) { return readJson(path.join(runDir(id), 'meta.json')); }
export function saveRunReport(id, report) { writeJson(path.join(runDir(id), 'report.json'), report); }
export function getRunReport(id) { return readJson(path.join(runDir(id), 'report.json')); }
export function listRuns() {
  return fs.readdirSync(RUNS)
    .map((d) => readJson(path.join(RUNS, d, 'meta.json')))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function deleteRun(id) { fs.rmSync(runDir(id), { recursive: true, force: true }); }
export function readRunFile(id, name) {
  const p = path.join(runDir(id), path.basename(name));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
