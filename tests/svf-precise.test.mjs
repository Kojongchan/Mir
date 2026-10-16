import test from 'node:test';
import assert from 'node:assert/strict';
import { fragmentMatrix, placeMesh, fragmentMatcher, refineMeshes } from '../scripts/svf-precise.mjs';
import { indexFragments } from '../scripts/entity-alias.mjs';

const apply = (m, [x, y, z]) => [0, 1, 2].map(a => m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a]);
const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('fragment transforms: translation, rotation with uniform scale, affine matrix (column order)', () => {
  assert.ok(close(apply(fragmentMatrix({ t: { x: 1, y: 2, z: 3 } }), [1, 1, 1]), [2, 3, 4]));
  // 90° about Z (q = (0, 0, sin 45°, cos 45°)), scale 0.3048 (feet), then translate.
  const h = Math.SQRT1_2;
  const m = fragmentMatrix({ q: { x: 0, y: 0, z: h, w: h }, s: { x: 0.3048, y: 0.3048, z: 0.3048 }, t: { x: 10, y: 0, z: 0 } });
  assert.ok(close(apply(m, [1, 0, 0]), [10, 0.3048, 0], 1e-12));
  assert.ok(close(apply(m, [0, 1, 0]), [10 - 0.3048, 0, 0], 1e-12));
  // Affine: the stored 3×3 is read column by column (first three numbers = image of the x axis).
  const a = fragmentMatrix({ matrix: [0, 2, 0, -1, 0, 0, 0, 0, 1], t: { x: 5, y: 6, z: 7 } });
  assert.ok(close(apply(a, [1, 0, 0]), [5, 8, 7]));
  assert.ok(close(apply(a, [0, 1, 0]), [4, 6, 7]));
  assert.ok(close(apply(fragmentMatrix(null), [1, 2, 3]), [1, 2, 3]));
});

test('placed meshes keep sub-millimetre precision at survey coordinates', () => {
  const origin = [222022, 452924, 189];
  const { pos, idx } = placeMesh(Float32Array.from([0.25, -0.5, 1.125]), [0, 0, 0], fragmentMatrix({ t: { x: 222030.123456, y: 452930.654321, z: 190.5 } }), origin);
  assert.ok(close([...pos], [8.373456, 6.154321, 2.625], 1e-6));
  assert.ok(idx instanceof Uint32Array);
});

// A tile entity and its fragment: an axis-aligned box mesh in survey coordinates.
const boxMesh = (x, y, z, sx, sy, sz) => ({
  vertices: Float32Array.from([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].flatMap(([a, b, c]) => [a * sx, b * sy, c * sz])),
  indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
  t: { x, y, z }, bbox: [x, y, z, x + sx, y + sy, z + sz],
});
const origin = [214000, 395000, 30];
const shifted = b => b.map((v, a) => v - origin[a % 3]);

test('candidates: a named entity\'s own object only; a renamed one any object named in the file; loose boxes of rotated pieces', () => {
  const src = [
    { dbId: 10, ...boxMesh(214100, 395100, 40, 2, 1, 1) },        // 0
    { dbId: 10, ...boxMesh(214103, 395100, 40, 2, 1, 1) },        // 1: second piece of 10
    { dbId: 11, ...boxMesh(214103, 395100, 40, 2, 1, 1) },        // 2: same box, object 11 (named in the file)
    { dbId: 12, bbox: [214199.5, 395099.5, 39.5, 214202.5, 395102.5, 42.5] }, // 3: rotated geometry's loose box
    { dbId: 13, ...boxMesh(214103, 395100, 40, 2, 1, 1) },        // 4: same box, object 13 (not in the file)
  ];
  const fragments = indexFragments(src.map(f => ({ dbId: f.dbId, bbox: f.bbox })));
  const candidates = fragmentMatcher(fragments, origin);
  const boxes = Float64Array.from([src[0].bbox, src[1].bbox, src[1].bbox, [214200.2, 395100.1, 40.3, 214201.8, 395101.9, 41.7], [214500, 395500, 40, 214501, 395501, 41]]
    .flatMap(shifted).map((v, i) => v + (i % 2 ? 0.004 : -0.004))); // quantization error
  const file = { ids: ['10', 'entity-1', '11', '12', '10'], boxes, steps: new Float64Array(5 * 3).fill(0.005) };
  const out = candidates(file, [10, 10, 11, 12, 10]);
  assert.deepEqual(out[0], [0]);
  assert.deepEqual([...out[1]].sort(), [1, 2], 'renamed: pieces of 10 and 11 (both named here), not of 13');
  assert.deepEqual(out[2], [2], 'named 11: its own piece only');
  assert.deepEqual(out[3], [3], 'contained in the loose box');
  assert.deepEqual(out[4], []);
});

test('the geometry picks the fragment (and owner) of each entity; a fragment off the entity is refused', () => {
  const quantize = (p, step) => Float64Array.from(p, v => Math.round(v / step) * step);
  const place = m => placeMesh(m.vertices, m.indices, fragmentMatrix({ t: m.t }), origin);
  const a = boxMesh(214100.0037, 395100.0041, 40.0029, 2, 1, 1), b = boxMesh(214110, 395100, 40, 1, 1, 1);
  // c: same box as a, but a wedge (only the bottom corners and one top edge): a different piece of another object.
  const c = { ...a, vertices: Float32Array.from([0,0,0, 2,0,0, 2,1,0, 0,1,0, 0,0,1, 2,0,1]), indices: [0,1,2, 0,2,3, 0,1,5, 0,5,4, 3,2,5, 3,5,4, 0,3,4, 1,2,5] };
  const pa = place(a), pb = place(b), pc = place(c);
  const step = 0.02; // a 2 cm grid, as the U-channel's
  const meshes = [
    { entity: 0, world: quantize(pa.pos, step), tri: Uint32Array.from(a.indices), rgba: [180, 180, 180, 255], textured: false },
    { entity: 1, world: quantize(pb.pos, step).map((v, i) => (i % 3 === 0 ? v + 3 : v)), tri: Uint32Array.from(b.indices), rgba: [0, 160, 0, 255], textured: false },
    { entity: 2, world: quantize(pb.pos, step), tri: Uint32Array.from(b.indices), rgba: [90, 90, 90, 255], textured: false },
    { entity: 3, world: quantize(pc.pos, step), tri: Uint32Array.from(c.indices), rgba: [200, 100, 0, 255], textured: false },
  ];
  // Entity 0 lists the wedge first (its box fits as well); entity 3 is the wedge, listed after the box piece.
  const pieces = new Map([[7, pa], [8, pb], [9, pc]]);
  const { meshes: out, owner, stats } = refineMeshes(meshes, [[9, 7], [8], [], [7, 9]], new Float64Array(12).fill(step), f => pieces.get(f));
  assert.deepEqual([...owner], [7, -1, -1, 9]);
  const first = out.find(m => m.entity === 0);
  assert.equal(first.world, pa.pos);
  assert.deepEqual(first.rgba, [180, 180, 180, 255]);
  assert.equal(out.find(m => m.entity === 1).world, meshes[1].world, 'fragment 3 m away: kept as decoded');
  assert.equal(out.find(m => m.entity === 2).world, meshes[2].world, 'no candidate: kept');
  assert.equal(out.find(m => m.entity === 3).world, pc.pos);
  assert.deepEqual({ entities: stats.entities, matched: stats.matched, replaced: stats.replaced, rejected: stats.rejected, noCandidate: stats.noCandidate },
    { entities: 4, matched: 3, replaced: 2, rejected: 1, noCandidate: 1 });
  assert.ok(stats.shiftMm.every(mm => mm <= 17), `shifts ${stats.shiftMm} mm are within half a grid step`);
});
