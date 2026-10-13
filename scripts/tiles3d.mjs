// 3D Tiles 1.1 content for the second viewer engine (docs/3D뷰_2차_엔진.md). Pure: arrays in, buffers out.
//   packMeshes      decoded XKT meshes → one opaque + one transparent group (positions, colour, dbId, indices)
//   weldGroup       one vertex per position within an object (the converter splits them per face)
//   simplifyGroup   coarser level: meshopt simplify with an absolute error (metres), prune, needle removal; long
//                   objects that vanished come back as oriented boxes (proxyBoxes)
//   encodeGlb       group(s) → .glb: int16 positions (KHR_mesh_quantization) + EXT_meshopt_compression,
//                   per-vertex _FEATURE_ID_0 = dbId (EXT_mesh_features), no normals (viewer shades flat)
//   groupSpatially  items → tree of ≤ maxChildren per node (recursive median splits)
//   packTerrain / simplifyTerrain / encodeTerrainGlb  textured terrain (aerial photo per patch, KTX2 kept as is)
// Coordinates: tileset frame = decoded XKT frame (Z-up, metres). glTF is Y-up, so content stores (x, z, −y).
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

/** Colour for meshes whose material was a texture (factor white): a neutral earth tone instead of white. */
const TEXTURED_RGBA = [150, 140, 122, 255];

/**
 * @param {{ entity: number, world: Float64Array, tri: Uint32Array, rgba: number[], textured: boolean }[]} meshes
 * @param {(entity: number) => number} dbIdOf  object id per entity (0 = none)
 */
export function packMeshes(meshes, dbIdOf) {
  const parts = { opaque: [], transparent: [] };
  for (const m of meshes) (m.rgba[3] < 250 ? parts.transparent : parts.opaque).push(m);
  const pack = list => {
    let nv = 0, ni = 0;
    for (const m of list) { nv += m.world.length / 3; ni += m.tri.length; }
    if (!ni) return null;
    const pos = new Float64Array(nv * 3), rgba = new Uint8Array(nv * 4), ids = new Float32Array(nv), idx = new Uint32Array(ni);
    let v = 0, i = 0;
    for (const m of list) {
      const n = m.world.length / 3, colour = m.textured && m.rgba[0] > 240 && m.rgba[1] > 240 && m.rgba[2] > 240 ? TEXTURED_RGBA : m.rgba;
      const id = dbIdOf(m.entity) || 0;
      pos.set(m.world, v * 3);
      for (let k = 0; k < n; k++) { rgba.set(colour, (v + k) * 4); ids[v + k] = id; }
      for (let k = 0; k < m.tri.length; k++) idx[i + k] = m.tri[k] + v;
      v += n; i += m.tri.length;
    }
    return { pos, rgba, ids, idx };
  };
  return { opaque: pack(parts.opaque), transparent: pack(parts.transparent) };
}

/** Concatenate groups (same kind) of several tiles. */
export function mergeGroups(groups) {
  const list = groups.filter(Boolean);
  if (!list.length) return null;
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.ids.length; ni += g.idx.length; }
  const out = { pos: new Float64Array(nv * 3), rgba: new Uint8Array(nv * 4), ids: new Float32Array(nv), idx: new Uint32Array(ni) };
  let v = 0, i = 0;
  for (const g of list) {
    out.pos.set(g.pos, v * 3); out.rgba.set(g.rgba, v * 4); out.ids.set(g.ids, v);
    for (let k = 0; k < g.idx.length; k++) out.idx[i + k] = g.idx[k] + v;
    v += g.ids.length; i += g.idx.length;
  }
  return out;
}

export function triangles(group) { return group ? group.idx.length / 3 : 0; }

export function boundsOf(...groups) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const g of groups) if (g) for (let i = 0; i < g.pos.length; i++) {
    const a = i % 3, v = g.pos[i];
    if (v < b[a]) b[a] = v;
    if (v > b[a + 3]) b[a + 3] = v;
  }
  return b;
}

/**
 * One vertex per position (to `step` metres) within an object and colour, so the simplifier sees connected surfaces
 * instead of loose faces (the converter splits vertices per face for flat normals). Collapsed triangles are dropped.
 */
export function weldGroup(group, step = 0.001) {
  if (!group) return group;
  const nv = group.ids.length, p = group.pos, lo = boundsOf(group), c = group.rgba;
  const q = new Int32Array(nv * 3), colour = new Uint32Array(nv);
  for (let i = 0; i < nv * 3; i++) q[i] = Math.round((p[i] - lo[i % 3]) / step);
  for (let v = 0; v < nv; v++) colour[v] = (c[v * 4] | (c[v * 4 + 1] << 8) | (c[v * 4 + 2] << 16) | (c[v * 4 + 3] << 24)) >>> 0;
  // Open addressing on (position, object, colour); slots hold the first vertex index + 1.
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const table = new Int32Array(size), remap = new Uint32Array(nv), first = [];
  const same = (u, v) => q[u * 3] === q[v * 3] && q[u * 3 + 1] === q[v * 3 + 1] && q[u * 3 + 2] === q[v * 3 + 2] &&
    group.ids[u] === group.ids[v] && colour[u] === colour[v];
  for (let v = 0; v < nv; v++) {
    let h = Math.imul(q[v * 3], 73856093) ^ Math.imul(q[v * 3 + 1], 19349663) ^ Math.imul(q[v * 3 + 2], 83492791) ^ Math.imul(group.ids[v] | 0, 2654435761 | 0);
    h &= size - 1;
    while (table[h] && !same(table[h] - 1, v)) h = (h + 1) & (size - 1);
    if (!table[h]) { table[h] = v + 1; remap[v] = first.length; first.push(v); }
    else remap[v] = remap[table[h] - 1];
  }
  const n = first.length, idx = new Uint32Array(group.idx.length);
  let ni = 0;
  for (let i = 0; i < group.idx.length; i += 3) {
    const x = remap[group.idx[i]], y = remap[group.idx[i + 1]], z = remap[group.idx[i + 2]];
    if (x !== y && y !== z && x !== z) { idx[ni++] = x; idx[ni++] = y; idx[ni++] = z; }
  }
  const out = { pos: new Float64Array(n * 3), rgba: new Uint8Array(n * 4), ids: new Float32Array(n), idx: idx.slice(0, ni) };
  first.forEach((v, r) => {
    out.pos.set(group.pos.subarray(v * 3, v * 3 + 3), r * 3);
    out.rgba.set(group.rgba.subarray(v * 4, v * 4 + 4), r * 4);
    out.ids[r] = group.ids[v];
  });
  return out;
}

/** Keep only referenced vertices (after simplification), preserving attributes. */
function compact(group, idx) {
  const remap = new Int32Array(group.ids.length).fill(-1);
  let n = 0;
  for (const v of idx) if (remap[v] < 0) remap[v] = n++;
  const out = { pos: new Float64Array(n * 3), rgba: new Uint8Array(n * 4), ids: new Float32Array(n), idx: new Uint32Array(idx.length) };
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    out.pos[r * 3] = group.pos[v * 3]; out.pos[r * 3 + 1] = group.pos[v * 3 + 1]; out.pos[r * 3 + 2] = group.pos[v * 3 + 2];
    out.rgba.set(group.rgba.subarray(v * 4, v * 4 + 4), r * 4);
    out.ids[r] = group.ids[v];
  }
  for (let k = 0; k < idx.length; k++) out.idx[k] = remap[idx[k]];
  return out;
}

/** Eigenvectors (columns) of a symmetric 3×3 matrix [a00, a01, a02, a11, a12, a22] by Jacobi rotations. */
function eigenAxes([a00, a01, a02, a11, a12, a22]) {
  const a = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  return [0, 1, 2].map(j => [v[0][j], v[1][j], v[2][j]]);
}

/**
 * Objects the simplification removed entirely but that are long enough to read from afar (rails, poles, beams,
 * railings): one oriented box each (12 triangles, the object's colour and dbId), at least a quarter of the error thick
 * so it stays a continuous line instead of breaking into dashes. Shorter objects are below the level's error anyway.
 */
export function proxyBoxes(group, survivors, errorMeters) {
  const minLength = errorMeters * 2, minThick = errorMeters * 0.25;
  const verts = new Map();
  for (let v = 0; v < group.ids.length; v++) {
    const id = group.ids[v];
    if (!(id > 0) || survivors.has(id)) continue;
    let list = verts.get(id);
    if (!list) verts.set(id, list = []);
    list.push(v);
  }
  const pos = [], rgba = [], ids = [], idx = [];
  for (const [id, list] of verts) {
    const p = group.pos, n = list.length;
    let mx = 0, my = 0, mz = 0;
    for (const v of list) { mx += p[v * 3]; my += p[v * 3 + 1]; mz += p[v * 3 + 2]; }
    mx /= n; my /= n; mz /= n;
    const cov = [0, 0, 0, 0, 0, 0];
    for (const v of list) {
      const x = p[v * 3] - mx, y = p[v * 3 + 1] - my, z = p[v * 3 + 2] - mz;
      cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z;
    }
    const axes = eigenAxes(cov);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of list) for (let k = 0; k < 3; k++) {
      const d = (p[v * 3] - mx) * axes[k][0] + (p[v * 3 + 1] - my) * axes[k][1] + (p[v * 3 + 2] - mz) * axes[k][2];
      if (d < lo[k]) lo[k] = d; if (d > hi[k]) hi[k] = d;
    }
    if (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < minLength) continue;
    for (let k = 0; k < 3; k++) if (hi[k] - lo[k] < minThick) { const m = (hi[k] + lo[k]) / 2; lo[k] = m - minThick / 2; hi[k] = m + minThick / 2; }
    const base = ids.length;
    for (let c = 0; c < 8; c++) {
      const e = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
      for (let a = 0; a < 3; a++) pos.push((a === 0 ? mx : a === 1 ? my : mz) + e[0] * axes[0][a] + e[1] * axes[1][a] + e[2] * axes[2][a]);
      rgba.push(...group.rgba.subarray(list[0] * 4, list[0] * 4 + 4));
      ids.push(id);
    }
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]])
      idx.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  return ids.length ? { pos: Float64Array.from(pos), rgba: Uint8Array.from(rgba), ids: Float32Array.from(ids), idx: Uint32Array.from(idx) } : null;
}

/**
 * Coarser copy: simplify the whole group with an absolute error in metres and prune parts smaller than it.
 * Objects are separate vertex islands, so simplification never joins two objects; dbIds stay per vertex.
 * Long needle triangles that collapsed thin parts leave behind are dropped (they flash when flat-shaded): by default
 * every triangle longer than the error and flatter than 1:25; with `minHeight` (metres) only those thinner than that,
 * so long thin faces (rails, deck edges, parapets) of the finer copies stay (0: keep every triangle). `lockBorder` keeps
 * every border vertex in place, so patches that meet along a seam without shared vertices stay closed.
 * Long objects that disappeared come back as oriented boxes (proxyBoxes), so a far view is not full of gaps.
 */
export async function simplifyGroup(group, errorMeters, { ratio = 0.01, minHeight, lockBorder = false } = {}) {
  if (!group || group.idx.length < 3) return group;
  await MeshoptSimplifier.ready;
  const b = boundsOf(group);
  const local = new Float32Array(group.pos.length);
  for (let i = 0; i < local.length; i++) local[i] = group.pos[i] - b[i % 3];
  const target = Math.max(3, Math.floor(group.idx.length * ratio / 3) * 3);
  let result;
  const flags = ['ErrorAbsolute', 'Prune', ...(lockBorder ? ['LockBorder'] : [])];
  try { [result] = MeshoptSimplifier.simplify(group.idx, local, 3, target, errorMeters, flags); }
  catch { return group; }
  if (!result || result.length < 3) return null;
  const kept = [];
  const minEdge2 = errorMeters * errorMeters;
  for (let i = 0; i < result.length; i += 3) {
    const [a, c, d] = [result[i], result[i + 1], result[i + 2]];
    const ax = local[a * 3], ay = local[a * 3 + 1], az = local[a * 3 + 2];
    const ab = [local[c * 3] - ax, local[c * 3 + 1] - ay, local[c * 3 + 2] - az];
    const ad = [local[d * 3] - ax, local[d * 3 + 1] - ay, local[d * 3 + 2] - az];
    const cd = [local[d * 3] - local[c * 3], local[d * 3 + 1] - local[c * 3 + 1], local[d * 3 + 2] - local[c * 3 + 2]];
    const len2 = v => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const maxE2 = Math.max(len2(ab), len2(ad), len2(cd));
    const cr = [ab[1] * ad[2] - ab[2] * ad[1], ab[2] * ad[0] - ab[0] * ad[2], ab[0] * ad[1] - ab[1] * ad[0]];
    const twiceArea = Math.sqrt(len2(cr));
    if (maxE2 > minEdge2 && (minHeight === undefined ? twiceArea / 2 < 0.02 * maxE2 : twiceArea / Math.sqrt(maxE2) < minHeight)) continue;
    kept.push(a, c, d);
  }
  const survivors = new Set();
  for (const v of kept) survivors.add(group.ids[v]);
  const simplified = kept.length ? compact(group, Uint32Array.from(kept)) : null;
  return mergeGroups([simplified, proxyBoxes(group, survivors, errorMeters)]);
}

// ── GLB ───────────────────────────────────────────────────────────────────────────────────────────
const SHORT = 5122, UBYTE = 5121, FLOAT = 5126, UINT = 5125, USHORT = 5123;

/**
 * One .glb for a tile: one node (dequantization transform) and one mesh with up to two primitives
 * (opaque, transparent). Returns { glb, triangles, vertices, bytes }.
 */
export async function encodeGlb({ opaque, transparent }) {
  await MeshoptEncoder.ready;
  const groups = [opaque, transparent].filter(g => g && g.idx.length >= 3);
  if (!groups.length) return null;
  // One quantization box for both primitives (they share the node transform).
  const b = boundsOf(...groups);
  const c = [0, 1, 2].map(a => (b[a] + b[a + 3]) / 2), h = [0, 1, 2].map(a => Math.max((b[a + 3] - b[a]) / 2, 1e-4));
  const views = [], accessors = [], fallbackParts = [], compressedParts = [];
  let fallbackLength = 0, compressedLength = 0;
  const addView = (raw, count, stride, mode, target) => {
    const align = n => (4 - (n % 4)) % 4;
    const encoded = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode);
    const view = { buffer: 1, byteOffset: fallbackLength, byteLength: raw.length, ...(mode === 'ATTRIBUTES' ? { byteStride: stride } : {}), target,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: compressedLength, byteLength: encoded.length, byteStride: stride, count, mode } } };
    fallbackLength += raw.length + align(raw.length);
    compressedParts.push(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length));
    const pad = align(encoded.length);
    if (pad) compressedParts.push(Buffer.alloc(pad));
    compressedLength += encoded.length + pad;
    fallbackParts.push(raw.length);
    views.push(view);
    return views.length - 1;
  };
  const primitives = [];
  let totalTriangles = 0, totalVertices = 0;
  for (const [gi, g] of groups.entries()) {
    const nv = g.ids.length;
    // Vertex cache / fetch order improves both GPU efficiency and compression. reorderMesh rewrites the
    // index copy in place (new triangle order, new vertex numbers) and returns old → new vertex numbers.
    const idx = Uint32Array.from(g.idx);
    const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, true);
    const order = new Uint32Array(unique);
    for (let v = 0; v < Math.min(nv, remap.length); v++) if (remap[v] < unique) order[remap[v]] = v;
    // int16 positions (stride 8), Y-up: (x, z, −y) relative to the box centre, normalized by the half extent.
    const pos = new Int16Array(unique * 4), col = new Uint8Array(unique * 4), ids = new Float32Array(unique);
    const q = (v, a) => Math.max(-32767, Math.min(32767, Math.round((v - c[a]) / h[a] * 32767)));
    const min = [32767, 32767, 32767], max = [-32767, -32767, -32767];
    for (let r = 0; r < unique; r++) {
      const v = order[r];
      const x = q(g.pos[v * 3], 0), y = q(g.pos[v * 3 + 2], 2), z = -q(g.pos[v * 3 + 1], 1);
      pos[r * 4] = x; pos[r * 4 + 1] = y; pos[r * 4 + 2] = z;
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
      col.set(g.rgba.subarray(v * 4, v * 4 + 4), r * 4);
      ids[r] = g.ids[v];
    }
    const bytes = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const useShort = unique < 65536;
    const indexArray = useShort ? Uint16Array.from(idx) : idx;
    const vPos = addView(bytes(pos), unique, 8, 'ATTRIBUTES', 34962);
    const vCol = addView(bytes(col), unique, 4, 'ATTRIBUTES', 34962);
    const vIds = addView(bytes(ids), unique, 4, 'ATTRIBUTES', 34962);
    const vIdx = addView(bytes(indexArray), idx.length, useShort ? 2 : 4, 'TRIANGLES', 34963);
    const featureCount = new Set(ids).size;
    accessors.push({ bufferView: vPos, componentType: SHORT, normalized: true, count: unique, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: vCol, componentType: UBYTE, normalized: true, count: unique, type: 'VEC4' });
    const aCol = accessors.length - 1;
    accessors.push({ bufferView: vIds, componentType: FLOAT, count: unique, type: 'SCALAR' });
    const aIds = accessors.length - 1;
    accessors.push({ bufferView: vIdx, componentType: useShort ? USHORT : UINT, count: idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;
    primitives.push({ attributes: { POSITION: aPos, COLOR_0: aCol, _FEATURE_ID_0: aIds }, indices: aIdx, material: gi === 0 && g === opaque ? 0 : 1, mode: 4,
      extensions: { EXT_mesh_features: { featureIds: [{ featureCount, attribute: 0 }] } } });
    totalTriangles += idx.length / 3; totalVertices += unique;
  }
  const json = {
    asset: { version: '2.0', generator: 'MIR tiles3d' },
    extensionsUsed: ['KHR_mesh_quantization', 'EXT_meshopt_compression', 'EXT_mesh_features'],
    extensionsRequired: ['KHR_mesh_quantization', 'EXT_meshopt_compression'],
    scene: 0, scenes: [{ nodes: [0] }],
    // Dequantization: position = translation + scale ∘ normalized; same axis swap as the positions.
    nodes: [{ mesh: 0, translation: [c[0], c[2], -c[1]], scale: [h[0], h[2], h[1]] }],
    meshes: [{ primitives }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true },
      { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, alphaMode: 'BLEND' },
    ],
    accessors, bufferViews: views,
    buffers: [{ byteLength: compressedLength }, { byteLength: fallbackLength, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  const bin = Buffer.concat(compressedParts);
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(jsonBuf.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([head, jsonHead, jsonBuf, binHead, bin]), triangles: totalTriangles, vertices: totalVertices, bounds: b };
}

// ── Terrain (textured, no object ids) ─────────────────────────────────────────────────────────────

/**
 * Terrain meshes → one part per colour texture: vertices welded by position + uv (patches of one photo share
 * edges, so a coarser level can simplify across them). Meshes without uv or texture are skipped.
 * @returns {Map<number, { texture: number, pos: Float64Array, uv: Float32Array, idx: Uint32Array }>}
 */
export function packTerrain(meshes) {
  const byTexture = new Map();
  for (const m of meshes) {
    if (!m.uv || !(m.texture >= 0)) continue;
    let list = byTexture.get(m.texture);
    if (!list) byTexture.set(m.texture, list = []);
    list.push(m);
  }
  const parts = new Map();
  for (const [texture, list] of byTexture) {
    const index = new Map(), pos = [], uv = [], idx = [];
    for (const m of list) {
      const local = new Uint32Array(m.world.length / 3);
      for (let v = 0; v < local.length; v++) {
        const key = `${m.world[v * 3]},${m.world[v * 3 + 1]},${m.world[v * 3 + 2]},${m.uv[v * 2]},${m.uv[v * 2 + 1]}`;
        let r = index.get(key);
        if (r === undefined) { r = pos.length / 3; index.set(key, r); pos.push(m.world[v * 3], m.world[v * 3 + 1], m.world[v * 3 + 2]); uv.push(m.uv[v * 2], m.uv[v * 2 + 1]); }
        local[v] = r;
      }
      for (const i of m.tri) idx.push(local[i]);
    }
    parts.set(texture, { texture, pos: Float64Array.from(pos), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) });
  }
  return parts;
}

/** Coarser terrain part: simplify with an absolute error (metres), borders kept; uv follows the kept vertices. */
export async function simplifyTerrain(part, errorMeters) {
  if (!part || part.idx.length < 3) return part;
  await MeshoptSimplifier.ready;
  const b = boundsOf({ pos: part.pos });
  const local = new Float32Array(part.pos.length);
  for (let i = 0; i < local.length; i++) local[i] = part.pos[i] - b[i % 3];
  let result;
  // Borders stay: neighbouring photos are simplified separately and must still meet without cracks.
  try { [result] = MeshoptSimplifier.simplify(part.idx, local, 3, 3, errorMeters, ['ErrorAbsolute', 'LockBorder']); }
  catch { return part; }
  if (!result || result.length < 3) return part;
  const remap = new Int32Array(part.pos.length / 3).fill(-1);
  let n = 0;
  for (const v of result) if (remap[v] < 0) remap[v] = n++;
  const out = { texture: part.texture, pos: new Float64Array(n * 3), uv: new Float32Array(n * 2), idx: new Uint32Array(result.length) };
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    out.pos.set(part.pos.subarray(v * 3, v * 3 + 3), r * 3);
    out.uv.set(part.uv.subarray(v * 2, v * 2 + 2), r * 2);
  }
  for (let k = 0; k < result.length; k++) out.idx[k] = remap[result[k]];
  return out;
}

/** Area-weighted vertex normals in the tileset frame (Z-up), as int8 for the glTF frame (x, z, −y). */
function terrainNormals(part) {
  const nv = part.pos.length / 3, acc = new Float64Array(nv * 3), p = part.pos;
  for (let i = 0; i < part.idx.length; i += 3) {
    const [a, b, c] = [part.idx[i], part.idx[i + 1], part.idx[i + 2]];
    const ab = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const ac = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (n[2] < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; } // terrain faces up (winding varies by source)
    for (const v of [a, b, c]) { acc[v * 3] += n[0]; acc[v * 3 + 1] += n[1]; acc[v * 3 + 2] += n[2]; }
  }
  const out = new Int8Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    const x = acc[v * 3], y = acc[v * 3 + 1], z = acc[v * 3 + 2], len = Math.hypot(x, y, z) || 1;
    out[v * 4] = Math.round(x / len * 127); out[v * 4 + 1] = Math.round(z / len * 127); out[v * 4 + 2] = Math.round(-y / len * 127);
  }
  return out;
}

/**
 * One terrain .glb: a primitive per photo (KTX2 texture embedded once, KHR_texture_basisu), int16 positions,
 * int8 normals, float uv, meshopt-compressed. No object ids: the viewer keeps it out of selection.
 * @param {{ texture: number, pos: Float64Array, uv: Float32Array, idx: Uint32Array }[]} parts
 * @param {(Buffer|null)[]} textures KTX2 bytes by texture index
 */
export async function encodeTerrainGlb(parts, textures) {
  await MeshoptEncoder.ready;
  const list = parts.filter(p => p && p.idx.length >= 3 && textures[p.texture]);
  if (!list.length) return null;
  const b = boundsOf(...list.map(p => ({ pos: p.pos })));
  const c = [0, 1, 2].map(a => (b[a] + b[a + 3]) / 2), h = [0, 1, 2].map(a => Math.max((b[a + 3] - b[a]) / 2, 1e-4));
  const views = [], accessors = [], compressedParts = [];
  let fallbackLength = 0, compressedLength = 0;
  const align = n => (4 - (n % 4)) % 4;
  const push = bytes => {
    const at = compressedLength;
    compressedParts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const pad = align(bytes.byteLength);
    if (pad) compressedParts.push(Buffer.alloc(pad));
    compressedLength += bytes.byteLength + pad;
    return at;
  };
  const addView = (raw, count, stride, mode, target) => {
    const encoded = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode);
    const at = push(encoded);
    views.push({ buffer: 1, byteOffset: fallbackLength, byteLength: raw.length, ...(mode === 'ATTRIBUTES' ? { byteStride: stride } : {}), target,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: encoded.length, byteStride: stride, count, mode } } });
    fallbackLength += raw.length + align(raw.length);
    return views.length - 1;
  };
  const bytes = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const images = [], textureList = [], materials = [], primitives = [];
  let totalTriangles = 0, totalVertices = 0, textureBytes = 0;
  for (const part of list) {
    const ktx = textures[part.texture];
    views.push({ buffer: 0, byteOffset: push(ktx), byteLength: ktx.length });
    images.push({ bufferView: views.length - 1, mimeType: 'image/ktx2' });
    textureList.push({ sampler: 0, extensions: { KHR_texture_basisu: { source: images.length - 1 } } });
    materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: textureList.length - 1 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true });
    textureBytes += ktx.length;
    const nv = part.pos.length / 3;
    const idx = Uint32Array.from(part.idx);
    const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, true);
    const order = new Uint32Array(unique);
    for (let v = 0; v < Math.min(nv, remap.length); v++) if (remap[v] < unique) order[remap[v]] = v;
    const normals = terrainNormals(part);
    const pos = new Int16Array(unique * 4), nrm = new Int8Array(unique * 4), uv = new Float32Array(unique * 2);
    const q = (v, a) => Math.max(-32767, Math.min(32767, Math.round((v - c[a]) / h[a] * 32767)));
    const min = [32767, 32767, 32767], max = [-32767, -32767, -32767];
    for (let r = 0; r < unique; r++) {
      const v = order[r];
      const x = q(part.pos[v * 3], 0), y = q(part.pos[v * 3 + 2], 2), z = -q(part.pos[v * 3 + 1], 1);
      pos[r * 4] = x; pos[r * 4 + 1] = y; pos[r * 4 + 2] = z;
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
      nrm.set(normals.subarray(v * 4, v * 4 + 4), r * 4);
      uv[r * 2] = part.uv[v * 2]; uv[r * 2 + 1] = part.uv[v * 2 + 1];
    }
    const useShort = unique < 65536;
    const vPos = addView(bytes(pos), unique, 8, 'ATTRIBUTES', 34962);
    const vNrm = addView(bytes(nrm), unique, 4, 'ATTRIBUTES', 34962);
    const vUv = addView(bytes(uv), unique, 8, 'ATTRIBUTES', 34962);
    const vIdx = addView(bytes(useShort ? Uint16Array.from(idx) : idx), idx.length, useShort ? 2 : 4, 'TRIANGLES', 34963);
    accessors.push({ bufferView: vPos, componentType: SHORT, normalized: true, count: unique, type: 'VEC3', min, max });
    accessors.push({ bufferView: vNrm, componentType: 5120, normalized: true, count: unique, type: 'VEC3' });
    accessors.push({ bufferView: vUv, componentType: FLOAT, count: unique, type: 'VEC2' });
    accessors.push({ bufferView: vIdx, componentType: useShort ? USHORT : UINT, count: idx.length, type: 'SCALAR' });
    const a = accessors.length - 4;
    primitives.push({ attributes: { POSITION: a, NORMAL: a + 1, TEXCOORD_0: a + 2 }, indices: a + 3, material: materials.length - 1, mode: 4 });
    totalTriangles += idx.length / 3; totalVertices += unique;
  }
  const json = {
    asset: { version: '2.0', generator: 'MIR tiles3d terrain' },
    extensionsUsed: ['KHR_mesh_quantization', 'EXT_meshopt_compression', 'KHR_texture_basisu'],
    extensionsRequired: ['KHR_mesh_quantization', 'EXT_meshopt_compression', 'KHR_texture_basisu'],
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [c[0], c[2], -c[1]], scale: [h[0], h[2], h[1]], extras: { mir: 'terrain' } }],
    meshes: [{ primitives }], materials, textures: textureList, images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors, bufferViews: views,
    buffers: [{ byteLength: compressedLength }, { byteLength: fallbackLength, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  const bin = Buffer.concat(compressedParts);
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(jsonBuf.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([head, jsonHead, jsonBuf, binHead, bin]), triangles: totalTriangles, vertices: totalVertices, textureBytes, bounds: b };
}

/** 3D Tiles box bounding volume (centre + half axes) from [minX, minY, minZ, maxX, maxY, maxZ]. */
export function boxVolume(b) {
  const c = [0, 1, 2].map(a => (b[a] + b[a + 3]) / 2), h = [0, 1, 2].map(a => Math.max((b[a + 3] - b[a]) / 2, 0.01));
  return { box: [c[0], c[1], c[2], h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]] };
}

/**
 * Spatial tree: each node has ≤ maxChildren children, split by recursive medians of item centres on the
 * longer horizontal axis. Items are leaves ({ centre: [x, y, z] , ... }). Returns nested { children } nodes.
 */
export function groupSpatially(items, maxChildren = 8) {
  if (items.length <= maxChildren) return { children: items };
  const split = (list, parts) => {
    if (parts <= 1 || list.length <= 1) return [list];
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const it of list) for (let a = 0; a < 2; a++) { lo[a] = Math.min(lo[a], it.centre[a]); hi[a] = Math.max(hi[a], it.centre[a]); }
    const axis = hi[0] - lo[0] >= hi[1] - lo[1] ? 0 : 1;
    const sorted = [...list].sort((p, q) => p.centre[axis] - q.centre[axis] || p.key - q.key);
    const mid = Math.floor(sorted.length / 2);
    return [...split(sorted.slice(0, mid), Math.floor(parts / 2)), ...split(sorted.slice(mid), Math.ceil(parts / 2))];
  };
  return { children: split(items, maxChildren).filter(l => l.length).map(l => groupSpatially(l, maxChildren)) };
}
