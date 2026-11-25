import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionSpatialObjects } from '../scripts/spatial-partition.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('interleaved source order becomes local chunks without dropping or duplicating objects', () => {
  const objects = Array.from({ length: 48 }, (_, id) => ({
    id, center: [(id % 4) * 100, Math.floor(id / 4), 0], triangles: 10,
  }));
  const before = structuredClone(objects);
  const leaves = partitionSpatialObjects(objects, 120);
  assert.equal(leaves.length, 4);
  for (const leaf of leaves) {
    assert.equal(new Set(leaf.objects.map(o => o.center[0])).size, 1);
    assert.equal(leaf.triangles, 120);
  }
  assert.deepEqual(leaves.flatMap(l => l.objects.map(o => o.id)).sort((a, b) => a - b), objects.map(o => o.id));
  assert.deepEqual(objects, before);
  assert.ok(leaves.every(l => l.objects.every(o => objects[o.id] === o)));
});

test('dense coincident geometry still terminates and a large object stays whole', () => {
  const objects = Array.from({ length: 100 }, (_, id) => ({ id, center: [0, 0, 0], triangles: id === 3 ? 1000 : 7 }));
  const leaves = partitionSpatialObjects(objects, 30);
  assert.equal(leaves.flatMap(l => l.objects).length, 100);
  const oversized = leaves.filter(l => l.oversized);
  assert.equal(oversized.length, 1);
  assert.deepEqual(oversized[0].objects, [objects[3]]);
  assert.ok(leaves.filter(l => !l.oversized).every(l => l.triangles <= 30));
});

test('vertical stacks partition by height, not only horizontal cells', () => {
  const objects = Array.from({ length: 8 }, (_, id) => ({ id, center: [0, 0, (id % 2) * 100], triangles: 2 }));
  const leaves = partitionSpatialObjects(objects, 8);
  assert.equal(leaves.length, 2);
  assert.ok(leaves.every(l => new Set(l.objects.map(o => o.center[2])).size === 1));
});

test('empty input is valid; invalid bounds, IDs and budgets fail closed', () => {
  assert.deepEqual(partitionSpatialObjects([], 10), []);
  assert.throws(() => partitionSpatialObjects([], 0));
  assert.throws(() => partitionSpatialObjects([{ id: 0, center: [0, NaN, 0], triangles: 1 }], 10));
  assert.throws(() => partitionSpatialObjects([{ id: 0, center: [0, 0, 0], triangles: 1.5 }], 10));
  const item = { id: 1, center: [0, 0, 0], triangles: 1 };
  assert.throws(() => partitionSpatialObjects([item, item], 10));
});

test('converter preserves thin faces through spatial GLB output', async () => {
  const { buildMergedGlb } = await import('../scripts/mergeGlb.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spatial-converter-'));
  const overrides = { DECIMATE: '0', XKT_TILE_CAP: '6', XKT_TILE_M: '200', XKT_INSTANCE: '0', XKT_DIAG_ONLY: '0' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const nodes = Array.from({ length: 24 }, (_, id) => ({ kind: 1, geometry: id, dbid: id, material: 0 }));
    const geometries = nodes.map((_, id) => {
      const x = (id % 4) * 40, y = Math.floor(id / 4) * 2;
      return { kind: 0, getVertices: () => new Float32Array([x, y, 0, x + .005, y, 0, x, y + .005, 0]),
        getIndices: () => new Uint32Array([0, 1, 2]), getNormals: () => new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) };
    });
    const chunks = [];
    const result = await buildMergedGlb({ getNodeCount: () => nodes.length, getNode: i => nodes[i],
      getGeometry: i => geometries[i], getMaterial: () => ({ diffuse: { x: .5, y: .5, z: .5 } }),
    }, { tiles: true, xktStreamDir: directory, onChunk: async (file, index, triangles, kind) => {
      if (kind !== 'detail') return;
      const bytes = fs.readFileSync(file);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
      chunks.push({ json, triangles });
    } });
    assert.equal(result.tileLayout, 'spatial-median-v1');
    assert.equal(chunks.length, 4);
    assert.equal(chunks.reduce((sum, c) => sum + c.triangles, 0), 24);
    assert.deepEqual(chunks.flatMap(c => c.json.nodes.map(n => Number(n.name))).sort((a, b) => a - b), nodes.map(n => n.dbid));
    assert.ok(Object.values(result.tileAabbs).every(box => box[3] - box[0] <= .006));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
