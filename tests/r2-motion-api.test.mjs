import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { cacheKey } from '../scripts/cache-key.mjs';
const code = ts.transpileModule(fs.readFileSync('api/r2-motion.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const project = '00000000-0000-4000-8000-000000000001';
function setup({ role = 'admin', privateRepo = false, runs = [], ref = 'feature/3d-streaming-stability' } = {}) {
  const requests = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'test-user' } } }) },
    from(table) { return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: table === 'profiles' ? { is_admin: false } : { role } }; } }; },
  };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (url.includes('/runs?')) return Response.json({ workflow_runs: runs });
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    return Response.json({ private: privateRepo });
  };
  const api = {};
  new Function('exports', 'require', 'process', 'fetch', code)(api, () => ({ createClient: () => client }), {
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
      GH_REPO: 'owner/repo', GH_TOKEN: 'test', VERCEL_GIT_COMMIT_REF: ref },
  }, fetch);
  return { requests, call: method => api.default(new Request(`https://example.invalid/api/r2-motion?projectId=${project}`, {
    method, headers: { authorization: 'Bearer test' }, ...(method === 'POST' ? {body: JSON.stringify({urn:'testModel'})} : {}),
  })) };
}
test('project administrator starts only maintenance on the test branch', async () => {
  const t = setup();
  assert.equal((await t.call('POST')).status, 202);
  const dispatch = t.requests.find(r => r.method === 'POST');
  // Same per-URN key as the converter (scripts/cache-key.mjs).
  assert.deepEqual(JSON.parse(dispatch.body), { ref: 'feature/3d-streaming-stability', inputs: { diag_only: 'motion-cache', item: cacheKey('testModel') } });
});
test('viewer and non-test deployment cannot dispatch', async () => {
  for (const options of [{ role: 'viewer' }, { ref: 'main' }]) {
    const t = setup(options);
    assert.equal((await t.call('POST')).status, 403);
    assert.equal(t.requests.length, 0);
  }
});
test('private repository does not launch potentially paid maintenance', async () => {
  const t = setup({ privateRepo: true });
  assert.equal((await t.call('POST')).status, 409);
  assert.ok(t.requests.every(r => r.method !== 'POST'));
});
test('active job is returned without starting a duplicate', async () => {
  const t = setup({ runs: [{ display_title: 'R2 model motion cache', status: 'in_progress', created_at: new Date().toISOString() }] });
  assert.equal((await (await t.call('POST')).json()).state, 'running');
  assert.equal(t.requests.length, 1);
});
