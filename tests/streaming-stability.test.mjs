import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, requireStub = () => { throw new Error('unexpected import'); }, env = {}, fetchStub) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', 'fetch', code)(exports, requireStub, { env }, fetchStub);
  return exports;
}
const { TileStream } = compile('src/viewer/TileStream.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('encoded budget and concurrency are enforced; moving does not hide loaded tiles', async () => {
  const jobs = new Map(), removed = [];
  let stats;
  const stream = new TileStream({ maxTiles: 3, maxEncodedBytes: 25, concurrency: 2,
    load: tile => new Promise(resolve => jobs.set(tile.id, resolve)),
    unload: tile => removed.push(tile.id), onChange: s => { stats = s; } });
  stream.select(['a', 'b', 'c'].map(id => ({ id, byteLength: 10 })));
  await flush();
  assert.deepEqual([...jobs.keys()], ['a', 'b']);
  assert.equal(stats.selected, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.encodedBytes, 20);
  jobs.get('a')(); jobs.get('b')(); await flush();
  stream.setPaused(true);
  assert.deepEqual(removed, []);
  assert.equal(stats.loaded, 2);
  stream.dispose();
});

test('LRU eviction runs before new loads and resident reservations stay within budget', async () => {
  const events = []; let stats;
  const stream = new TileStream({ maxTiles: 2, maxEncodedBytes: 20,
    load: async t => { events.push('load:' + t.id); },
    unload: t => events.push('unload:' + t.id), onChange: s => { stats = s; assert.ok(s.encodedBytes <= 20); } });
  stream.select([{ id: 'a', byteLength: 10 }, { id: 'b', byteLength: 10 }]);
  await flush();
  stream.select([{ id: 'b', byteLength: 10 }, { id: 'c', byteLength: 10 }]);
  await flush();
  assert.ok(events.indexOf('unload:a') < events.indexOf('load:c'));
  assert.equal(stats.loaded, 2);
  stream.dispose();
});

test('superseded download is aborted; late completion cannot update current scene', async () => {
  const jobs = new Map(), signals = new Map(); let stats;
  const stream = new TileStream({ maxTiles: 1, concurrency: 1,
    load: (t, signal) => new Promise(resolve => { jobs.set(t.id, resolve); signals.set(t.id, signal); }),
    unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'old' }]); await flush();
  stream.select([{ id: 'new' }]); await flush();
  assert.equal(signals.get('old').aborted, true);
  jobs.get('old')(); await flush();
  assert.equal(stats.loaded, 0);
  jobs.get('new')(); await flush();
  assert.equal(stats.loaded, 1);
  stream.dispose();
});

test('persistent errors stop after one delayed retry', async () => {
  let attempts = 0, stats;
  const stream = new TileStream({ retryMs: 5,
    load: async () => { attempts++; throw new Error('HTTP 403'); }, unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'expired' }]);
  await wait(35);
  assert.equal(attempts, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.loading, 0);
  stream.dispose();
});

test('dispose prevents a pending retry or load completion from updating UI', async () => {
  let calls = 0, changes = 0;
  const stream = new TileStream({ retryMs: 10, load: async () => { calls++; throw new Error('offline'); },
    unload: () => {}, onChange: () => { changes++; } });
  stream.select([{ id: 'a' }]); await flush();
  stream.dispose(); const before = changes;
  await wait(30);
  assert.equal(calls, 1);
  assert.equal(changes, before);
});

const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET: 'test' };
function api({ enabled = false, cache = false, withBranch = false } = {}) {
  const requests = [];
  const AwsClient = class {
    async fetch(url, options) {
      requests.push({ url, method: options?.method ?? 'GET' });
      if (cache && url.endsWith('/xkt/manifest.json')) return new Response(JSON.stringify({ xktFiles: ['c0.xkt'] }));
      return new Response('', { status: 404 });
    }
    async sign(url) { return { url }; }
  };
  const handler = compile('api/aps-convert.ts', name => {
    if (name === 'aws4fetch') return { AwsClient };
    if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'tester' } } }) } }) };
    throw new Error(name);
  }, { ...env, ENABLE_MODEL_CONVERSION: enabled ? 'true' : '', GH_REPO: 'test/repo', GH_TOKEN: 'test', GH_REF: withBranch ? 'test-branch' : '' },
  async () => { throw new Error('must not dispatch workflow'); }).default;
  return { handler, requests };
}
function request(body) {
  return new Request('https://example.test/api/aps-convert', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ urn: 'test-urn', ...body }) });
}
test('cost-disabled forced rebuild neither deletes cache nor dispatches work', async () => {
  const { handler, requests } = api();
  const r = await handler(request({ force: true, ackOverage: true }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'CONVERSION_DISABLED');
  assert.deepEqual(requests, []);
});

test('existing cached models remain readable when new conversion is disabled', async () => {
  const { handler, requests } = api({ cache: true });
  const r = await handler(request({}));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ready, true);
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('conversion with an unspecified branch fails before any storage mutation', async () => {
  const { handler, requests } = api({ enabled: true });
  const r = await handler(request({ force: true }));
  assert.equal(r.status, 503);
  assert.deepEqual(requests, []);
});

test('storage usage failure blocks conversion even with a legacy cost override', async () => {
  const { handler, requests } = api({ enabled: true, withBranch: true });
  const r = await handler(request({ force: true, ackOverage: true }));
  assert.equal(r.status, 503);
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('actual tile bytes cannot bypass the budget of a legacy manifest', async () => {
  const jobs = new Map(); let stats;
  const stream = new TileStream({ maxEncodedBytes: 30, fallbackBytes: 10,
    load: t => new Promise(resolve => jobs.set(t.id, resolve)), unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); await flush();
  assert.equal(stream.accountBytes('a', 21), false);
  assert.equal(stream.accountBytes('a', 20), true);
  jobs.get('a')(); jobs.get('b')(); await flush();
  assert.equal(jobs.has('c'), false);
  assert.equal(stats.encodedBytes, 30);
  stream.dispose();
});

// Exercise the actual existing-SVF gate without importing the heavyweight conversion pipeline.
function existingSvfGate(state) {
  const source = ts.createSourceFile('convert4d.mjs', fs.readFileSync('scripts/convert4d.mjs', 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['scanManifest', 'ensureSvf']);
  const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(source)).join('\n');
  let calls = 0;
  const gate = new Function('ModelDerivativeClient', 'AuthenticationClient', 'Scopes', 'APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_REGION', 'fetch',
    functions + '\nreturn ensureSvf;')(
    class { async getManifest() { return state; } }, class { async getTwoLeggedToken() { return { access_token: 'test' }; } },
    { ViewablesRead: 'viewables:read' }, 'test', 'test', 'US', () => { calls++; throw new Error('unexpected external request'); });
  return { gate, calls: () => calls };
}

test('missing SVF fails without requesting a cloud conversion job', async () => {
  const { gate, calls } = existingSvfGate({ derivatives: [] });
  await assert.rejects(gate('test'), /기존 SVF/);
  assert.equal(calls(), 0);
});

test('existing SVF can be consumed without requesting a cloud conversion job', async () => {
  const { gate, calls } = existingSvfGate({ derivatives: [{ children: [{ role: 'graphics', mime: 'application/autodesk-svf' }] }] });
  await gate('test');
  assert.equal(calls(), 0);
});

test('a stalled network request releases its slot and eventually stops retrying', async () => {
  let attempts = 0, stats;
  const stream = new TileStream({ retryMs: 2, loadTimeoutMs: 5,
    load: () => { attempts++; return new Promise(() => {}); }, unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'stalled' }]);
  await wait(40);
  assert.equal(attempts, 2);
  assert.equal(stats.loading, 0);
  assert.equal(stats.failed, 1);
  stream.dispose();
});
