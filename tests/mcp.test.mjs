import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', code)(exports, name => { throw new Error(`unexpected import ${name}`); }, process);
  return exports;
}
const T = compile('api/_mcp-token.ts');

test('MCP connection token: signed, scoped to user+project, expires, tamper-proof', async () => {
  const exp = Date.now() + 60_000;
  const tok = await T.signMcpToken({ u: 'user-1', p: 'proj-1', exp }, 's1');
  assert.match(tok, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'URL 경로에 그대로 들어가는 글자만');
  assert.deepEqual(await T.verifyMcpToken(tok, 's1'), { u: 'user-1', p: 'proj-1', exp });
  assert.equal(await T.verifyMcpToken(tok, 's2'), null, '다른 비밀값');
  assert.equal(await T.verifyMcpToken(tok, 's1', exp + 1), null, '만료');
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', p: 'proj-1', exp })).toString('base64url');
  assert.equal(await T.verifyMcpToken(`${forged}.${sig}`, 's1'), null, '내용 바꿔치기');
  assert.equal(await T.verifyMcpToken(`${body}.${sig}.x`, 's1'), null);
  assert.equal(await T.verifyMcpToken('garbage', 's1'), null);
});

test('MCP token secret: own secret first, else derived from the service role key, else none', () => {
  const saved = { a: process.env.MCP_TOKEN_SECRET, b: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    delete process.env.MCP_TOKEN_SECRET; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(T.mcpSecret(), null);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'role';
    assert.equal(T.mcpSecret(), 'mir-mcp-v1:role');
    process.env.MCP_TOKEN_SECRET = 'own';
    assert.equal(T.mcpSecret(), 'own');
  } finally {
    if (saved.a === undefined) delete process.env.MCP_TOKEN_SECRET; else process.env.MCP_TOKEN_SECRET = saved.a;
    if (saved.b === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.b;
  }
});

test('case store: latest judgement per target and kind replaces the old one, lessons accumulate', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const setup = (() => {
    const code = ts.transpileModule(fs.readFileSync('src/lib/sim45d/setup.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const ex = {}; new Function('exports', 'require', code)(ex, () => ({})); return ex;
  })();
  const code = ts.transpileModule(fs.readFileSync('api/_mcp-store.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const S = {};
  new Function('exports', 'require', 'process', code)(S, n => ({ 'node:fs': { default: fs }, '@supabase/supabase-js': {}, '../src/lib/sim45d/setup.js': setup })[n], process);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')), 'db.json');
  fs.writeFileSync(file, JSON.stringify({ projects: { p: { name: '5공구' } }, members: [{ user: 'u', project: 'p', role: 'editor' }] }));
  const st = S.fileStore(file);
  const c = (kind, title) => ({ projectId: 'p', setupId: 's1', structureKind: 'bridge', structure: '연제교 상선', kind, title, body: {}, source: 'x', tags: [], createdBy: 'u' });
  await st.addCase(c('rates', '단위공기 1'));
  await st.addCase(c('rates', '단위공기 2'));
  await st.addCase(c('lesson', '배운 점 1'));
  await st.addCase(c('lesson', '배운 점 2'));
  const all = await st.findCases({ limit: 10 });
  assert.deepEqual(all.map(x => x.title).sort(), ['단위공기 2', '배운 점 1', '배운 점 2']);
  assert.equal(all[0].projectName, '5공구');
  assert.deepEqual((await st.findCases({ kind: 'lesson', text: '연제교', limit: 10 })).length, 2);
  assert.equal(await st.role('u', 'p'), 'editor');
  assert.equal(await st.role('x', 'p'), null);
});
