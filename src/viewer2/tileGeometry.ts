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

/**
 * Triangles of the wanted objects in one tile, appended per object to `out` as flat xyz triples (tileset frame).
 */
export async function collectTriangles(glb: ArrayBuffer, wanted: ReadonlySet<number>, out: Map<number, number[]>): Promise<void> {
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
  for (const prim of json.meshes[0]?.primitives ?? []) {
    const pa = json.accessors[prim.attributes.POSITION], ia = json.accessors[prim.attributes._FEATURE_ID_0], xa = json.accessors[prim.indices];
    if (!pa || !ia || !xa) continue;
    const pv = view(pa.bufferView), iv = view(ia.bufferView), xv = view(xa.bufferView);
    const pos = new Int16Array(pv.buffer, pv.byteOffset + (pa.byteOffset ?? 0), pa.count * 4);
    const ids = new Float32Array(iv.buffer, iv.byteOffset + (ia.byteOffset ?? 0), ia.count);
    const idx = xa.componentType === 5125
      ? new Uint32Array(xv.buffer, xv.byteOffset + (xa.byteOffset ?? 0), xa.count)
      : new Uint16Array(xv.buffer, xv.byteOffset + (xa.byteOffset ?? 0), xa.count);
    const n = (v: number) => Math.max(v / 32767, -1);
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const id = Math.round(ids[idx[t]]);
      if (!wanted.has(id)) continue;
      let list = out.get(id);
      if (!list) { list = []; out.set(id, list); }
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k] * 4;
        // glTF (X, Y, Z) = translation + scale · normalized; tileset frame (x, y, z) = (X, −Z, Y).
        const X = tx + sx * n(pos[v]), Y = ty + sy * n(pos[v + 1]), Z = tz + sz * n(pos[v + 2]);
        list.push(X, -Z, Y);
      }
    }
  }
}
