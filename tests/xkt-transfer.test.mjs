import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { encodeXktTransfer } from '../scripts/xkt-transfer.mjs';
import { packXktCache } from '../scripts/pack-xkt-cache.mjs';

test('transport compression round trips exact bytes, leaving incompressible files unchanged', () => {
  const raw = Buffer.alloc(65536, 12), packed = encodeXktTransfer(raw);
  assert.equal(packed.contentEncoding, 'gzip');
  assert.ok(packed.transferByteLength < raw.length / 10);
  assert.deepEqual(gunzipSync(packed.body), raw);
  const noise = randomBytes(4096); const unchanged = encodeXktTransfer(noise);
  assert.equal(unchanged.contentEncoding, undefined); assert.deepEqual(unchanged.body, noise);
  assert.throws(() => encodeXktTransfer(Buffer.alloc(0)), /Empty/);
  assert.throws(() => encodeXktTransfer(packed.body), /received gzip/);
});
test('HTTP content encoding transparently delivers original bytes to fetch arrayBuffer', async () => {
  const raw = Buffer.alloc(128*1024, 12), packed = encodeXktTransfer(raw);
  const server = createServer((req,res) => {
    res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Encoding':'gzip','Content-Length':packed.body.length});
    res.end(packed.body);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/model.xkt`);
    assert.equal(Number(response.headers.get('content-length')), packed.transferByteLength);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
test('existing cache repack preserves every reference and tile bounds in a new generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'xkt-pack-'));
  const input = path.join(root,'input'), output = path.join(root,'output');
  await fs.mkdir(input);
  const raw = Buffer.alloc(32768,12);
  const manifest = { schemaVersion:2,tileLayout:'spatial-median-v1',xktFiles:['a.xkt'],navFiles:['b.xkt'],base:['b.xkt'],inst:['a.xkt'],lod1:'b.xkt',
    tiles:[{n:'a.xkt',aabb:[1,2,3,4,5,6],byteLength:raw.length}],focus:{center:[0,0,0],half:[1,1,1]},
    chunkInfo:{'a.xkt':{triangles:123,kind:'detail'}} };
  await fs.writeFile(path.join(input,'a.xkt'),raw); await fs.writeFile(path.join(input,'b.xkt'),raw);
  await fs.writeFile(path.join(input,'manifest.json'),JSON.stringify(manifest));
  try {
    const stats = await packXktCache(input,output); assert.equal(stats.files,2);
    const result = JSON.parse(await fs.readFile(path.join(output,'manifest.json')));
    assert.deepEqual(result.tiles[0].aabb,manifest.tiles[0].aabb);
    assert.deepEqual(result.focus,manifest.focus);assert.equal(result.tileLayout,manifest.tileLayout);
    assert.equal(result.tiles[0].n,result.xktFiles[0]);assert.equal(result.inst[0],result.xktFiles[0]);
    assert.equal(result.base[0],result.navFiles[0]);assert.equal(result.lod1,result.base[0]);
    assert.equal(result.chunkInfo[result.xktFiles[0]].triangles,123);
    const plan = JSON.parse(await fs.readFile(path.join(output,'upload-plan.json')));
    for(const upload of plan.uploads){
      assert.equal(upload.contentEncoding,'gzip');
      assert.deepEqual(gunzipSync(await fs.readFile(path.join(output,upload.path))),raw);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(input,'manifest.json'))),manifest);
    await assert.rejects(packXktCache(input,output), /EEXIST/);
    manifest.xktFiles=['../escape.xkt'];
    await fs.writeFile(path.join(input,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(packXktCache(input,path.join(root,'bad')), /Invalid cache path/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
