import test from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, referencedXkt, withoutLight, otherGroups, MODEL } from '../scripts/r2-cleanup.mjs';

const old = new Date('2026-11-01T00:00:00Z'), now = Date.parse('2026-11-26T12:00:00Z');
const manifest = {
  xktFiles: ['c0.xkt', 'c1.xkt'], base: ['b0.xkt'],
  chunkInfo: { 'runs/l3/light0.xkt': { kind: 'motion', byteLength: 1 }, 'c0.xkt': { byteLength: 1 } },
  tiles: [{ n: 'c0.xkt', aabb: [0, 0, 0, 1, 1, 1], far: { n: 'runs/f2/far0.xkt', policy: 'merged-far-v5' }, motion: { n: 'runs/l3/light0.xkt' } },
    { n: 'c1.xkt', aabb: [0, 0, 0, 1, 1, 1], motion: { n: 'runs/l3/light1.xkt' } }],
};
const obj = (key, bytes = 10, modified = old) => ({ key, bytes, modified });
const kept = ['c0.xkt', 'c1.xkt', 'b0.xkt', 'runs/f2/far0.xkt'].map(n => obj(`${MODEL}/xkt/${n}`));
const light = ['runs/l3/light0.xkt', 'runs/l3/light1.xkt'].map(n => obj(`${MODEL}/xkt/${n}`, 300));
const bucket = [
  ...kept, ...light, obj(`${MODEL}/xkt/manifest.json`),
  obj(`${MODEL}/xkt/runs/f1/far0.xkt`, 500),                                // previous far generation
  obj(`${MODEL}/xkt/runs/f9/far0.xkt`, 500, new Date(now - 3600_000)),      // written an hour ago: kept
  obj(`${MODEL}/tiles3d/runs/r/tileset.json`), obj(`${MODEL}/tiles3d/files/aa.glb`, 900), obj(`${MODEL}/tiles3d/current.json`),
  obj(`${MODEL}/tiles3d-svf/current.json`), obj(`${MODEL}/tiles3d-svf/files/bb.glb`, 900), obj(`${MODEL}/meta/g1/tree.json`),
  obj(`${MODEL}/claim.json`), obj(`${MODEL}X/xkt/c0.xkt`),                     // another model whose id starts the same
  obj('files/0123.json'), obj('abc123/alias.json'), obj('oldglb/model.glb', 7000),
];

test('light pairs leave the manifest; far, originals and everything else it names stay', () => {
  const { manifest: next, dropped } = withoutLight(manifest);
  assert.deepEqual(dropped.sort(), ['runs/l3/light0.xkt', 'runs/l3/light1.xkt']);
  assert.ok(!next.tiles.some(t => t.motion));
  assert.ok(!('runs/l3/light0.xkt' in next.chunkInfo) && 'c0.xkt' in next.chunkInfo);
  assert.ok(manifest.tiles[0].motion, 'the input manifest is not changed');
  assert.deepEqual([...referencedXkt(MODEL, next)].sort(), kept.map(o => o.key).sort());
});

test('removes the plain tileset, light pairs and old generations only', () => {
  const plan = planCleanup(bucket, manifest, now);
  const keys = plan.deletions.map(d => d.key).sort();
  assert.deepEqual(keys, [
    `${MODEL}/tiles3d/current.json`, `${MODEL}/tiles3d/files/aa.glb`, `${MODEL}/tiles3d/runs/r/tileset.json`,
    `${MODEL}/xkt/runs/f1/far0.xkt`, ...light.map(o => o.key),
  ].sort());
  for (const o of kept) assert.ok(!keys.includes(o.key), `in use: ${o.key}`);
  assert.ok(!keys.some(k => k.includes('tiles3d-svf') || k.includes('/meta/') || k.endsWith('claim.json') || k.startsWith('files/') || k.includes('alias')));
  assert.ok(plan.manifestAfter && !plan.manifestAfter.tiles.some(t => t.motion));
  assert.ok(plan.skipped.some(s => s.includes('runs/f9/far0.xkt')), 'a fresh file is kept and reported');
});

test('no model XKT is removed when the manifest and the bucket disagree', () => {
  const plan = planCleanup(bucket.filter(o => o.key !== `${MODEL}/xkt/runs/f2/far0.xkt`), manifest, now);
  assert.ok(!plan.deletions.some(d => d.key.startsWith(`${MODEL}/xkt/`)));
  assert.equal(plan.manifestAfter, null);
  assert.ok(plan.skipped.some(s => s.includes('missing')));
});

test('other groups are listed for review, the model is not', () => {
  const groups = otherGroups(bucket).map(g => g.prefix);
  assert.ok(!groups.includes(MODEL) && groups.includes('oldglb') && groups.includes('files'));
});
