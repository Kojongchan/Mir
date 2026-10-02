import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// In-memory Supabase double: from(table).select().eq().in()… awaited or .single()/.maybeSingle().
function db(tables) {
  const calls = [];
  const query = name => {
    const filters = [];
    const rows = () => (tables[name] ?? []).filter(r => filters.every(f => f(r)));
    const q = {
      select() { return q; }, order() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      neq(k, v) { filters.push(r => r[k] !== v); return q; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
      async single() { return { data: rows()[0] ?? null }; }, async maybeSingle() { return { data: rows()[0] ?? null }; },
      then(res) { res({ data: rows() }); },
      update() { return { eq: async () => ({ error: null }) }; }, upsert: async () => ({ error: null }),
    };
    return q;
  };
  return { calls, client: {
    auth: { getUser: async () => ({ data: { user: { id: 'caller' } }, error: null }),
      admin: { updateUserById: async (id, attrs) => { calls.push(['update', id, attrs]); return { error: null }; } } },
    from: query } };
}
function api(tables) {
  const code = ts.transpileModule(fs.readFileSync('api/admin.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { client, calls } = db(tables), exports = {};
  new Function('exports', 'require', 'process', code)(exports, () => ({ createClient: () => client }),
    { env: { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' } });
  const call = body => exports.default(new Request('https://x.test/api/admin', { method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { call, calls };
}
const base = {
  profiles: [{ id: 'caller', is_admin: false }, { id: 'local', is_admin: false }, { id: 'boss-b', is_admin: false }],
  project_members: [
    { project_id: 'A', user_id: 'caller', role: 'admin' },
    { project_id: 'A', user_id: 'local', role: 'editor' },
    { project_id: 'A', user_id: 'boss-b', role: 'viewer' }, // added to A by A's admin
    { project_id: 'B', user_id: 'boss-b', role: 'admin' },
  ],
};

test("a project admin cannot reset the password of an account that also belongs to another project", async () => {
  const { call, calls } = api(base);
  const r = await call({ action: 'resetPassword', projectId: 'A', userId: 'boss-b', password: 'takeover1' });
  assert.equal(r.status, 403);
  assert.deepEqual(calls, []);
  const rename = await call({ action: 'renameUser', projectId: 'A', userId: 'boss-b', username: 'x' });
  assert.equal(rename.status, 403);
});
test('a project admin can still reset credentials of accounts only in their projects', async () => {
  const { call, calls } = api(base);
  const r = await call({ action: 'resetPassword', projectId: 'A', userId: 'local', password: 'newpass1' });
  assert.equal(r.status, 200);
  assert.equal(calls[0][1], 'local');
});
test('a system admin is not limited by project scope', async () => {
  const { call } = api({ ...base, profiles: base.profiles.map(p => p.id === 'caller' ? { ...p, is_admin: true } : p) });
  assert.equal((await call({ action: 'resetPassword', projectId: 'A', userId: 'boss-b', password: 'newpass1' })).status, 200);
});
