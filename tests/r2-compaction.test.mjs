import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { compactObject, compactBucket, manifestKeys } from '../scripts/compact-r2-xkt.mjs';

const bytes = Buffer.from('original BIM geometry and properties\n'.repeat(1000));
const hash = b => createHash('md5').update(b).digest('hex');
function fakeStore() {
  let item = { body: Buffer.from(bytes), metadata: { contentType: 'application/octet-stream', custom: { original: 'yes' } } };
  const puts = [];
  return {
    puts,
    async head() { return { etag: hash(item.body), bytes: item.body.length, encoding: item.metadata.encoding }; },
    async get(key, etag) {
      if (etag && etag !== hash(item.body)) throw new Error('precondition failed');
      return { ...item, body: Buffer.from(item.body), metadata: { ...item.metadata }, etag: hash(item.body) };
    },
    async put(key, body, metadata, etag) {
      if (etag !== hash(item.body)) throw new Error('precondition failed');
      puts.push({ key, body: Buffer.from(body), metadata });
      item = { body: Buffer.from(body), metadata };
      return { etag: hash(body) };
    },
    async browserGet() { return item.metadata.encoding === 'gzip' ? gunzipSync(item.body) : item.body; },
  };
}

test('dry-run never writes; application uses same key and preserves exact source bytes', async () => {
  const store = fakeStore();
  const planned = await compactObject(store, 'p/xkt/c0.xkt');
  assert.ok(planned.savedBytes > 0); assert.equal(store.puts.length, 0);
  const result = await compactObject(store, 'p/xkt/c0.xkt', { apply: true });
  assert.equal(result.state, 'compressed'); assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, 'p/xkt/c0.xkt');
  assert.equal(store.puts[0].metadata.custom.original, 'yes');
  assert.ok((await store.browserGet()).equals(bytes));
  assert.equal((await compactObject(store, 'p/xkt/c0.xkt', { apply: true })).state, 'already-compressed');
  assert.equal(store.puts.length, 1);
});

test('bad viewer decompression restores original bytes and headers', async () => {
  const store = fakeStore();
  store.browserGet = async () => Buffer.from('corrupt');
  await assert.rejects(compactObject(store, 'p/xkt/c0.xkt', { apply: true }), /original bytes restored/);
  assert.equal(store.puts.length, 2);
  assert.ok((await store.get()).body.equals(bytes));
  assert.equal((await store.head()).encoding, undefined);
});

test('concurrent replacement is never overwritten by rollback', async () => {
  const store = fakeStore();
  const originalPut = store.put;
  store.browserGet = async () => {
    await originalPut('p/xkt/c0.xkt', Buffer.from('new conversion'), {}, (await store.head()).etag);
    throw new Error('concurrent change');
  };
  await assert.rejects(compactObject(store, 'p/xkt/c0.xkt', { apply: true }), /precondition failed/);
  assert.equal((await store.get()).body.toString(), 'new conversion');
});

test('unsafe paths and missing live files stop before writing', async () => {
  assert.throws(() => manifestKeys('p', { xktFiles: ['../other.xkt'] }));
  assert.deepEqual(manifestKeys('p', { xktFiles: ['runs/v1/c0.xkt'], base: ['base.xkt'], tiles: [{ n: 'runs/v1/c0.xkt' }] }), ['p/xkt/runs/v1/c0.xkt', 'p/xkt/base.xkt']);
  let writes = 0;
  await assert.rejects(compactBucket({
    list: async () => [{ key: 'p/xkt/manifest.json', bytes: 1 }],
    get: async () => ({ body: Buffer.from(JSON.stringify({ xktFiles: ['missing.xkt'] })), etag: 'm' }),
    put: async () => { writes++; },
  }, { apply: true }), /missing objects/);
  assert.equal(writes, 0);
});

test('real HTTP Content-Encoding gzip yields byte-identical viewer response', async () => {
  const compressed = gzipSync(bytes);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/octet-stream', 'Content-Length': compressed.length });
    res.end(compressed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/sample.xkt`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('paired motion files are active references, never stale geometry',()=>{
 const keys=manifestKeys('sample',{xktFiles:['runs/test/c0.xkt'],tiles:[{n:'runs/test/c0.xkt',motion:{n:'runs/test/motion0.xkt'}}]});
 assert.ok(keys.includes('sample/xkt/runs/test/motion0.xkt'));
});
