import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ElementMeta } from '../viewer/IfcViewer';
import type { ClashHit, ClashType } from './clash';
import { penetrationDepth, type ApsClashGeom } from './apsClash';
import { collectTriangles, leafTiles, tileBytes, tilesFor, type LeafTile } from '../viewer2/tileGeometry';

// =====================================================================
// 자체 엔진(3D Tiles) 간섭 검출 — 기존 APS 간섭(apsClash.ts)과 같은 판정·같은 결과 형식(ClashHit).
//   1) 광역: 객체 상자(objects.bin, 타일셋 좌표)로 후보쌍(허용오차만큼 넓혀 겹치는 쌍)을 추린다 — x 축 정렬 후 훑기.
//   2) 협역: 후보 객체가 든 가장 세밀한 타일(잎)만 받아 객체별 삼각형을 모으고 BVH 교차 + 관통깊이(apsClash 와 같은 함수).
// 화면에 보이는 단계와 상관없이 원본 단계 형상으로 계산한다. 결과의 expressID 슬롯 = dbId, modelID = 0(한 모델).
// =====================================================================

export interface MirClashInput {
  /** 열린 타일셋의 경로 → 서명 URL (tileset.json·타일 파일). */
  urls: Record<string, string>;
  /** objects.bin: dbId 마다 [minX, minY, minZ, maxX, maxY, maxZ]. */
  boxes: Float32Array;
  idsA: readonly number[];
  idsB: readonly number[];
  type: ClashType;
  /** 허용오차(m). hard: 이보다 얕게 파고든 접촉은 제외, clearance: 이 거리 안의 근접. */
  tolerance: number;
  /** dbId → 이름·분류(그룹화·표). */
  meta: (dbId: number) => { name: string; category: string };
  onProgress?: (ratio: number, phase: string) => void;
  shouldCancel?: () => boolean;
}

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function boxOf(boxes: Float32Array, id: number): Float32Array | null {
  if (id < 0 || id * 6 + 5 >= boxes.length) return null;
  const b = boxes.subarray(id * 6, id * 6 + 6);
  return Number.isNaN(b[0]) || b[0] > b[3] ? null : b;
}

/** Pairs (a, b) whose boxes, widened by `pad`, overlap: sweep along x over both sets sorted by min x. */
export function candidatePairs(boxes: Float32Array, idsA: readonly number[], idsB: readonly number[], pad: number): [number, number][] {
  type E = { id: number; side: 0 | 1; b: Float32Array };
  const items: E[] = [];
  for (const id of new Set(idsA)) { const b = boxOf(boxes, id); if (b) items.push({ id, side: 0, b }); }
  for (const id of new Set(idsB)) { const b = boxOf(boxes, id); if (b) items.push({ id, side: 1, b }); }
  items.sort((p, q) => p.b[0] - q.b[0]);
  const activeA: E[] = [], activeB: E[] = [];
  const seen = new Set<string>(), out: [number, number][] = [];
  const hit = (p: Float32Array, q: Float32Array) =>
    p[1] - pad <= q[4] && p[4] + pad >= q[1] && p[2] - pad <= q[5] && p[5] + pad >= q[2];
  for (const e of items) {
    const minX = e.b[0] - pad;
    for (const list of [activeA, activeB]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].b[3] + pad < minX) list.splice(i, 1);
    }
    // e against the other side (and, for an object in both sets, the same side counts as the other)
    for (const other of e.side === 0 ? activeB : activeA) {
      if (other.id === e.id || !hit(e.b, other.b)) continue;
      const [a, b] = e.side === 0 ? [e.id, other.id] : [other.id, e.id];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
    (e.side === 0 ? activeA : activeB).push(e);
  }
  return out;
}

let seq = 0;
const element = (id: number, m: { name: string; category: string }): ElementMeta => ({ modelID: 0, expressID: id, name: m.name, category: m.category || 'UNKNOWN' });

export async function runMirClashDetection(input: MirClashInput): Promise<ClashHit[]> {
  const { urls, boxes, idsA, idsB, type, tolerance, meta, onProgress, shouldCancel } = input;
  const pad = Math.max(0, tolerance);
  onProgress?.(0.02, '경계상자 비교');
  await yieldToUi();
  const pairs = candidatePairs(boxes, idsA, idsB, pad);
  if (!pairs.length || shouldCancel?.()) { onProgress?.(1, '완료'); return []; }

  // 후보 객체의 원본 형상: 그 객체 상자와 겹치는 잎 타일만.
  const wanted = new Set<number>();
  for (const [a, b] of pairs) { wanted.add(a); wanted.add(b); }
  onProgress?.(0.05, '타일 목록');
  const leaves: LeafTile[] = await leafTiles(urls);
  const wantedBoxes = [...wanted].map(id => boxOf(boxes, id)).filter((b): b is Float32Array => !!b);
  const tiles = tilesFor(leaves, wantedBoxes, 0.01);
  const tris = new Map<number, number[]>();
  let done = 0;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < tiles.length; i = next++) {
      if (shouldCancel?.()) return;
      await collectTriangles(await tileBytes(urls, tiles[i].path), wanted, tris);
      done++;
      onProgress?.(0.05 + (done / tiles.length) * 0.55, `원본 형상 받는 중 ${done}/${tiles.length}타일`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tiles.length) }, worker));
  if (shouldCancel?.()) return [];

  // 협역: 객체별 BVH(필요할 때 한 번).
  const geoms = new Map<number, ApsClashGeom | null>();
  const geomOf = (id: number): ApsClashGeom | null => {
    if (geoms.has(id)) return geoms.get(id)!;
    const list = tris.get(id);
    let g: ApsClashGeom | null = null;
    if (list && list.length >= 9) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list), 3));
      const bvh = new MeshBVH(geometry);
      (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
      const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
      g = { dbId: id, geometry, box, bvh };
    }
    geoms.set(id, g);
    return g;
  };
  const identity = new THREE.Matrix4();
  const overlap = new THREE.Box3(), ca = new THREE.Vector3(), cb = new THREE.Vector3();
  const hits: ClashHit[] = [];
  const hitOf = (a: number, b: number, point: THREE.Vector3, depth: number): ClashHit => ({
    id: `mirclash-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    a: element(a, meta(a)), b: element(b, meta(b)),
    point: { x: point.x, y: point.y, z: point.z }, depth,
  });
  for (let i = 0; i < pairs.length; i++) {
    if (shouldCancel?.()) break;
    const [a, b] = pairs[i];
    const ga = geomOf(a), gb = geomOf(b);
    if (ga && gb) {
      const intersects = ga.bvh.intersectsGeometry(gb.geometry, identity);
      overlap.copy(ga.box).intersect(gb.box);
      const middle = () => (overlap.isEmpty() ? ga.box.getCenter(ca).clone().lerp(gb.box.getCenter(cb), 0.5) : overlap.getCenter(new THREE.Vector3()));
      if (type === 'hard') {
        if (intersects) {
          const depth = penetrationDepth(ga, gb, overlap);
          if (depth >= tolerance) hits.push(hitOf(a, b, middle(), depth));
        }
      } else if (intersects) hits.push(hitOf(a, b, middle(), 0));
      else {
        ga.box.getCenter(ca); gb.box.getCenter(cb);
        hits.push(hitOf(a, b, ca.clone().lerp(cb, 0.5), ca.distanceTo(cb)));
      }
    }
    if (i % 20 === 0) { onProgress?.(0.6 + (i / pairs.length) * 0.4, `간섭 검사 ${i}/${pairs.length}쌍`); await yieldToUi(); }
  }
  for (const g of geoms.values()) g?.geometry.dispose();
  onProgress?.(1, '완료');
  return hits;
}
