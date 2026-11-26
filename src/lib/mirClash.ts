import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ElementMeta } from '../viewer/IfcViewer';
import type { ClashHit, ClashType } from './clash';
import { penetrationDepth, type ApsClashGeom } from './apsClash';
import { collectTriangles, leafTiles, tileBytes, tilesFor, type LeafTile } from '../viewer2/tileGeometry';

// =====================================================================
// 자체 엔진(3D Tiles) 간섭 검출 — 기존 APS 간섭(apsClash.ts)과 같은 판정·같은 결과 형식(ClashHit).
//   1) 광역: 객체 상자(objects.bin, 타일셋 좌표)로 후보쌍(허용오차만큼 넓혀 겹치는 쌍)을 추린다 — 두 집합을 합쳐
//      x 축 정렬 후 한 번 훑기(같은 쌍은 한 번만, 쌍은 정수 배열에).
//   2) 협역: 쌍을 공간 순서(훑은 순서)대로 묶음 단위로 처리한다. 묶음의 객체 중 아직 없는 것만 그 상자와 겹치는 가장
//      세밀한 타일(잎)에서 원본 삼각형을 모아 BVH 를 만들고, 교차 + 관통깊이(apsClash 와 같은 함수). 만든 형상은
//      삼각형 예산(LRU) 안에서만 두고 오래 안 쓴 것부터 버려, 모델 전체 대 전체도 메모리가 넘치지 않는다
//      (2026-11-26 TEST 전체 간섭에서 브라우저 Out of Memory — 전 객체 형상을 한꺼번에 들고 있었음).
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
  /** 검사 결과가 이보다 많으면 멈춘다(목록·저장이 감당 못 함). */
  maxHits?: number;
}

/** 후보쌍: a[i]·b[i] (A 쪽·B 쪽 dbId), 훑은 순서 = 대략 x 순서. */
export type Pairs = { a: Int32Array; b: Int32Array; count: number };

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function boxOf(boxes: Float32Array, id: number): Float32Array | null {
  if (id < 0 || id * 6 + 5 >= boxes.length) return null;
  const b = boxes.subarray(id * 6, id * 6 + 6);
  return Number.isNaN(b[0]) || b[0] > b[3] ? null : b;
}

/**
 * Pairs (one from A, one from B, never an object with itself) whose boxes, widened by `pad`, overlap. A and B may share
 * objects (전체 대 전체): the union is swept once along x, each unordered pair is seen once. Stops at `limit` pairs
 * (count then reports how many were found up to that point and `truncated` is set).
 */
export function candidatePairs(boxes: Float32Array, idsA: readonly number[], idsB: readonly number[], pad: number, limit = Infinity): Pairs & { truncated: boolean } {
  const inA = new Set(idsA), inB = new Set(idsB);
  const ids = [...new Set([...idsA, ...idsB])].filter(id => boxOf(boxes, id));
  ids.sort((p, q) => boxes[p * 6] - boxes[q * 6] || p - q);
  let a = new Int32Array(1024), b = new Int32Array(1024), count = 0, truncated = false;
  const push = (x: number, y: number) => {
    if (count === a.length) { const na = new Int32Array(a.length * 2), nb = new Int32Array(b.length * 2); na.set(a); nb.set(b); a = na; b = nb; }
    a[count] = x; b[count] = y; count++;
  };
  let active: number[] = [];
  for (const e of ids) {
    const o = e * 6, minX = boxes[o] - pad;
    if (active.length > 64) active = active.filter(q => boxes[q * 6 + 3] + pad >= minX);
    for (const q of active) {
      const p = q * 6;
      if (boxes[p + 3] + pad < minX) continue;
      if (boxes[o + 1] - pad > boxes[p + 4] || boxes[o + 4] + pad < boxes[p + 1] || boxes[o + 2] - pad > boxes[p + 5] || boxes[o + 5] + pad < boxes[p + 2]) continue;
      if (inA.has(e) && inB.has(q)) push(e, q);
      else if (inA.has(q) && inB.has(e)) push(q, e);
      else continue;
      if (count >= limit) { truncated = true; return { a, b, count, truncated }; }
    }
    active.push(e);
  }
  return { a, b, count, truncated };
}

/** 검사 전 규모: 후보쌍 수(상한까지)와 받아야 할 잎 타일 수 — 오래 걸릴 검사를 미리 알린다. */
export async function estimateClash(urls: Record<string, string>, boxes: Float32Array, idsA: readonly number[], idsB: readonly number[], tolerance: number, limit = 3_000_000) {
  const pairs = candidatePairs(boxes, idsA, idsB, Math.max(0, tolerance), limit);
  const wanted = new Set<number>();
  for (let i = 0; i < pairs.count; i++) { wanted.add(pairs.a[i]); wanted.add(pairs.b[i]); }
  const leaves = await leafTiles(urls);
  const tiles = tilesFor(leaves, [...wanted].map(id => boxOf(boxes, id)).filter((x): x is Float32Array => !!x), 0.01);
  return { pairs: pairs.count, truncated: pairs.truncated, objects: wanted.size, tiles: tiles.length };
}

let seq = 0;
const element = (id: number, m: { name: string; category: string }): ElementMeta => ({ modelID: 0, expressID: id, name: m.name, category: m.category || 'UNKNOWN' });

/** 협역에 한 번에 들고 있는 형상의 상한(정점 좌표 float 수 ≈ 4바이트씩 + BVH). */
const GEOMETRY_BUDGET = 24_000_000;
/** 한 묶음의 쌍 수(같은 묶음의 객체 형상은 함께 만든다). */
const BATCH_PAIRS = 4000;

export async function runMirClashDetection(input: MirClashInput): Promise<ClashHit[]> {
  const { urls, boxes, idsA, idsB, type, tolerance, meta, onProgress, shouldCancel } = input;
  const maxHits = input.maxHits ?? 20000;
  const pad = Math.max(0, tolerance);
  onProgress?.(0.01, '경계상자 비교');
  await yieldToUi();
  const pairs = candidatePairs(boxes, idsA, idsB, pad, 3_000_000);
  if (pairs.truncated) throw new Error('후보 쌍이 300만 개를 넘습니다. 대상을 파일·분류 단위로 나눠 검사하세요.');
  if (!pairs.count || shouldCancel?.()) { onProgress?.(1, '완료'); return []; }
  const leaves: LeafTile[] = await leafTiles(urls);

  // 객체 형상 LRU: dbId → geometry(+BVH), 정점 float 수 합계가 예산을 넘으면 오래 안 쓴 것부터 버린다.
  const geoms = new Map<number, ApsClashGeom | null>();
  let held = 0;
  const sizeOf = (g: ApsClashGeom | null) => (g ? (g.geometry.getAttribute('position') as THREE.BufferAttribute).array.length : 0);
  const touch = (id: number) => { const g = geoms.get(id); if (g !== undefined) { geoms.delete(id); geoms.set(id, g); } };
  const evict = (keep: ReadonlySet<number>) => {
    for (const [id, g] of geoms) {
      if (held <= GEOMETRY_BUDGET) break;
      if (keep.has(id)) continue;
      held -= sizeOf(g); g?.geometry.dispose(); geoms.delete(id);
    }
  };
  const build = (id: number, list: number[] | undefined): ApsClashGeom | null => {
    if (!list || list.length < 9) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list), 3));
    const bvh = new MeshBVH(geometry);
    (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
    const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    return { dbId: id, geometry, box, bvh };
  };
  /** 아직 없는 객체들의 원본 삼각형: 그 상자와 겹치는 잎 타일만, 타일 순서대로 합쳐(실행마다 같은 결과) 만든다. */
  const load = async (ids: number[], batch: number, batches: number) => {
    const want = new Set(ids.filter(id => !geoms.has(id)));
    if (!want.size) return;
    const tiles = tilesFor(leaves, [...want].map(id => boxOf(boxes, id)).filter((x): x is Float32Array => !!x), 0.01);
    const perTile: Map<number, number[]>[] = new Array(tiles.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(6, tiles.length) }, async () => {
      for (let i = next++; i < tiles.length; i = next++) {
        if (shouldCancel?.()) return;
        const own = new Map<number, number[]>();
        await collectTriangles(await tileBytes(urls, tiles[i].path), want, own);
        perTile[i] = own;
        done++;
        if (done % 4 === 0) onProgress?.(0.05 + (batch / batches) * 0.95, `묶음 ${batch + 1}/${batches} · 원본 형상 ${done}/${tiles.length}타일`);
      }
    }));
    const tris = new Map<number, number[]>();
    for (const own of perTile) {
      if (!own) continue;
      for (const [id, list] of own) {
        const all = tris.get(id);
        if (!all) tris.set(id, list);
        else for (let k = 0; k < list.length; k++) all.push(list[k]);
      }
    }
    for (const id of want) { const g = build(id, tris.get(id)); geoms.set(id, g); held += sizeOf(g); }
  };

  const identity = new THREE.Matrix4();
  const overlap = new THREE.Box3(), ca = new THREE.Vector3(), cb = new THREE.Vector3();
  const hits: ClashHit[] = [];
  const hitOf = (a: number, b: number, point: THREE.Vector3, depth: number): ClashHit => ({
    id: `mirclash-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    a: element(a, meta(a)), b: element(b, meta(b)),
    point: { x: point.x, y: point.y, z: point.z }, depth,
  });
  const batches = Math.ceil(pairs.count / BATCH_PAIRS);
  for (let batch = 0; batch < batches; batch++) {
    if (shouldCancel?.()) break;
    const from = batch * BATCH_PAIRS, to = Math.min(pairs.count, from + BATCH_PAIRS);
    const ids = new Set<number>();
    for (let i = from; i < to; i++) { ids.add(pairs.a[i]); ids.add(pairs.b[i]); }
    onProgress?.(0.05 + (batch / batches) * 0.95, `묶음 ${batch + 1}/${batches} · 원본 형상 받는 중`);
    await load([...ids], batch, batches);
    for (const id of ids) touch(id);
    for (let i = from; i < to; i++) {
      const a = pairs.a[i], b = pairs.b[i];
      const ga = geoms.get(a) ?? null, gb = geoms.get(b) ?? null;
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
      if ((i - from) % 200 === 0) {
        onProgress?.(0.05 + ((batch + (i - from) / (to - from)) / batches) * 0.95, `묶음 ${batch + 1}/${batches} · 간섭 검사 ${i.toLocaleString()}/${pairs.count.toLocaleString()}쌍 · ${hits.length.toLocaleString()}건`);
        await yieldToUi();
        if (shouldCancel?.()) break;
      }
      if (hits.length >= maxHits) break;
    }
    if (hits.length >= maxHits) {
      onProgress?.(1, `결과가 ${maxHits.toLocaleString()}건을 넘어 멈췄습니다`);
      break;
    }
    evict(new Set());
  }
  for (const g of geoms.values()) g?.geometry.dispose();
  geoms.clear();
  onProgress?.(1, '완료');
  return hits;
}
