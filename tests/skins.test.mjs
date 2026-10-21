import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { containedSkins, applySkins } from '../scripts/skins.mjs';
import { encodeGlb, mergeGroups, simplifyGroup } from '../scripts/tiles3d.mjs';

/** A box [x0, y0, z0, x1, y1, z1] as a closed mesh; `top(x, y)` lifts the top corners (a zigzag skin). */
const box = ([x0, y0, z0, x1, y1, z1], top = () => 0) => {
  const pos = [], idx = [];
  for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
    pos.push(x, y, z + (z === z1 ? top(x, y) : 0));
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) idx.push(a, b, c, a, c, d);
  return { pos, idx };
};
/** A slab over [x0, x1] × [y0, y1] cut in n × n cells, top at z + zig(i, j), `thick` m thick (bottom follows the top). */
const slab = ([x0, y0, x1, y1], z, thick, n, zig) => {
  const pos = [], idx = [], at = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (const k of [0, 1]) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++)
    pos.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n, z + zig(i, j) - k * thick);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (const k of [0, 1]) {
    const [a, b, c, d] = [at(i, j, k), at(i + 1, j, k), at(i + 1, j + 1, k), at(i, j + 1, k)];
    idx.push(a, b, c, a, c, d);
  }
  for (let s = 0; s < n; s++) for (const [p, q] of [[at(s, 0, 0), at(s + 1, 0, 0)], [at(n, s, 0), at(n, s + 1, 0)], [at(s + 1, n, 0), at(s, n, 0)], [at(0, s + 1, 0), at(0, s, 0)]]) {
    const pb = p + (n + 1) * (n + 1), qb = q + (n + 1) * (n + 1);
    idx.push(p, q, qb, p, qb, pb);
  }
  return { pos, idx };
};
/** Objects { id: { pos, idx } } → one group (pos Float64, ids per vertex, rgba grey). */
const group = objects => mergeGroups(Object.entries(objects).map(([id, m]) => ({
  pos: Float64Array.from(m.pos), ids: new Float32Array(m.pos.length / 3).fill(Number(id)), rgba: new Uint8Array((m.pos.length / 3) * 4).fill(150),
  idx: Uint32Array.from(m.idx) })));
const partnersOf = (g, out) => {
  const per = new Map();
  for (let t = 0; t < g.idx.length / 3; t++) {
    const k = `${g.ids[g.idx[t * 3]]}→${out.partner[t]}`;
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  return Object.fromEntries(per);
};

test('a thin layer weaving ±8 cm about the top of a solid holding it is drawn behind it; the solid is not', async () => {
  // Excavation-like solid 1 (10 m), shotcrete-like layer 2 (10 cm) over 8 × 8 m of its top, its 2 m cells alternately
  // 8 cm above and below.
  const g = group({ 1: box([-5, -5, -5, 5, 5, 5]), 2: slab([-4, -4, 4, 4], 5, 0.1, 4, (i, j) => ((i + j) % 2 ? 0.08 : -0.08)) });
  const out = await containedSkins(g, null);
  const per = partnersOf(g, out);
  assert.equal(per['1→0'], 12, 'the solid keeps its depth');
  assert.equal(per['2→1'], 32, 'every top face of the layer goes behind the solid');
  assert.equal(per['2→0'], 32 + 32, 'its bottom and sides do not');
  // The solid's top corners are on the shared skin (kept in copies); so are the layer's top vertices.
  assert.ok(out.shared.some(x => x));
});

test('a panel 10 cm in front of a wall stays in front; of two equal layers the coarser goes behind', async () => {
  const wall = box([0, -5, 0, 10, 5, 10]), panel = box([10.1, -2, 1, 10.15, 2, 5]);
  const g = group({ 1: wall, 2: panel });
  const out = await containedSkins(g, null);
  assert.ok(!out.partner.some(p => p > 0), JSON.stringify(partnersOf(g, out)));
  // The same 20 cm deck twice: in 64 cells and in 1.
  const fine = slab([0, 0, 8, 8], 0, 0.2, 8, () => 0), coarse = slab([0, 0, 8, 8], 0, 0.2, 1, () => 0);
  const d = group({ 3: fine, 4: coarse });
  const per = partnersOf(d, await containedSkins(d, null));
  assert.ok(per['4→3'] >= 2 && !per['3→4'], JSON.stringify(per));
});

test('partners from other tiles count; split vertices carry their own partner into copies and the glb', async () => {
  const solid = group({ 1: box([-5, -5, -5, 5, 5, 5]) });
  const layer = group({ 2: slab([-4, -4, 4, 4], 5, 0.1, 4, (i, j) => ((i + j) % 2 ? 0.08 : -0.08)) });
  const out = await containedSkins(layer, solid); // the solid is in another tile
  const { group: split, lock } = applySkins(layer, out.partner, out.shared);
  assert.ok(split.ids.length > layer.ids.length, 'top rim vertices split between pushed tops and plain sides');
  assert.equal(lock.length, split.ids.length);
  for (let t = 0; t < split.idx.length / 3; t++) {
    const s = [0, 1, 2].map(k => split.skin[split.idx[t * 3 + k]]);
    assert.ok(s[0] === s[1] && s[1] === s[2], 'one partner per face');
    assert.equal(s[0], out.partner[t]);
  }
  const copy = await simplifyGroup(split, 0.3, { lockBorder: true, lock, minHeight: 0 });
  assert.ok(copy.skin && copy.skin.some(x => x === 1));
  const glb = (await encodeGlb({ opaque: split })).glb;
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', resolve, reject));
  let attr = null;
  gltf.scene.traverse(o => { if (o.isMesh) attr = o.geometry.getAttribute('_skin'); });
  assert.ok(attr && [...attr.array].includes(1) && [...attr.array].includes(0), 'the viewer reads _skin');
  // No partner: the group comes back unchanged, without the attribute.
  const alone = applySkins(solid, new Float32Array(solid.idx.length / 3), new Uint8Array(solid.ids.length));
  assert.equal(alone.group, solid);
});
