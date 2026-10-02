import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Merged level-of-detail XKT v12 for one streamed tile.
 *
 * The SDK creates one draw layer per XKT internal tile (origin = tile centre) and per primitive, so a
 * copy of the detail file keeps ~40 layers. This rewrite:
 *   - merges every internal tile into ONE tile (one origin, one positions decode range) → 1–2 layers,
 *   - expands reused (instanced) geometry into per-mesh geometry, so instanced tiles are not skipped,
 *   - simplifies each connected island locally (meshopt, LockBorder) within a relative error,
 *   - drops vertex normals (flat shading) and edges,
 *   - deduplicates identical texture sets: the SDK draws one VBO layer per texture set, and the source
 *     gives every textured mesh its own set (281 sets for one shared texture in a sampled tile).
 * Entity IDs, entity→mesh order, materials, colours and texture tables are kept, so the
 * decoded object list matches the detail tile. No mesh is removed: when the far profile drops tiny
 * islands, a mesh always keeps its largest island.
 */
export const LOD_PROFILES = {
  // Light: near-identical shape for mid-range and motion (same limits as the motion pairs).
  light: { policy: 'merged-light-v2', ratio: 0.2, relativeError: 0.001, minIslandMeters: 0 },
  // Far: always-resident whole-site level. 1% of a part's own size is sub-pixel at several hundred
  // metres; parts smaller than 0.25 m are dropped (kept if they are a mesh's only/largest island).
  far: { policy: 'merged-far-v2', ratio: 0.05, relativeError: 0.01, minIslandMeters: 0.25 },
};

const SLOTS = 29, HEAD = 4 + SLOTS * 8;

function readTables(b) {
  if (b.length < HEAD || b.readUInt32LE(0) !== 12) return null;
  const raw = [];
  for (let s = 0; s < SLOTS; s++) {
    const o = b.readUInt32LE(4 + s * 8), n = b.readUInt32LE(8 + s * 8);
    if (o < HEAD || o + n > b.length) throw new Error('Invalid XKT table bounds');
    raw.push(b.subarray(o, o + n));
  }
  return raw;
}
const view = (raw, T) => {
  if (raw.length % T.BYTES_PER_ELEMENT) throw new Error('Invalid table alignment');
  return new T(Uint8Array.from(raw).buffer);
};
const span = (ptr, i, total) => [ptr[i], i + 1 < ptr.length ? ptr[i + 1] : total];

function writeTables(raw) {
  const head = Buffer.alloc(HEAD), parts = [head];
  head.writeUInt32LE(12, 0);
  let length = HEAD;
  raw.forEach((part, s) => {
    const pad = (8 - length % 8) % 8; // Float64 tables must stay 8-byte aligned for the SDK parser.
    if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
    head.writeUInt32LE(length, 4 + s * 8); head.writeUInt32LE(part.length, 8 + s * 8);
    parts.push(part); length += part.length;
  });
  return Buffer.concat(parts);
}
const buf = (T, values) => Buffer.from(T.from(values).buffer);

/** Column-major 4x4 times point. */
const transform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** Simplify one triangle list (world positions, welded by position+uv) per connected island. */
async function simplifyIslands(pos, indices, profile) {
  const nv = pos.length / 3;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < indices.length; i += 3) {
    const a = root(indices[i]); parent[root(indices[i + 1])] = a; parent[root(indices[i + 2])] = a;
  }
  const islands = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const r = root(indices[i]);
    if (!islands.has(r)) islands.set(r, []);
    islands.get(r).push(indices[i], indices[i + 1], indices[i + 2]);
  }
  const bounds = list => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of list) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], pos[v * 3 + a]); b[a + 3] = Math.max(b[a + 3], pos[v * 3 + a]); }
    return b;
  };
  const entries = [...islands.values()].map(list => {
    const b = bounds(list);
    return { list, b, extent: Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) };
  });
  const largest = entries.reduce((a, e) => (e.extent > (a?.extent ?? -1) ? e : a), undefined);
  const out = [];
  for (const e of entries) {
    if (profile.minIslandMeters > 0 && e.extent < profile.minIslandMeters && e !== largest) continue;
    let output = e.list;
    if (e.list.length >= 96) {
      // Localize so survey coordinates cannot inflate the error tolerance.
      const ids = [...new Set(e.list)], remap = new Map(ids.map((v, i) => [v, i]));
      const local = Float32Array.from(ids.flatMap(v => [pos[v * 3] - e.b[0], pos[v * 3 + 1] - e.b[1], pos[v * 3 + 2] - e.b[2]]));
      const localIdx = Uint32Array.from(e.list, v => remap.get(v));
      try {
        const [result, error] = MeshoptSimplifier.simplify(localIdx, local, 3,
          Math.max(3, Math.floor(e.list.length * profile.ratio / 3) * 3), profile.relativeError, ['LockBorder']);
        const candidate = Array.from(result, v => ids[v]);
        const c = bounds(candidate);
        const tolerance = a => Math.max(1e-6, Math.min(e.extent * profile.relativeError * 2, (e.b[a % 3 + 3] - e.b[a % 3]) * 0.01 + e.extent * profile.relativeError));
        const valid = candidate.length >= 3 && candidate.length < e.list.length && candidate.length % 3 === 0 &&
          Number.isFinite(error) && error <= profile.relativeError && c.every((v, a) => Number.isFinite(v) && Math.abs(v - e.b[a]) <= tolerance(a));
        if (valid) output = candidate;
      } catch { /* Unsupported topology keeps the complete island. */ }
    }
    for (const v of output) out.push(v);
  }
  return out;
}

/**
 * @param {Buffer|Uint8Array} input decoded (not gzip) XKT v12
 * @param {'light'|'far'} profileName
 */
export async function buildMergedLod(input, profileName) {
  const profile = LOD_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown LOD profile ${profileName}`);
  await MeshoptSimplifier.ready;
  const raw = readTables(Buffer.from(input));
  if (!raw) return null;
  const positions = view(raw[4], Uint16Array), colors = view(raw[6], Uint8Array), uvs = view(raw[7], Float32Array);
  const indices = view(raw[8], Uint32Array), matrices = view(raw[11], Float32Array), reuseDecode = view(raw[12], Float32Array);
  const primitive = view(raw[13], Uint8Array);
  const pp = view(raw[15], Uint32Array), cp = view(raw[17], Uint32Array), up = view(raw[18], Uint32Array), ip = view(raw[19], Uint32Array);
  const mg = view(raw[21], Uint32Array), mm = view(raw[22], Uint32Array), em = view(raw[26], Uint32Array);
  const tileBoxes = view(raw[27], Float64Array), te = view(raw[28], Uint32Array);
  const ids = JSON.parse(raw[25].toString() || '[]');
  let axisLabels = [];
  try { axisLabels = JSON.parse(raw[14].toString() || '[]'); } catch { axisLabels = []; }
  const numGeometries = pp.length, numMeshes = mg.length, numEntities = em.length, numTiles = te.length;
  if (!numMeshes || !numEntities || !numTiles || tileBoxes.length !== numTiles * 6 || !Array.isArray(ids) || ids.length !== numEntities ||
      [cp, up, ip].some(p => p.length !== numGeometries) || mm.length !== numMeshes || primitive.length !== numGeometries)
    throw new Error('Invalid XKT layout');
  if (![...tileBoxes, ...matrices].every(Number.isFinite)) throw new Error('Invalid XKT numbers');
  const reuse = new Uint32Array(numGeometries);
  for (const g of mg) { if (g >= numGeometries) throw new Error('Invalid mesh geometry'); reuse[g]++; }
  const reuseM = reuseDecode.length === 16 ? reuseDecode : null;

  // World positions per mesh (Float64, absolute), plus per-vertex uv/colour, by entity → mesh order.
  const meshes = [];
  let detailTriangles = 0;
  for (let t = 0; t < numTiles; t++) {
    const box = tileBoxes.subarray(t * 6, t * 6 + 6);
    const [e0, e1] = span(te, t, numEntities);
    for (let e = e0; e < e1; e++) {
      const [m0, m1] = span(em, e, numMeshes);
      for (let m = m0; m < m1; m++) {
        const g = mg[m];
        const [p0, p1] = span(pp, g, positions.length), [i0, i1] = span(ip, g, indices.length);
        const [u0, u1] = span(up, g, uvs.length), [c0, c1] = span(cp, g, colors.length);
        const nv = (p1 - p0) / 3;
        if (!Number.isInteger(nv) || p1 > positions.length || i1 > indices.length) throw new Error('Invalid geometry span');
        const world = new Float64Array(nv * 3);
        if (reuse[g] > 1) {
          if (!reuseM) throw new Error('Missing reused geometry decode matrix');
          const mat = matrices.subarray(mm[m], mm[m] + 16);
          if (mat.length !== 16) throw new Error('Invalid mesh matrix');
          const centre = [0, 1, 2].map(a => (box[a] + box[a + 3]) / 2);
          for (let v = 0; v < nv; v++) {
            const local = transform(reuseM, positions[p0 + v * 3], positions[p0 + v * 3 + 1], positions[p0 + v * 3 + 2]);
            const w = transform(mat, local[0], local[1], local[2]);
            for (let a = 0; a < 3; a++) world[v * 3 + a] = w[a] + centre[a];
          }
        } else {
          // Non-reused geometry is quantized in its tile's box (decode = min + q * size / 65535).
          for (let v = 0; v < nv; v++) for (let a = 0; a < 3; a++)
            world[v * 3 + a] = box[a] + positions[p0 + v * 3 + a] * (box[a + 3] - box[a]) / 65535;
        }
        const tri = indices.slice(i0, i1);
        if (!tri.every(i => i < nv)) throw new Error('Invalid index');
        const hasUv = u1 - u0 === nv * 2;
        // The SDK reads per-vertex colours only for points (primitive 2); kept verbatim for non-triangles.
        meshes.push({ g, world, tri, uv: hasUv ? uvs.slice(u0, u1) : null, color: primitive[g] > 1 && c1 > c0 ? colors.slice(c0, c1) : null,
          primitive: primitive[g], label: axisLabels[g] });
        if (primitive[g] <= 1) detailTriangles += tri.length / 3;
      }
    }
  }
  if (meshes.length !== numMeshes) throw new Error('Mesh order mismatch');

  let triangles = 0;
  for (const mesh of meshes) {
    if (mesh.primitive > 1 || mesh.tri.length < 3) { if (mesh.primitive <= 1) triangles += mesh.tri.length / 3; continue; }
    // Weld by position(+uv) so hard-normal seams simplify; uv seams stay split.
    const nv = mesh.world.length / 3, keys = new Map(), reps = [], remap = new Uint32Array(nv), wp = [];
    for (let v = 0; v < nv; v++) {
      const key = `${mesh.world[v * 3]},${mesh.world[v * 3 + 1]},${mesh.world[v * 3 + 2]}${mesh.uv ? `,${mesh.uv[v * 2]},${mesh.uv[v * 2 + 1]}` : ''}`;
      let next = keys.get(key);
      if (next === undefined) { next = reps.length; keys.set(key, next); reps.push(v); wp.push(mesh.world[v * 3], mesh.world[v * 3 + 1], mesh.world[v * 3 + 2]); }
      remap[v] = next;
    }
    const chosen = await simplifyIslands(wp, Array.from(mesh.tri, v => remap[v]), profile);
    // Compact to the referenced source vertices (first occurrence of each welded vertex).
    const map = new Map(), world = [], uv = [];
    const tri = Uint32Array.from(chosen, w => {
      const v = reps[w];
      if (!map.has(v)) {
        map.set(v, map.size);
        world.push(mesh.world[v * 3], mesh.world[v * 3 + 1], mesh.world[v * 3 + 2]);
        if (mesh.uv) uv.push(mesh.uv[v * 2], mesh.uv[v * 2 + 1]);
      }
      return map.get(v);
    });
    mesh.world = Float64Array.from(world); mesh.tri = tri;
    mesh.uv = mesh.uv ? Float32Array.from(uv) : null;
    triangles += tri.length / 3;
  }

  // One tile: quantize everything in the union box of the output.
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) for (let i = 0; i < mesh.world.length; i += 3)
    for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], mesh.world[i + a]); box[a + 3] = Math.max(box[a + 3], mesh.world[i + a]); }
  if (!box.every(Number.isFinite)) throw new Error('Empty merged tile');
  const size = [0, 1, 2].map(a => box[a + 3] - box[a]);
  const q = (v, a) => size[a] > 0 ? Math.max(0, Math.min(65535, Math.round((v - box[a]) / size[a] * 65535))) : 0;

  const out = { p: [], u: [], c: [], i: [] }, ptr = { p: [], n: [], c: [], u: [], i: [], e: [] };
  const prim = [], labels = [];
  for (const mesh of meshes) {
    ptr.p.push(out.p.length); ptr.n.push(0); ptr.c.push(out.c.length); ptr.u.push(out.u.length); ptr.i.push(out.i.length); ptr.e.push(0);
    for (let i = 0; i < mesh.world.length; i += 3) for (let a = 0; a < 3; a++) out.p.push(q(mesh.world[i + a], a));
    if (mesh.uv) for (const v of mesh.uv) out.u.push(v);
    if (mesh.color) for (const v of mesh.color) out.c.push(v);
    for (const v of mesh.tri) out.i.push(v);
    prim.push(mesh.primitive); labels.push(mesh.label ?? '');
  }
  const result = [...raw];
  result[4] = buf(Uint16Array, out.p);
  result[5] = Buffer.alloc(0);                       // flat shading: SDK generates face normals
  result[6] = buf(Uint8Array, out.c);
  result[7] = buf(Float32Array, out.u);
  result[8] = buf(Uint32Array, out.i);
  result[9] = Buffer.alloc(0);                       // no edges
  result[11] = buf(Float32Array, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  result[13] = buf(Uint8Array, prim);
  result[14] = Buffer.from(JSON.stringify(axisLabels.length ? labels : []));
  result[15] = buf(Uint32Array, ptr.p); result[16] = buf(Uint32Array, ptr.n); result[17] = buf(Uint32Array, ptr.c);
  result[18] = buf(Uint32Array, ptr.u); result[19] = buf(Uint32Array, ptr.i); result[20] = buf(Uint32Array, ptr.e);
  result[21] = buf(Uint32Array, meshes.map((_, m) => m)); // every mesh owns its geometry: no instancing layers
  result[22] = buf(Uint32Array, meshes.map(() => 0));
  // Identical texture sets (same 5 texture indices) collapse to one, so meshes share a draw layer.
  const sets = view(raw[10], Int32Array), meshSet = view(raw[23], Int32Array);
  if (sets.length % 5 || meshSet.length !== numMeshes) throw new Error('Invalid texture sets');
  const setIndex = new Map(), uniqueSets = [], remapSet = [];
  for (let k = 0; k < sets.length; k += 5) {
    const key = sets.slice(k, k + 5).join(',');
    if (!setIndex.has(key)) { setIndex.set(key, uniqueSets.length / 5); uniqueSets.push(...sets.slice(k, k + 5)); }
    remapSet.push(setIndex.get(key));
  }
  if ([...meshSet].some(v => v >= remapSet.length)) throw new Error('Invalid mesh texture set');
  result[10] = buf(Int32Array, uniqueSets);
  result[23] = buf(Int32Array, Array.from(meshSet, v => (v >= 0 ? remapSet[v] : -1)));
  result[27] = buf(Float64Array, box);
  result[28] = buf(Uint32Array, [0]);
  return { bytes: writeTables(result), members: numEntities, detailTriangles, triangles, sourceTiles: numTiles,
    reusedGeometries: [...reuse].filter(n => n > 1).length, textureSets: sets.length / 5, uniqueTextureSets: uniqueSets.length / 5,
    policy: profile.policy, aabb: box };
}

/** Decoded world positions of a merged (single-tile, non-reused) file — for validation and tests. */
export function decodeMergedPositions(input) {
  const raw = readTables(Buffer.from(input));
  const p = view(raw[4], Uint16Array), box = view(raw[27], Float64Array);
  return Float64Array.from(p, (v, i) => box[i % 3] + v * (box[i % 3 + 3] - box[i % 3]) / 65535);
}
