import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { cacheKeyOf, runOf } from './tileCache';

/**
 * Full-detail object geometry from the published 3D Tiles (scripts/tiles3d.mjs encodeGlb), for work that needs every
 * triangle of chosen objects whatever the camera shows — clash detection. The viewer streams coarser levels by
 * distance; here the leaf tiles (REPLACE refinement: the finest level everywhere) that overlap the objects' boxes are
 * read and their triangles kept per object (`_FEATURE_ID_0` = dbId), in the tileset frame (Z-up, as objects.bin).
 *
 * A tile .glb: one node (dequantization: translation + scale, axes (x, z, −y)) and one mesh of up to two primitives,
 * POSITION int16 normalized (stride 8), _FEATURE_ID_0 float32, indices u16/u32, all bufferViews EXT_meshopt_compression.
 */

export type LeafTile = { path: string; box: [number, number, number, number, number, number] };

/** Axis-aligned box of a 3D Tiles oriented box [cx, cy, cz, xx, xy, xz, yx, yy, yz, zx, zy, zz]. */
function aabbOf(b: number[]): LeafTile['box'] {
  const e = [0, 1, 2].map(a => Math.abs(b[3 + a]) + Math.abs(b[6 + a]) + Math.abs(b[9 + a]));
  return [b[0] - e[0], b[1] - e[1], b[2] - e[2], b[0] + e[0], b[1] + e[1], b[2] + e[2]];
}

type TileNode = { boundingVolume?: { box?: number[] }; content?: { uri?: string }; children?: TileNode[]; extras?: { mir?: string } };

/** The structure leaf tiles (the terrain branch is left out: no objects). */
export async function leafTiles(urls: Record<string, string>): Promise<LeafTile[]> {
  const r = await fetch(urls['tileset.json']);
  if (!r.ok) throw new Error(`타일 목록을 읽지 못했습니다 (HTTP ${r.status})`);
  const tileset = await r.json() as { root: TileNode };
  const root = tileset.root.children?.find(c => c.extras?.mir === 'structure') ?? tileset.root;
  const out: LeafTile[] = [];
  const visit = (t: TileNode) => {
    if (t.children?.length) { for (const c of t.children) visit(c); return; }
    const uri = t.content?.uri, box = t.boundingVolume?.box;
    if (uri && box && urls[uri]) out.push({ path: uri, box: aabbOf(box) });
  };
  visit(root);
  return out;
}

const overlaps = (a: ArrayLike<number>, b: ArrayLike<number>, pad = 0) =>
  a[0] - pad <= b[3] && a[3] + pad >= b[0] && a[1] - pad <= b[4] && a[4] + pad >= b[1] && a[2] - pad <= b[5] && a[5] + pad >= b[2];

/** The leaf tiles overlapping any of these boxes (each [minX, minY, minZ, maxX, maxY, maxZ]). */
export function tilesFor(leaves: readonly LeafTile[], boxes: ArrayLike<number>[], pad = 0): LeafTile[] {
  return leaves.filter(t => boxes.some(b => overlaps(t.box, b, pad)));
}

/** A tile file: from this browser's tile cache (the viewer's, shared), else downloaded and kept there. */
export async function tileBytes(urls: Record<string, string>, path: string): Promise<ArrayBuffer> {
  const url = urls[path];
  const run = runOf(urls['tileset.json'] ?? '');
  let cache: Cache | null = null;
  if (run && typeof caches !== 'undefined') { try { cache = await caches.open(`mir-tiles:${run.model}`); } catch { cache = null; } }
  const key = run ? cacheKeyOf(run.run, path, url) : '';
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`타일을 받지 못했습니다 (HTTP ${res.status})`);
  const body = await res.arrayBuffer();
  if (cache) cache.put(key, new Response(body.slice(0), { headers: { 'content-type': 'model/gltf-binary' } })).catch(() => {});
  return body;
}

type Gltf = {
  nodes: { translation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
  accessors: { bufferView: number; componentType: number; count: number; byteOffset?: number }[];
  bufferViews: { byteStride?: number; byteLength: number; extensions?: { EXT_meshopt_compression?: { byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string } } }[];
};

/** One decoded tile primitive: vertices in the tileset frame, indices, and its triangles grouped by object. */
type DecodedPrim = {
  vx: Float32Array;
  idx: Uint32Array | Uint16Array;
  /** Triangle numbers (first index / 3) ordered by object; object id → [from, to) into this. */
  tris: Uint32Array;
  ranges: Map<number, [number, number]>;
};
/** A leaf tile decoded once and kept (clash batches over the same area reuse it instead of decoding the file again). */
export type DecodedTile = { prims: DecodedPrim[]; bytes: number };

/** Decode a tile .glb: meshopt buffers, vertices once to the tileset frame, triangles grouped by `_FEATURE_ID_0`. */
export async function decodeTile(glb: ArrayBuffer): Promise<DecodedTile> {
  const dv = new DataView(glb);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('타일 형식 오류');
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as Gltf;
  const binStart = 20 + jsonLength + 8;
  const bin = new Uint8Array(glb, binStart, dv.getUint32(20 + jsonLength, true));
  await MeshoptDecoder.ready;
  const views = new Map<number, Uint8Array>();
  const view = (i: number): Uint8Array => {
    let v = views.get(i);
    if (v) return v;
    const bv = json.bufferViews[i], m = bv.extensions?.EXT_meshopt_compression;
    if (!m) throw new Error('타일 형식 오류(압축 없음)');
    v = new Uint8Array(m.count * m.byteStride);
    MeshoptDecoder.decodeGltfBuffer(v, m.count, m.byteStride, bin.subarray(m.byteOffset ?? 0, (m.byteOffset ?? 0) + m.byteLength), m.mode, m.filter ?? 'NONE');
    views.set(i, v);
    return v;
  };
  const node = json.nodes[0] ?? {};
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const n = (v: number) => Math.max(v / 32767, -1);
  const prims: DecodedPrim[] = [];
  let bytes = 0;
  for (const prim of json.meshes[0]?.primitives ?? []) {
    const pa = json.accessors[prim.attributes.POSITION], ia = json.accessors[prim.attributes._FEATURE_ID_0], xa = json.accessors[prim.indices];
    if (!pa || !ia || !xa) continue;
    const pv = view(pa.bufferView), iv = view(ia.bufferView), xv = view(xa.bufferView);
    const pos = new Int16Array(pv.buffer, pv.byteOffset + (pa.byteOffset ?? 0), pa.count * 4);
    const ids = new Float32Array(iv.buffer, iv.byteOffset + (ia.byteOffset ?? 0), ia.count);
    const idx = xa.componentType === 5125
      ? new Uint32Array(xv.buffer, xv.byteOffset + (xa.byteOffset ?? 0), xa.count)
      : new Uint16Array(xv.buffer, xv.byteOffset + (xa.byteOffset ?? 0), xa.count);
    // Vertices once in the tileset frame: glTF (X, Y, Z) = translation + scale · normalized; tileset (x, y, z) = (X, −Z, Y).
    const vx = new Float32Array(pa.count * 3);
    for (let v = 0; v < pa.count; v++) {
      const X = tx + sx * n(pos[v * 4]), Y = ty + sy * n(pos[v * 4 + 1]), Z = tz + sz * n(pos[v * 4 + 2]);
      vx[v * 3] = X; vx[v * 3 + 1] = -Z; vx[v * 3 + 2] = Y;
    }
    // Triangles grouped by object (counting sort over the ids met).
    const triCount = Math.floor(idx.length / 3);
    const counts = new Map<number, number>();
    for (let t = 0; t < triCount; t++) { const id = Math.round(ids[idx[t * 3]]); counts.set(id, (counts.get(id) ?? 0) + 1); }
    const ranges = new Map<number, [number, number]>();
    let at = 0;
    for (const [id, c] of counts) { ranges.set(id, [at, at]); at += c; }
    const tris = new Uint32Array(triCount);
    for (let t = 0; t < triCount; t++) { const r = ranges.get(Math.round(ids[idx[t * 3]]))!; tris[r[1]++] = t; }
    prims.push({ vx, idx, tris, ranges });
    bytes += vx.byteLength + idx.byteLength + tris.byteLength + ranges.size * 64;
  }
  return { prims, bytes };
}

/**
 * Triangles of the wanted objects in a decoded tile, appended per object to `out` as Float32Array chunks of xyz triples
 * (tileset frame). `region` [minX, minY, minZ, maxX, maxY, maxZ]: only triangles whose box meets it (a clash batch
 * needs the objects only where they can touch). Typed arrays sized by a counting pass (no growing JS number arrays —
 * 2026-11-26 whole-model clash ran the browser out of memory).
 */
export function trianglesOf(tile: DecodedTile, wanted: Iterable<number>, out: Map<number, Float32Array[]>, region?: ArrayLike<number>): void {
  for (const { vx, idx, tris, ranges } of tile.prims) {
    const meets = (t: number) => {
      if (!region) return true;
      const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
      for (let a = 0; a < 3; a++) {
        const p0 = vx[i0 + a], p1 = vx[i1 + a], p2 = vx[i2 + a];
        if ((p0 > p1 ? (p0 > p2 ? p0 : p2) : (p1 > p2 ? p1 : p2)) < region[a]) return false;
        if ((p0 < p1 ? (p0 < p2 ? p0 : p2) : (p1 < p2 ? p1 : p2)) > region[a + 3]) return false;
      }
      return true;
    };
    for (const id of wanted) {
      const r = ranges.get(id);
      if (!r) continue;
      let c = 0;
      for (let k = r[0]; k < r[1]; k++) if (meets(tris[k])) c++;
      if (!c) continue;
      const arr = new Float32Array(c * 9);
      let at = 0;
      for (let k = r[0]; k < r[1]; k++) {
        const t = tris[k];
        if (!meets(t)) continue;
        for (let j = 0; j < 3; j++) { const v = idx[t * 3 + j] * 3; arr[at++] = vx[v]; arr[at++] = vx[v + 1]; arr[at++] = vx[v + 2]; }
      }
      const list = out.get(id);
      if (list) list.push(arr); else out.set(id, [arr]);
    }
  }
}

/** Triangles of the wanted objects in one tile file (decode + trianglesOf). */
export async function collectTriangles(glb: ArrayBuffer, wanted: ReadonlySet<number>, out: Map<number, Float32Array[]>, region?: ArrayLike<number>): Promise<void> {
  trianglesOf(await decodeTile(glb), wanted, out, region);
}
