import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { cacheKey, legacyCacheKey } from '../scripts/cache-key.mjs';

const code = ts.transpileModule(fs.readFileSync('api/aps-convert.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET: 'bucket' };
const base = 'https://acct.r2.cloudflarestorage.com/bucket/';

function api(store) {
  const writes = [];
  const AwsClient = class {
    async fetch(url, options = {}) {
      const key = url.slice(base.length), method = options.method ?? 'GET';
      if (method === 'PUT') {
        const ifNone = options.headers?.['if-none-match'] === '*';
        if (ifNone && store.has(key)) return new Response('', { status: 412 });
        store.set(key, options.body); writes.push(key); return new Response('');
      }
      if (!store.has(key)) return new Response('', { status: 404 });
      return new Response(method === 'HEAD' ? null : store.get(key));
    }
    async sign(url) { return { url }; }
  };
  const exports = {};
  new Function('exports', 'require', 'process', 'fetch', code)(exports, name => {
    if (name === 'aws4fetch') return { AwsClient };
    if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) };
    throw new Error(name);
  }, { env }, async () => { throw new Error('no dispatch'); });
  const get = async urn => (await exports.default(new Request(`https://x.test/api/aps-convert?urn=${encodeURIComponent(urn)}`,
    { headers: { authorization: 'Bearer t' } }))).json();
  return { get, writes };
}
const manifest = JSON.stringify({ xktFiles: ['c0.xkt'], tiles: [{ n: 'c0.xkt', aabb: [0, 0, 0, 1, 1, 1] }] });
// Two versions of one ACC file: the old 40-alphanumeric key cannot tell them apart.
const v1 = Buffer.from('urn:adsk.wipprod:fs.file:vf.JxAbCdEfGh?version=1').toString('base64');
const v2 = Buffer.from('urn:adsk.wipprod:fs.file:vf.JxAbCdEfGh?version=2').toString('base64');
const other = Buffer.from('urn:adsk.wipprod:fs.file:vf.JxZzYyXxWw?version=4').toString('base64');

test('legacy key collides across versions and files; the new key does not', () => {
  assert.equal(legacyCacheKey(v1), legacyCacheKey(v2));
  assert.equal(legacyCacheKey(v1), legacyCacheKey(other));
  assert.equal(new Set([cacheKey(v1), cacheKey(v2), cacheKey(other)]).size, 3);
  assert.match(cacheKey(v1), /^[0-9a-f]{40}$/);
});

test('API and converter derive the same key', async () => {
  const store = new Map([[`${cacheKey(v1)}/xkt/manifest.json`, manifest]]);
  const { get, writes } = api(store);
  const state = await get(v1);
  assert.equal(state.ready, true);
  assert.ok(state.urls[0].includes(`/${cacheKey(v1)}/xkt/c0.xkt`));
  assert.deepEqual(writes, []);
});

test('first opener claims a legacy cache without copying; other versions/files do not inherit it', async () => {
  const legacy = legacyCacheKey(v1);
  const store = new Map([[`${legacy}/xkt/manifest.json`, manifest]]);
  const { get, writes } = api(store);
  const first = await get(v1);
  assert.equal(first.ready, true);
  assert.ok(first.urls[0].includes(`/${legacy}/xkt/c0.xkt`));
  assert.equal(JSON.parse(store.get(`${legacy}/claim.json`)).urn, v1);
  assert.deepEqual(JSON.parse(store.get(`${cacheKey(v1)}/alias.json`)), { urn: v1, prefix: legacy });
  assert.ok(writes.every(k => k.endsWith('/claim.json') || k.endsWith('/alias.json')));
  // A newer version and an unrelated file with the same legacy key are not served v1's model.
  assert.equal((await get(v2)).ready, false);
  assert.equal((await get(other)).ready, false);
  // The owner keeps resolving to the legacy directory.
  assert.equal((await get(v1)).ready, true);
});

test('a reconversion under the new key wins over the legacy alias', async () => {
  const legacy = legacyCacheKey(v1);
  const store = new Map([[`${legacy}/xkt/manifest.json`, manifest]]);
  const { get } = api(store);
  await get(v1);
  store.set(`${cacheKey(v1)}/xkt/manifest.json`, JSON.stringify({ xktFiles: ['fresh.xkt'] }));
  assert.ok((await get(v1)).urls[0].includes(`/${cacheKey(v1)}/xkt/fresh.xkt`));
});
