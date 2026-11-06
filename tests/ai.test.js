import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateScript } from '../server/generator/ai.js';

test('AI repairs a k6-valid script whose execution plan does not match hybrid mode', async t => {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'local-fixture', choices: [{ message: { content: '```javascript\nimport http from "k6/http";\nexport default function () {}\n```\n- Supply your actual API contract.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const events = [];
  let validations = 0;
  await generateScript({ prompt: 'Verify checkout while the API is under load', engine: 'hybrid', provider: 'custom', browser: { vus: 2 } }, {
    settings: { ai: { active: 'custom', providers: { custom: { model: 'local-fixture', baseUrl: `http://127.0.0.1:${mock.address().port}` } } } },
    validate: async () => ({ ok: true, options: ++validations === 1 ? { scenarios: { api: { executor: 'constant-vus' } }, thresholds: { checks: [] } } : { scenarios: { api: { executor: 'constant-vus' }, browser: { options: { browser: { type: 'chromium' } } } }, thresholds: { browser_web_vital_lcp: [] } } }),
    emit: (event, data) => events.push({ event, data }), signal: new AbortController().signal,
  });
  assert.equal(requests.length, 2);
  assert(requests[0].messages[1].content.includes('Required test type: hybrid'));
  assert(requests[1].messages.at(-1).content.includes('Chromium browser scenario'));
  assert(events.some(e => e.event === 'status' && e.data.phase === 'repairing'));
  const done = events.find(e => e.event === 'done').data;
  assert.equal(done.valid, true);
  assert.equal(done.attempts, 2);
  assert.equal(done.usage.output, 40);
  assert(done.notes.includes('smoke test'));
});
