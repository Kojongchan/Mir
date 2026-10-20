import test from 'node:test';
import assert from 'node:assert/strict';
import { curvedVertices, nearOther } from '../scripts/clearance.mjs';
import { simplifyGroup } from '../scripts/tiles3d.mjs';

/** UV sphere (closed) of object `id`, radius r, centre (0, 0, 0), as a group. */
function sphere(r, id, rings = 48, segments = 96) {
  const pos = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = (Math.PI * i) / rings;
    for (let j = 0; j < segments; j++) {
      const p = (2 * Math.PI * j) / segments;
      pos.push(r * Math.sin(t) * Math.cos(p), r * Math.sin(t) * Math.sin(p), r * Math.cos(t));
    }
  }
  // One vertex per pole (welded), so the sphere has no border.
  const at = (i, j) => (i === 0 ? 0 : i === rings ? (rings - 1) * segments + 1 : (i - 1) * segments + 1 + (j % segments));
  const welded = [pos[0], pos[1], pos[2]];
  for (let i = 1; i < rings; i++) for (let j = 0; j < segments; j++) welded.push(...pos.slice((i * segments + j) * 3, (i * segments + j) * 3 + 3));
  welded.push(...pos.slice(rings * segments * 3, rings * segments * 3 + 3));
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
    const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
    if (i > 0) idx.push(a, c, b);
    if (i < rings - 1) idx.push(b, c, d);
  }
  const n = welded.length / 3;
  return { pos: Float64Array.from(welded), rgba: new Uint8Array(n * 4).fill(200), ids: new Float32Array(n).fill(id), idx: Uint32Array.from(idx) };
}
const join = (a, b) => {
  const n = a.ids.length;
  return { pos: Float64Array.from([...a.pos, ...b.pos]), rgba: Uint8Array.from([...a.rgba, ...b.rgba]), ids: Float32Array.from([...a.ids, ...b.ids]),
    idx: Uint32Array.from([...a.idx, ...Array.from(b.idx, v => v + n)]) };
};
/** Share of rays from 20 m out toward the centre whose first hit is object `id`. */
function firstHitShare(g, id) {
  let hits = 0, rays = 0;
  for (let k = 0; k < 400; k++) {
    const z = 1 - (2 * (k + 0.5)) / 400, r = Math.sqrt(1 - z * z), phi = k * 2.399963;
    const d = [-r * Math.cos(phi), -r * Math.sin(phi), -z], o = d.map(x => -20 * x);
    let best = Infinity, who = 0;
    for (let t = 0; t < g.idx.length; t += 3) {
      const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map(v => [g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]]);
      const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const s = o.map((x, i) => x - a[i]), u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > 0 && tt < best) { best = tt; who = g.ids[g.idx[t]]; }
    }
    if (who) { rays++; if (who === id) hits++; }
  }
  return hits / rays;
}

test('curved vertices: a flat grid has none, a sphere is all curved', () => {
  const grid = { pos: Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0]), idx: Uint32Array.from([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]) };
  assert.deepEqual([...curvedVertices(grid, 6)], [0, 0, 0, 0, 0, 0]);
  const s = sphere(5, 1, 12, 24);
  assert.ok(curvedVertices(s, s.ids.length).every(x => x === 1));
});

test('distance to another object: two layers 3 cm apart, and a far object', async () => {
  const outer = sphere(5, 1, 12, 24), inner = sphere(4.97, 2, 12, 24), far = sphere(1, 3, 6, 12);
  far.pos = far.pos.map((x, i) => (i % 3 === 0 ? x + 50 : x));
  const [near, none] = await nearOther([join(outer, inner), far], 1);
  // Each vertex of a layer is within the gap (plus the other layer's chord sag) of the other layer.
  assert.ok(near.every(d => d < 0.1), `max ${Math.max(...near)}`);
  assert.ok(near.some(d => d < 0.031));
  assert.ok(none.every(d => d === 1), 'nothing within reach');
});

test('a simplified copy keeps the outer layer outside when vertices near another object are locked', async () => {
  const g = join(sphere(5, 1), sphere(4.97, 2)); // shotcrete over lining, 3 cm apart
  assert.equal(firstHitShare(g, 2), 0, 'the original shows only the outer layer');
  const plain = await simplifyGroup(g, 0.1, { minHeight: 0, lockBorder: true });
  assert.ok(plain.idx.length < g.idx.length / 2, 'the plain copy is coarser');
  assert.ok(firstHitShare(plain, 2) > 0.02, 'the inner layer shows through the plain copy');
  const [near] = await nearOther([g], 0.1);
  const locked = await simplifyGroup(g, 0.1, { minHeight: 0, lockBorder: true, lock: Uint8Array.from(near, d => (d < 0.1 ? 1 : 0)) });
  assert.equal(firstHitShare(locked, 2), 0, 'with the layers locked the inner one stays hidden');
});
