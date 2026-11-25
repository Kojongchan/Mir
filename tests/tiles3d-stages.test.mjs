import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, hkdfSync } from 'node:crypto';
import { promisify } from 'node:util';
import { writeXkt, boxMesh, slabMesh } from './helpers/xkt-writer.mjs';
import { partition, readRecord, writeRecord } from '../scripts/tiles3d-parts.mjs';
import { codeFingerprint } from '../scripts/code-fingerprint.mjs';

const execute = promisify(execFile);
const PREFIX = 'stagetest', ORIGIN = [1000, 2000, 100];

/**
 * A small site in a bucket folder: six tiles along x, each with an excavation-like solid and a shotcrete-like layer
 * weaving ±5 cm on it (skins), a 31 cm wall with a 9 cm finish lying on it, single blocks (they vote the SVF origin), a
 * translucent panel and a piece of one object running through every tile; a seventh tile with only a far file; the
 * "SVF" (tests/helpers/fake-svf.mjs) has every entity as a fragment, one more the conversion lost. `tweak`: tile 3's wall
 * in another grey (a changed tile).
 */
function makeSite(dir, { tweak = false } = {}) {
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
    list.push(entity(boxMesh([x + 2, 22, 0, x + 38, 22.31, 4]), tweak && t === 3 ? [125, 120, 120, 255] : [120, 120, 120, 255]));
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

/** The record files in a records folder (beside them: costs.json). */
const recs = dir => fs.readdirSync(dir).filter(f => f.endsWith('.rec'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tiles3d-stages-'));
async function build(bucket, work, env) {
  return execute(process.execPath, ['scripts/build-tiles3d.mjs'], { maxBuffer: 64 << 20, env: { ...process.env, TILES3D_LOCAL_DIR: bucket,
    MODEL_CACHE_PREFIX: PREFIX, TILES3D_WORK: work, TILES3D_SVF_MODULE: 'tests/helpers/fake-svf.mjs', TILES3D_FAKE_SVF: path.join(bucket, 'svf.json'),
    URN: 'fakeurn', TILES3D_STAGE: '', TILES3D_PARTS: '', TILES3D_PART: '', ...env } });
}
/**
 * The published run: current.json, and every file by its path in the run (tile files from the stored files by their
 * hash, the others from the run's folder). Also checks that one run folder is left and that every stored file is the
 * run's or one a kept record lists (`records`: the records folder, else no stored file outside the run).
 */
function published(bucket, folder, records = null, key = null) {
  const base = path.join(bucket, PREFIX, folder), current = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'));
  assert.equal(current.v, 2);
  const files = new Map(current.files.map(rel => [rel, fs.readFileSync(rel.startsWith('c/') ? path.join(base, 'files', `${current.hash[rel]}.glb`)
    : path.join(base, current.run, rel))]));
  for (const [rel, bytes] of files) assert.equal(createHash('sha256').update(bytes).digest('hex'), current.hash[rel], `${rel} is stored under its hash`);
  assert.deepEqual(fs.readdirSync(path.join(base, 'runs')), [current.run.slice(5)], 'one run kept');
  assert.deepEqual(fs.readdirSync(path.join(base, current.run)).sort(), ['objects.bin', 'tileset.json']);
  const listed = new Set(Object.values(current.hash));
  if (records) for (const f of recs(records)) for (const [, w] of readRecord(path.join(records, f), { metaOnly: true, key }).meta.files) listed.add(w.hash);
  for (const f of fs.readdirSync(path.join(base, 'files'))) assert.ok(listed.has(f.replace(/\.glb$/, '')), `stored file ${f} is listed`);
  return { current, files };
}
/** Statistics without the timings. */
const untimed = s => JSON.parse(JSON.stringify(s, (k, v) => (k === 'seconds' || k === 'partnerSeconds' || k === 'downloadSeconds' ? undefined : v)));
/** And without what was kept from earlier builds. */
const built = s => untimed({ ...s, incremental: undefined });

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

    const folder = svf ? 'tiles3d-svf' : 'tiles3d';
    const a = published(one, folder, path.join(one, 'work', 'records')), b = published(split, folder, path.join(work, 'records'));
    assert.deepEqual([...b.files.keys()].sort(), [...a.files.keys()].sort());
    for (const [name, bytes] of a.files) assert.ok(bytes.equals(b.files.get(name)), `${name} differs`);
    assert.equal(b.current.bytes, a.current.bytes);
    assert.deepEqual(untimed(b.current.stats), untimed(a.current.stats));
    assert.ok(a.files.has('c/f6.glb') && a.files.has('c/d0.glb') && a.files.has('tileset.json') && a.files.has('objects.bin'));
    // A third build over the split one (no records: every tile built again), compared with it before it replaces it.
    const { stdout } = await build(split, path.join(split, 'work2'), { DIAG_OPTIONS: svf ? 'svf=1,compare=1' : 'compare=1', TILES3D_STAGE: 'all' });
    assert.match(stdout, new RegExp(`Compare with runs/[\\w-]+: ${a.files.size} same, 0 different, 0 gone, 0 new`));
    assert.match(stdout, /Plan: runs\/[\w-]+; 0 of 7 tiles kept from their records, 7 to build/);
    if (svf) {
      const s = a.current.stats;
      assert.equal(s.svf.firstPass.missing, 1, 'the lost fragment was found');
      assert.equal(s.svf.rebuiltTiles, 1);
      assert.equal(s.svf.missing.fragments, 0, 'and added');
      assert.ok(s.skins.pushed > 0, 'the weaving layer goes behind the solid');
    }
  });

  test(`${svf ? 'svf=1' : 'plain'}: a build keeps the unchanged tiles' records and publishes what a fresh build does`, { timeout: 240_000 }, async () => {
    const site = tmp(), fresh = tmp(), records = path.join(site, 'records');
    makeSite(site);
    const mode = svf ? { DIAG_OPTIONS: 'svf=1' } : {}, folder = svf ? 'tiles3d-svf' : 'tiles3d';
    await build(site, path.join(site, 'w1'), { ...mode, TILES3D_STAGE: 'all', TILES3D_RECORDS: records });
    const first = published(site, folder, records);
    assert.equal(recs(records).length, svf ? 8 : 7, 'a record per tile (and the rebuild)');
    const costs = JSON.parse(fs.readFileSync(path.join(records, 'costs.json'), 'utf8')).seconds;
    assert.ok(costs.length === 7 && costs.every(c => typeof c === 'number'), "every tile's build time kept for the next plan");

    // What a build that stopped before publishing leaves (a stored file nobody lists, its run folder) goes first.
    const base = path.join(site, PREFIX, folder), strayFile = path.join(base, 'files', `${'e'.repeat(64)}.glb`), strayRun = path.join(base, 'runs', 'stopped');
    fs.writeFileSync(strayFile, 'x'); fs.mkdirSync(strayRun); fs.writeFileSync(path.join(strayRun, 'tileset.json'), 'x');
    // Nothing changed: no tile built, the same files (nothing uploaded but the run's own two).
    const again = await build(site, path.join(site, 'w2'), { ...mode, TILES3D_STAGE: 'all', TILES3D_RECORDS: records });
    assert.match(again.stdout, /Removed 2 stored files nothing lists/);
    assert.ok(!fs.existsSync(strayFile) && !fs.existsSync(strayRun));
    assert.match(again.stdout, /7 of 7 tiles kept from their records, 0 to build/);
    const second = published(site, folder, records);
    assert.notEqual(second.current.run, first.current.run);
    assert.deepEqual(second.current.hash, first.current.hash);
    assert.deepEqual(built(second.current.stats), built(first.current.stats));
    assert.deepEqual(second.current.stats.incremental, { tiles: 7, built: 0, kept: 7, rebuilt: svf ? 1 : 0, rebuiltKept: svf ? 1 : 0 });
    assert.match(again.stdout, /Tileset: \d+ files, [\d.]+ MB \(2 uploaded now/);

    // Tile 3 changed: the plan builds it alone (in parts), and the result is a fresh build's of the changed site.
    makeSite(site, { tweak: true }); makeSite(fresh, { tweak: true });
    const work = path.join(site, 'w3'), env = { ...mode, TILES3D_RECORDS: records };
    const planned = await build(site, work, { ...env, TILES3D_STAGE: 'plan', TILES3D_PARTS: '3' });
    assert.match(planned.stdout, /6 of 7 tiles kept from their records, 1 to build in 1 part\(s\) of 1 tiles/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8')).parts, [[3]]);
    await build(site, work, { ...env, TILES3D_STAGE: 'leaves', TILES3D_PART: '0' });
    await build(site, work, { ...env, TILES3D_STAGE: 'finalize' });
    await build(fresh, path.join(fresh, 'w'), { ...mode, TILES3D_STAGE: 'all' });
    const third = published(site, folder, records), clean = published(fresh, folder, path.join(fresh, 'w', 'records'));
    assert.deepEqual(third.current.hash, clean.current.hash);
    assert.deepEqual(built(third.current.stats), built(clean.current.stats));
    assert.equal(third.current.stats.incremental.built, 1);
    assert.notEqual(third.current.hash['c/d3.glb'], first.current.hash['c/d3.glb']);
    assert.equal(third.current.hash['c/d4.glb'], first.current.hash['c/d4.glb']);
    assert.equal(recs(records).length, svf ? 8 : 7, "tile 3's old record dropped");
    // A build that stops before publishing (compare=strict, tile 3 back as it was) keeps what it built: its record and
    // the build times; the next build keeps every tile.
    makeSite(site);
    fs.rmSync(path.join(records, 'costs.json'));
    const stopped = await build(site, path.join(site, 'w5'), { ...mode, DIAG_OPTIONS: `${svf ? 'svf=1,' : ''}compare=strict`, TILES3D_STAGE: 'all', TILES3D_RECORDS: records })
      .then(() => null, e => e);
    assert.ok(stopped && /compare=strict: this run differs/.test(stopped.stderr), 'the strict comparison stops it');
    assert.equal(JSON.parse(fs.readFileSync(path.join(records, 'costs.json'), 'utf8')).seconds.length, 7);
    const after = await build(site, path.join(site, 'w6'), { ...mode, TILES3D_STAGE: 'all', TILES3D_RECORDS: records });
    assert.match(after.stdout, /7 of 7 tiles kept from their records, 0 to build/);
    assert.deepEqual(published(site, folder, records).current.hash, first.current.hash, 'tile 3 as first built');
    makeSite(site, { tweak: true });
    await build(site, path.join(site, 'w7'), { ...mode, TILES3D_STAGE: 'all', TILES3D_RECORDS: records });
    // The old d3 is gone from the store (nothing lists it); a damaged record is built again.
    assert.ok(!fs.existsSync(path.join(site, PREFIX, folder, 'files', `${first.current.hash['c/d3.glb']}.glb`)));
    const victim = recs(records)[0];
    fs.writeFileSync(path.join(records, victim), 'broken');
    const repaired = await build(site, path.join(site, 'w4'), { ...mode, TILES3D_STAGE: 'all', TILES3D_RECORDS: records });
    assert.match(repaired.stdout, svf ? /[67] of 7 tiles kept from their records, [01] to build/ : /6 of 7 tiles kept from their records, 1 to build/);
    assert.deepEqual(published(site, folder, records).current.hash, clean.current.hash);
  });
}

test('parts: runs of neighbours dealt round; one part keeps the order; records survive the file', () => {
  const items = Array.from({ length: 10 }, (_, k) => ({ key: k, centre: [k * 10, 0, 0] }));
  assert.deepEqual(partition(items, 1), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  const parts = partition(items, 3, 2);
  assert.deepEqual(parts.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parts.map(p => p.length), [4, 4, 2]);
  for (const p of parts) for (let k = 0; k + 1 < p.length; k += 2) assert.equal(Math.abs(p[k + 1] - p[k]), 1, 'a run is two neighbours');
  // With costs: the costliest run alone, the others shared by the cheaper parts (each part in site order).
  assert.deepEqual(partition(items.map(it => ({ ...it, cost: it.key < 2 ? 10 : 1 })), 3, 2), [[0, 1], [2, 3, 6, 7], [4, 5, 8, 9]]);
  const file = path.join(tmp(), 'r.rec');
  const g = { pos: Float64Array.from([1.5, 2, 3]), rgba: Uint8Array.from([1, 2, 3, 4]), ids: Float32Array.from([7]), idx: Uint32Array.from([0, 0, 0]), skin: Float32Array.from([9]) };
  writeRecord(file, { tile: 4, files: [['c/d4.glb', { bytes: 9, hash: 'ab' }]] }, { opaque: g, transparent: null, boxes: { ids: Uint32Array.from([7]), box: new Float32Array(6) } });
  const back = readRecord(file);
  assert.deepEqual(back.meta, { tile: 4, files: [['c/d4.glb', { bytes: 9, hash: 'ab' }]] });
  assert.deepEqual(back.sections.opaque, g);
  assert.equal(back.sections.transparent, undefined);
  assert.deepEqual(readRecord(file, { metaOnly: true }).meta, back.meta);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['r.rec'], 'written beside and renamed into place');
  fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 40));
  assert.throws(() => readRecord(file), /Corrupt record/);
  // Sealed: nothing readable without the key, the right key gives it back, a wrong one or none is refused.
  const key = Buffer.alloc(32, 7), sealed = path.join(path.dirname(file), 's.rec');
  writeRecord(sealed, { tile: 4, name: 'readable?' }, { opaque: g }, key);
  assert.ok(!fs.readFileSync(sealed).includes('readable?'));
  assert.deepEqual(readRecord(sealed, { key }).sections.opaque, g);
  assert.deepEqual(readRecord(sealed, { metaOnly: true, key }).meta, { tile: 4, name: 'readable?' });
  assert.throws(() => readRecord(sealed, { key: Buffer.alloc(32, 8) }));
  assert.throws(() => readRecord(sealed), /sealed: no key/);
  assert.throws(() => readRecord(path.join(path.dirname(file), 'r.rec'), { key }), /Corrupt record|not sealed/);
  fs.renameSync(sealed, path.join(path.dirname(file), 't.rec')); // its name is part of the seal: a record moved to another key is refused
  assert.throws(() => readRecord(path.join(path.dirname(file), 't.rec'), { key }));
  // Deflated before sealing: a compressible body takes a fraction of its size; flags 1 (sealed, not deflated) still read.
  const big = { pos: new Float64Array(100000).fill(1.25) }, packed = path.join(path.dirname(file), 'big.rec');
  writeRecord(packed, { tile: 1 }, { opaque: big }, key);
  assert.ok(fs.statSync(packed).size < 100000, `${fs.statSync(packed).size} bytes`);
  assert.equal(readRecord(packed, { key }).deflated, true);
  assert.deepEqual(readRecord(packed, { key }).sections.opaque, big);
});

test('sealed records: kept between builds with the same secret, built again with another, never readable in the file', { timeout: 240_000 }, async () => {
  const site = tmp(), records = path.join(site, 'records'), key = s => Buffer.from(hkdfSync('sha256', s, 'mir-tiles3d-records', 'record key v1', 32));
  makeSite(site);
  await build(site, path.join(site, 'w1'), { DIAG_OPTIONS: 'svf=1', TILES3D_RECORDS: records, TILES3D_RECORD_SECRET: 'first' });
  const first = published(site, 'tiles3d-svf', records, key('first'));
  for (const f of recs(records)) assert.ok(!fs.readFileSync(path.join(records, f)).includes('"leaf"'), `${f} is sealed`);
  const again = await build(site, path.join(site, 'w2'), { DIAG_OPTIONS: 'svf=1', TILES3D_RECORDS: records, TILES3D_RECORD_SECRET: 'first' });
  assert.match(again.stdout, /7 of 7 tiles kept from their records, 0 to build/);
  const other = await build(site, path.join(site, 'w3'), { DIAG_OPTIONS: 'svf=1', TILES3D_RECORDS: records, TILES3D_RECORD_SECRET: 'second' });
  assert.match(other.stdout, /0 of 7 tiles kept from their records, 7 to build/);
  assert.deepEqual(published(site, 'tiles3d-svf', records, key('second')).current.hash, first.current.hash);
});

test('code fingerprint: comments and layout do not count, code, line breaks before a token, modules and packages do', () => {
  const dir = tmp(), entry = path.join(dir, 'entry.mjs'), dep = path.join(dir, 'dep.mjs'), worker = path.join(dir, 'w.mjs');
  const MARK = '// ─── end ───';
  const write = (code, depCode = "export const k = 1; // one\n", workerCode = 'postMessage(1);\n') => {
    fs.writeFileSync(entry, code); fs.writeFileSync(dep, depCode); fs.writeFileSync(worker, workerCode);
    return codeFingerprint(entry, { marker: MARK });
  };
  const base = "import { k } from './dep.mjs';\nimport meshopt from 'meshoptimizer';\n// a note\nfunction f(x) {\n  return x + k; /* sum */\n}\nnew Worker(new URL('./w.mjs', import.meta.url));\n" + MARK + "\nconsole.log('stages');\n";
  const fp = write(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(write(base.replace('// a note', '// another note\n/** and more */')), fp, 'comments');
  assert.equal(write(base.replace('return x + k;', 'return   x+k;')), fp, 'spacing');
  assert.equal(write(base.replace("console.log('stages');", "console.log('other stages');")), fp, 'below the marker');
  assert.notEqual(write(base.replace('x + k', 'x - k')), fp, 'code');
  assert.notEqual(write(base.replace('return x + k;', 'return\nx + k;')), fp, 'a line break that ends a statement');
  assert.notEqual(write(base, 'export const k = 2;\n'), fp, 'an imported module');
  assert.equal(write(base, 'export const k = 1; // changed comment\n'), fp);
  assert.notEqual(write(base, undefined, 'postMessage(2);\n'), fp, 'a worker module');
  assert.throws(() => write(base.replace(MARK, '// no marker')), /No line/);
  // The package's version: a stand-in node_modules beside the files.
  fs.mkdirSync(path.join(dir, 'node_modules', 'meshoptimizer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'meshoptimizer', 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const withPackage = write(base);
  fs.writeFileSync(path.join(dir, 'node_modules', 'meshoptimizer', 'package.json'), JSON.stringify({ version: '9.9.10' }));
  assert.notEqual(write(base), withPackage, 'a package version');
});
