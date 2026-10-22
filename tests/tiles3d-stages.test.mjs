import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeXkt, boxMesh, slabMesh } from './helpers/xkt-writer.mjs';
import { partition, readGroups, writeGroups } from '../scripts/tiles3d-parts.mjs';

const execute = promisify(execFile);
const PREFIX = 'stagetest', ORIGIN = [1000, 2000, 100];

/**
 * A small site in a bucket folder: six tiles along x, each with an excavation-like solid and a shotcrete-like layer
 * weaving ±5 cm on it (skins), a 31 cm wall with a 9 cm finish lying on it, single blocks (they vote the SVF origin), a
 * translucent panel and a piece of one object running through every tile; a seventh tile with only a far file; the
 * "SVF" (tests/helpers/fake-svf.mjs) has every entity as a fragment, one more the conversion lost.
 */
function makeSite(dir) {
  const tiles = [], fragments = [];
  let next = 1;
  const entity = (mesh, rgba, dbId = next++) => {
    fragments.push({ dbId, world: mesh.world.map((v, k) => v + ORIGIN[k % 3]), idx: mesh.tri, transparent: rgba[3] < 250 });
    return { id: String(dbId), meshes: [{ ...mesh, rgba }] };
  };
  const bounds = list => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const e of list) for (const m of e.meshes) for (let k = 0; k < m.world.length; k++) { b[k % 3] = Math.min(b[k % 3], m.world[k]); b[k % 3 + 3] = Math.max(b[k % 3 + 3], m.world[k]); }
    return b;
  };
  const xktDir = path.join(dir, PREFIX, 'xkt');
  fs.mkdirSync(path.join(xktDir, 'runs', 'r1'), { recursive: true });
  let lostNear = null;
  for (let t = 0; t < 6; t++) {
    const x = t * 40, list = [];
    list.push(entity(boxMesh([x + 2, 0, -10, x + 38, 20, 0]), [150, 140, 122, 255]));
    list.push(entity(slabMesh([x + 4, 4, x + 36, 16], 0, 0.1, 6, (i, j) => ((i + j) % 2 ? 0.05 : -0.05)), [180, 180, 180, 255]));
    list.push(entity(boxMesh([x + 2, 22, 0, x + 38, 22.31, 4]), [120, 120, 120, 255]));
    list.push(entity(boxMesh([x + 4, 22.305, 0.5, x + 36, 22.395, 3.5]), [210, 190, 170, 255]));
    for (let k = 0; k < 4; k++) list.push(entity(boxMesh([x + 5 + k * 7, 25, 0, x + 6 + k * 7, 26, 1]), [60 + k * 40, 90, 30, 255]));
    list.push(entity(slabMesh([x + 10, 28, x + 20, 30], 2, 0.05, 2), [100, 150, 200, 120]));
    list.push(entity(boxMesh([x, 32, 0, x + 40, 33, 1]), [200, 60, 60, 255], 900));
    if (t === 2) lostNear = Number(list[4].id);
    fs.writeFileSync(path.join(xktDir, `d${t}.xkt`), writeXkt(list));
    tiles.push({ n: `d${t}.xkt`, aabb: bounds(list) });
  }
  // A fragment of a block in tile 2 that no tile file has (lost in the conversion): the audit adds it to tile 2.
  fragments.push({ dbId: lostNear, world: boxMesh([85, 25, 2, 86, 26, 3]).world.map((v, k) => v + ORIGIN[k % 3]), idx: boxMesh([0, 0, 0, 1, 1, 1]).tri });
  const far = [entity(boxMesh([245, 0, 0, 250, 5, 5]), [90, 90, 200, 255]), entity(boxMesh([260, 0, 0, 265, 5, 5]), [90, 200, 90, 255])];
  fs.writeFileSync(path.join(xktDir, 'runs', 'r1', 'far6.xkt'), writeXkt(far));
  tiles.push({ aabb: bounds(far), far: { n: 'runs/r1/far6.xkt', policy: 'merged-far-v5', members: 2 } });
  fs.writeFileSync(path.join(xktDir, 'manifest.json'), JSON.stringify({ tiles, base: [] }));
  fs.mkdirSync(path.join(dir, PREFIX, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, PREFIX, 'meta', 'current.json'), JSON.stringify({ objects: 900 }));
  fs.writeFileSync(path.join(dir, 'svf.json'), JSON.stringify(fragments));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tiles3d-stages-'));
async function build(bucket, work, env) {
  return execute(process.execPath, ['scripts/build-tiles3d.mjs'], { maxBuffer: 64 << 20, env: { ...process.env, TILES3D_LOCAL_DIR: bucket,
    MODEL_CACHE_PREFIX: PREFIX, TILES3D_WORK: work, TILES3D_SVF_MODULE: 'tests/helpers/fake-svf.mjs', TILES3D_FAKE_SVF: path.join(bucket, 'svf.json'),
    URN: 'fakeurn', TILES3D_STAGE: '', TILES3D_PARTS: '', TILES3D_PART: '', ...env } });
}
/** The published run: current.json, and every file of the run folder by relative path. */
function published(bucket, folder) {
  const base = path.join(bucket, PREFIX, folder), current = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'));
  const dir = path.join(base, current.run), files = new Map();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p)); } };
  walk(dir);
  assert.equal(fs.readdirSync(path.join(base, 'runs')).length, 1, 'one run kept');
  return { current, files };
}
/** Statistics without the timings. */
const untimed = s => JSON.parse(JSON.stringify(s, (k, v) => (k === 'seconds' || k === 'partnerSeconds' ? undefined : v)));

for (const svf of [true, false]) {
  test(`${svf ? 'svf=1' : 'plain'}: plan + 3 parts + finalize publish exactly what one process does`, { timeout: 240_000 }, async () => {
    const one = tmp(), split = tmp();
    makeSite(one); makeSite(split);
    const mode = svf ? { DIAG_OPTIONS: 'svf=1' } : {};
    await build(one, path.join(one, 'work'), { ...mode, TILES3D_STAGE: 'all' });
    const work = path.join(split, 'work');
    await build(split, work, { ...mode, TILES3D_STAGE: 'plan', TILES3D_PARTS: '3', TILES3D_CHUNK: '2' });
    const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
    assert.equal(plan.parts.length, 3);
    assert.deepEqual(plan.parts.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
    for (const k of [0, 1, 2]) await build(split, work, { ...mode, TILES3D_STAGE: 'leaves', TILES3D_PART: String(k) });
    await build(split, work, { ...mode, TILES3D_STAGE: 'finalize' });

    const folder = svf ? 'tiles3d-svf' : 'tiles3d', a = published(one, folder), b = published(split, folder);
    assert.deepEqual([...b.files.keys()].sort(), [...a.files.keys()].sort());
    assert.deepEqual([...a.files.keys()].sort(), [...a.current.files].sort(), 'the run folder holds exactly the published files');
    for (const [name, bytes] of a.files) assert.ok(bytes.equals(b.files.get(name)), `${name} differs`);
    assert.equal(b.current.bytes, a.current.bytes);
    assert.deepEqual(untimed(b.current.stats), untimed(a.current.stats));
    assert.ok(a.files.has('c/f6.glb') && a.files.has('c/d0.glb') && a.files.has('tileset.json') && a.files.has('objects.bin'));
    // A third build over the split one, compared with it before it replaces it: every file the same.
    const { stdout } = await build(split, path.join(split, 'work2'), { DIAG_OPTIONS: svf ? 'svf=1,compare=1' : 'compare=1', TILES3D_STAGE: 'all' });
    assert.match(stdout, new RegExp(`Compare with runs/[\\w-]+: ${a.files.size} same, 0 different, 0 gone, 0 new`));
    if (svf) {
      const s = a.current.stats;
      assert.equal(s.svf.firstPass.missing, 1, 'the lost fragment was found');
      assert.equal(s.svf.rebuiltTiles, 1);
      assert.equal(s.svf.missing.fragments, 0, 'and added');
      assert.ok(s.skins.pushed > 0, 'the weaving layer goes behind the solid');
    }
  });
}

test('parts: runs of neighbours dealt round; one part keeps the order; groups survive the file', () => {
  const items = Array.from({ length: 10 }, (_, k) => ({ key: k, centre: [k * 10, 0, 0] }));
  assert.deepEqual(partition(items, 1), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  const parts = partition(items, 3, 2);
  assert.deepEqual(parts.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parts.map(p => p.length), [4, 4, 2]);
  for (const p of parts) for (let k = 0; k + 1 < p.length; k += 2) assert.equal(Math.abs(p[k + 1] - p[k]), 1, 'a run is two neighbours');
  const file = path.join(tmp(), 'g'), fd = fs.openSync(file, 'w');
  const g = { pos: Float64Array.from([1.5, 2, 3]), rgba: Uint8Array.from([1, 2, 3, 4]), ids: Float32Array.from([7]), idx: Uint32Array.from([0, 0, 0]), skin: Float32Array.from([9]) };
  writeGroups(fd, 4, { opaque: g, transparent: null });
  writeGroups(fd, 9, null);
  fs.closeSync(fd);
  const back = readGroups(file);
  assert.deepEqual([...back.keys()], [4, 9]);
  assert.deepEqual(back.get(4).opaque, g);
  assert.equal(back.get(4).transparent, null);
  assert.deepEqual(back.get(9), { opaque: null, transparent: null });
});
