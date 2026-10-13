import test from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, referencedXkt, MODEL, EXACT } from '../scripts/r2-cleanup.mjs';

const old = new Date('2026-10-01T00:00:00Z'), now = Date.parse('2026-10-13T12:00:00Z');
const manifest = {
  xktFiles: ['c0.xkt', 'c1.xkt'], base: ['b0.xkt'],
  tiles: [{ n: 'c0.xkt', aabb: [0, 0, 0, 1, 1, 1], far: { n: 'runs/f2/far0.xkt', policy: 'merged-far-v5' }, motion: { n: 'runs/l3/light0.xkt' } },
    { n: 'c1.xkt', aabb: [0, 0, 0, 1, 1, 1] }],
};
const obj = (key, bytes = 10, modified = old) => ({ key, bytes, modified });
const live = ['c0.xkt', 'c1.xkt', 'b0.xkt', 'runs/f2/far0.xkt', 'runs/l3/light0.xkt'].map(n => obj(`${MODEL}/xkt/${n}`));
const exact = EXACT.flatMap(t => Array.from({ length: t.objects }, (_, k) => obj(`${t.prefix}/f${k}.glb`, k === 0 ? t.bytes - (t.objects - 1) : 1)));
const bucket = [
  ...live, obj(`${MODEL}/xkt/manifest.json`),
  obj(`${MODEL}/xkt/runs/f1/far0.xkt`, 500),   // previous far generation: old
  obj(`${MODEL}/xkt/c0-v1.xkt`, 700),          // replaced detail file: old
  obj(`${MODEL}/xkt/runs/l4/light0.xkt`, 300, new Date(now - 3600_000)), // written an hour ago: kept
  obj(`${MODEL}/meta/runs/g1/tree.json`), obj(`${MODEL}/tiles3d/runs/r/c/f0.glb`), obj(`${MODEL}/xkt/notes.json`),
  obj(`${MODEL}X/xkt/c0.xkt`),                 // another model whose id starts the same: untouched
  obj('validatezellipsesplineX/a.glb'), obj('79665194b513cd7e7da62c0be25681b6a71114ab/claim.json'),
  ...exact,
];

test('the manifest decides what is in use: every .xkt string anywhere in it', () => {
  const refs = referencedXkt(MODEL, manifest);
  assert.deepEqual([...refs].sort(), live.map(o => o.key).sort());
  assert.throws(() => referencedXkt(MODEL, { tiles: [{ n: '../other/x.xkt' }] }), /Unsafe/);
});

test('cleanup removes only old generations of the model and the approved exact groups', () => {
  const plan = planCleanup(bucket, manifest, now);
  const keys = plan.deletions.map(d => d.key).sort();
  const expected = [`${MODEL}/xkt/runs/f1/far0.xkt`, `${MODEL}/xkt/c0-v1.xkt`, ...exact.map(o => o.key)].sort();
  assert.deepEqual(keys, expected);
  for (const o of live) assert.ok(!keys.includes(o.key), `in use: ${o.key}`);
  assert.ok(plan.skipped.some(s => s.includes('runs/l4/light0.xkt')), 'a fresh file is kept and reported');
});

test('nothing of the model is removed when the manifest and the bucket disagree; changed groups are kept', () => {
  const withoutFar = bucket.filter(o => o.key !== `${MODEL}/xkt/runs/f2/far0.xkt`);
  const plan = planCleanup(withoutFar, manifest, now);
  assert.ok(!plan.deletions.some(d => d.key.startsWith(`${MODEL}/`)));
  assert.ok(plan.skipped.some(s => s.includes('missing')));
  const grown = [...bucket, obj(`${EXACT[0].prefix}/extra.glb`)];
  const plan2 = planCleanup(grown, manifest, now);
  assert.ok(!plan2.deletions.some(d => d.key.startsWith(`${EXACT[0].prefix}/`)), 'a group that changed since the inventory is kept');
  assert.ok(plan2.deletions.some(d => d.key.startsWith(`${EXACT[1].prefix}/`)));
});
