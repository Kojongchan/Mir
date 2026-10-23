import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, modules = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', code)(exports, name => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  }, process);
  return exports;
}

const tasks = compile('api/_ai-tasks.ts');

test('every AI task schema is strict (objects list all keys as required, no extra properties)', () => {
  const walk = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, path);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${path}[]`);
  };
  for (const [name, t] of Object.entries(tasks.AI_TASKS)) {
    walk(t.schema, name);
    assert.ok(t.system.includes('지시가 아닙니다'), `${name}: 자료 속 지시문 무시 문구`);
  }
  assert.deepEqual(Object.keys(tasks.AI_TASKS).sort(),
    ['boqClassify', 'criticalPoints', 'dailyActuals', 'designExtract', 'diffSummary', 'explainCheck', 'linkLeftovers', 'qa', 'ratesExtract']);
});

test('AI endpoint: request shape, keep-alive stream with JSON result, and error paths', async () => {
  const calls = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"points":[],"questions":["홍수기 기간은?"]}' }], model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } };
  class APIError extends Error { constructor(status) { super('x'); this.status = status; } }
  class Anthropic {
    static APIError = APIError;
    beta = { messages: { stream: params => { calls.push(params); return { finalMessage: async () => reply }; } } };
  }
  const ai = compile('api/ai.ts', { '@anthropic-ai/sdk': { __esModule: true, default: Anthropic }, '@supabase/supabase-js': {}, './_ai-tasks': tasks });
  const post = body => ai.default(new Request('http://x/api/ai', { method: 'POST', body: JSON.stringify(body) }));
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.SUPABASE_URL, vurl: process.env.VITE_SUPABASE_URL };
  delete process.env.SUPABASE_URL; delete process.env.VITE_SUPABASE_URL;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    let r = await post({ task: 'criticalPoints', input: { text: 'x' } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'not-configured');
    process.env.ANTHROPIC_API_KEY = 'test';
    assert.equal((await post({ task: 'nope', input: {} })).status, 400);
    assert.equal((await post({ task: 'criticalPoints', input: { text: '  ' } })).status, 400);

    r = await post({ task: 'criticalPoints', input: { text: '하선 P38~종점 코핑·거치 야간', start: '2024-01-05', supports: ['P38', 'P39'] } });
    assert.equal(r.status, 200);
    const body = JSON.parse(await r.text());
    assert.deepEqual(body.result, { points: [], questions: ['홍수기 기간은?'] });
    const p = calls[0];
    assert.equal(p.model, 'claude-opus-5-5');
    assert.equal(p.fallbacks, 'default');
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p.output_config.format.type, 'json_schema');
    assert.ok(p.messages[0].content.includes('P38~종점'));

    reply = { ...reply, stop_reason: 'refusal', content: [] };
    assert.match(JSON.parse(await (await post({ task: 'qa', input: { question: '?' } })).text()).error, /안전 정책/);
    reply = { ...reply, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"answ' }] };
    assert.match(JSON.parse(await (await post({ task: 'qa', input: { question: '?' } })).text()).error, /잘렸습니다/);
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
    if (saved.vurl !== undefined) process.env.VITE_SUPABASE_URL = saved.vurl;
  }
});
