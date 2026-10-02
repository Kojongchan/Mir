import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMergedLod, decodeMergedPositions } from '../scripts/tile-lod-merge.mjs';

const tables = b => Array.from({ length: 29 }, (_, s) => b.subarray(b.readUInt32LE(4 + s * 8), b.readUInt32LE(4 + s * 8) + b.readUInt32LE(8 + s * 8)));
const arr = (b, T) => new T(Uint8Array.from(b).buffer);
const tile0 = [100, 200, 0, 121.845, 221.845, 0], tile1 = [1000, 1000, 10, 1020, 1020, 30];

/** Two internal tiles: a dense plane (non-reused) in tile 0 and one cube reused by two meshes in tile 1. */
function fixture({ textured = false } = {}) {
  const slots = Array.from({ length: 29 }, () => Buffer.alloc(0)), put = (s, T, v) => slots[s] = Buffer.from(T.from(v).buffer);
  slots[0] = Buffer.from('{}'); slots[14] = Buffer.from('[]'); slots[25] = Buffer.from('["plane","cubeA","cubeB"]');
  const pos = [], idx = [];
  for (let y = 0; y <= 20; y++) for (let x = 0; x <= 20; x++) pos.push(x * 3000, y * 3000, 0);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) { const a = y * 21 + x; idx.push(a, a + 1, a + 21, a + 1, a + 22, a + 21); }
  const planeVerts = pos.length, planeIdx = idx.length;
  const cube = [[0,0,0],[1000,0,0],[1000,1000,0],[0,1000,0],[0,0,1000],[1000,0,1000],[1000,1000,1000],[0,1000,1000]];
  for (const c of cube) pos.push(...c);
  for (const t of [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]]) idx.push(...t);
  put(4, Uint16Array, pos); put(8, Uint32Array, idx);
  // Reused geometry decode: q * 0.001 m. Mesh matrices translate by +5 m and +10 m in x.
  put(11, Float32Array, [1,0,0,0, 0,1,0,0, 0,0,1,0, 5,0,0,1, 1,0,0,0, 0,1,0,0, 0,0,1,0, 10,0,0,1]);
  put(12, Float32Array, [0.001,0,0,0, 0,0.001,0,0, 0,0,0.001,0, 0,0,0,1]);
  put(13, Uint8Array, [1, 0]);
  put(15, Uint32Array, [0, planeVerts]); put(16, Uint32Array, [0, 0]); put(17, Uint32Array, [0, 0]);
  put(18, Uint32Array, [0, 0]); put(19, Uint32Array, [0, planeIdx]); put(20, Uint32Array, [0, 0]);
  put(21, Uint32Array, [0, 1, 1]); put(22, Uint32Array, [0, 0, 16]);
  put(23, Int32Array, textured ? [0, 1, -1] : [-1, -1, -1]);
  if (textured) put(10, Int32Array, [0, -1, -1, -1, -1, 0, -1, -1, -1, -1]); // two identical sets, one texture put(24, Uint8Array, [120,130,140,255,0,230, 10,20,30,255,0,200, 40,50,60,255,0,200]);
  put(26, Uint32Array, [0, 1, 2]); put(27, Float64Array, [...tile0, ...tile1]); put(28, Uint32Array, [0, 1]);
  const head = Buffer.alloc(236), out = [head]; head.writeUInt32LE(12); let len = 236;
  slots.forEach((b, s) => { const pad = (8 - len % 8) % 8; out.push(Buffer.alloc(pad)); len += pad; head.writeUInt32LE(len, 4 + s * 8); head.writeUInt32LE(b.length, 8 + s * 8); out.push(b); len += b.length; });
  return Buffer.concat(out);
}

for (const profile of ['light', 'far']) test(`${profile}: internal tiles merge into one, instances expand, entities and materials stay`, async () => {
  const source = fixture(), copy = Buffer.from(source);
  const r = await buildMergedLod(source, profile);
  assert.deepEqual(source, copy);
  assert.equal(r.sourceTiles, 2); assert.equal(r.reusedGeometries, 1); assert.equal(r.members, 3);
  assert.ok(r.triangles < r.detailTriangles);
  const before = tables(source), after = tables(r.bytes);
  for (const s of [0, 1, 2, 3, 10, 23, 24, 25, 26]) assert.deepEqual(after[s], before[s]);
  assert.deepEqual([...arr(after[28], Uint32Array)], [0]);
  assert.deepEqual([...arr(after[21], Uint32Array)], [0, 1, 2]);   // no reused geometry left
  assert.equal(after[5].length, 0); assert.equal(after[9].length, 0);
  const box = [...arr(after[27], Float64Array)];
  // Union of the plane (tile 0) and both placed cubes (tile 1 centre 1010,1010,20 + 5/10 m + 0..1 m).
  const expected = [100, 200, 0, 1021, 1011, 21];
  box.forEach((v, a) => assert.ok(Math.abs(v - expected[a]) < 1e-6, `box[${a}] ${v}`));
  // Cube vertices land at their instanced world positions (within one quantization step).
  const world = decodeMergedPositions(r.bytes), pp = arr(after[15], Uint32Array);
  const step = a => (box[a + 3] - box[a]) / 65535 + 1e-9;
  for (const [mesh, dx] of [[1, 5], [2, 10]]) {
    const start = pp[mesh], end = mesh + 1 < pp.length ? pp[mesh + 1] : world.length;
    const xs = [], ys = [], zs = [];
    for (let i = start; i < end; i += 3) { xs.push(world[i]); ys.push(world[i + 1]); zs.push(world[i + 2]); }
    assert.ok(Math.abs(Math.min(...xs) - (1010 + dx)) <= step(0) && Math.abs(Math.max(...xs) - (1011 + dx)) <= step(0));
    assert.ok(Math.abs(Math.min(...ys) - 1010) <= step(1) && Math.abs(Math.max(...zs) - 21) <= step(2));
  }
});

test('far drops tiny detached parts but never empties a mesh', async () => {
  const r = await buildMergedLod(fixture(), 'far');
  const after = tables(r.bytes), ip = arr(after[19], Uint32Array), indices = arr(after[8], Uint32Array);
  for (let m = 0; m < ip.length; m++) assert.ok((m + 1 < ip.length ? ip[m + 1] : indices.length) - ip[m] >= 3);
});

test('unsupported version is left alone and corrupt tables fail closed', async () => {
  const b = fixture(); b.writeUInt32LE(11);
  assert.equal(await buildMergedLod(b, 'light'), null);
  const c = fixture(); c.writeUInt32LE(0x7fffffff, 4 + 4 * 8);
  await assert.rejects(() => buildMergedLod(c, 'light'));
});

test('identical texture sets collapse so textured meshes share one draw layer', async () => {
  const r = await buildMergedLod(fixture({ textured: true }), 'light');
  const after = tables(r.bytes);
  assert.equal(r.textureSets, 2); assert.equal(r.uniqueTextureSets, 1);
  assert.deepEqual([...arr(after[10], Int32Array)], [0, -1, -1, -1, -1]);
  assert.deepEqual([...arr(after[23], Int32Array)], [0, 0, -1]);
});

test('far simplifies whole meshes: a dense plane collapses to a handful of triangles, every mesh keeps geometry', async () => {
  const r = await buildMergedLod(fixture(), 'far');
  // Plane 800 → its 2% target (16); the two 1 m cubes stay whole (12 each).
  assert.ok(r.triangles <= 16 + 2 * 12, `triangles ${r.triangles}`);
  const after = tables(r.bytes), ip = arr(after[19], Uint32Array), indices = arr(after[8], Uint32Array);
  for (let m = 0; m < ip.length; m++) assert.ok((m + 1 < ip.length ? ip[m + 1] : indices.length) - ip[m] >= 3);
});
