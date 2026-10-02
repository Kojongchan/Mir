import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Compile api/_accAuth.ts with a mocked Supabase client.
function load({ env = { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, user = { id: 'u1' }, admin = false, role = 'editor', acc = 'b.PROJ-A' } = {}) {
  const code = ts.transpileModule(fs.readFileSync('api/_accAuth.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const table = name => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: name === 'profiles' ? { is_admin: admin } : name === 'projects' ? { acc_project_id: acc } : role ? { role } : null }; } });
  const client = { auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) }, from: table };
  const exports = {};
  new Function('exports', 'require', 'process', code)(exports, () => ({ createClient: () => client }), { env });
  return exports.authorizeAccWrite;
}
const req = (auth = 'Bearer t') => new Request('https://x.test/api', { headers: auth ? { authorization: auth } : {} });

test('fails closed without server configuration', async () => {
  const r = await load({ env: {} })(req(), 'm1', 'b.PROJ-A');
  assert.deepEqual([r.ok, r.status], [false, 503]);
});
test('requires a session', async () => {
  assert.equal((await load()(req(''), 'm1', 'b.PROJ-A')).status, 401);
  assert.equal((await load({ user: null })(req(), 'm1', 'b.PROJ-A')).status, 401);
});
test('editor may write only to the ACC project pinned on the MIR project', async () => {
  assert.equal((await load()(req(), 'm1', 'b.PROJ-A')).ok, true);
  assert.equal((await load()(req(), 'm1', 'PROJ-A')).ok, true); // b. prefix tolerated
  const other = await load()(req(), 'm1', 'b.PROJ-B');
  assert.deepEqual([other.ok, other.status], [false, 403]);
  assert.equal((await load({ acc: null })(req(), 'm1', 'b.PROJ-A')).ok, false);
});
test('viewers and non-members are refused; system admins are not limited to the pin', async () => {
  assert.equal((await load({ role: 'viewer' })(req(), 'm1', 'b.PROJ-A')).status, 403);
  assert.equal((await load({ role: null })(req(), 'm1', 'b.PROJ-A')).status, 403);
  assert.equal((await load({ role: null, admin: true })(req(), undefined, 'b.ANY')).ok, true);
});
