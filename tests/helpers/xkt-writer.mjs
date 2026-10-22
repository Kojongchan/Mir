// XKT v12 files for tests (the layout scripts/tile-lod-merge.mjs reads): one internal tile, one geometry per mesh,
// positions quantized to the tile's box.

/**
 * `entities`: [{ id: '123' (a dbId) or 'entity-N', meshes: [{ world: number[] (x, y, z…), tri: number[] (per mesh),
 * rgba: [r, g, b, a] }] }] → Buffer.
 */
export function writeXkt(entities) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const e of entities) for (const m of e.meshes) for (let k = 0; k < m.world.length; k++) {
    box[k % 3] = Math.min(box[k % 3], m.world[k]); box[k % 3 + 3] = Math.max(box[k % 3 + 3], m.world[k]);
  }
  for (let a = 0; a < 3; a++) if (box[a + 3] - box[a] < 1e-3) box[a + 3] = box[a] + 1e-3;
  const step = [0, 1, 2].map(a => (box[a + 3] - box[a]) / 65535);
  const pos = [], idx = [], pp = [], ip = [], mg = [], mm = [], attrs = [], em = [], prim = [], matrices = [];
  for (const e of entities) {
    em.push(mg.length);
    for (const m of e.meshes) {
      pp.push(pos.length); ip.push(idx.length);
      for (let k = 0; k < m.world.length; k++) pos.push(Math.round((m.world[k] - box[k % 3]) / step[k % 3]));
      idx.push(...m.tri);
      prim.push(0);
      mm.push(matrices.length); matrices.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
      mg.push(mg.length);
      attrs.push(m.rgba[0], m.rgba[1], m.rgba[2], m.rgba[3], 0, 255);
    }
  }
  const zeros = pp.map(() => 0);
  const slots = Array.from({ length: 29 }, () => Buffer.alloc(0));
  const put = (s, T, v) => { slots[s] = Buffer.from(T.from(v).buffer); };
  slots[0] = Buffer.from('{}'); slots[14] = Buffer.from('[]'); slots[25] = Buffer.from(JSON.stringify(entities.map(e => e.id)));
  put(4, Uint16Array, pos); put(8, Uint32Array, idx); put(11, Float32Array, matrices); put(13, Uint8Array, prim);
  put(15, Uint32Array, pp); put(16, Uint32Array, zeros); put(17, Uint32Array, zeros); put(18, Uint32Array, zeros);
  put(19, Uint32Array, ip); put(20, Uint32Array, zeros); put(21, Uint32Array, mg); put(22, Uint32Array, mm);
  put(23, Int32Array, mg.map(() => -1)); put(24, Uint8Array, attrs); put(26, Uint32Array, em);
  put(27, Float64Array, box); put(28, Uint32Array, [0]);
  const head = Buffer.alloc(236), out = [head];
  head.writeUInt32LE(12);
  let len = 236;
  slots.forEach((b, s) => {
    const pad = (8 - (len % 8)) % 8;
    out.push(Buffer.alloc(pad)); len += pad;
    head.writeUInt32LE(len, 4 + s * 8); head.writeUInt32LE(b.length, 8 + s * 8);
    out.push(b); len += b.length;
  });
  return Buffer.concat(out);
}

/** A closed box [x0, y0, z0, x1, y1, z1]; `top(x, y)` lifts the top corners (a weaving skin). */
export function boxMesh([x0, y0, z0, x1, y1, z1], top = () => 0) {
  const world = [], tri = [];
  for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
    world.push(x, y, z + (z === z1 ? top(x, y) : 0));
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) tri.push(a, b, c, a, c, d);
  return { world, tri };
}

/** A slab over [x0, x1] × [y0, y1] cut in n × n cells, top at z + zig(i, j), `thick` m thick. */
export function slabMesh([x0, y0, x1, y1], z, thick, n, zig = () => 0) {
  const world = [], tri = [], at = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (const k of [0, 1]) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++)
    world.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n, z + zig(i, j) - k * thick);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (const k of [0, 1]) {
    const [a, b, c, d] = [at(i, j, k), at(i + 1, j, k), at(i + 1, j + 1, k), at(i, j + 1, k)];
    if (k) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d);
  }
  for (let s = 0; s < n; s++) for (const [p, q] of [[at(s, 0, 0), at(s + 1, 0, 0)], [at(n, s, 0), at(n, s + 1, 0)], [at(s + 1, n, 0), at(s, n, 0)], [at(0, s + 1, 0), at(0, s, 0)]]) {
    const pb = p + (n + 1) * (n + 1), qb = q + (n + 1) * (n + 1);
    tri.push(p, q, qb, p, qb, pb);
  }
  return { world, tri };
}
