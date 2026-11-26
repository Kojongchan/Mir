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
//   2) 협역: 쌍을 겹침 상자 중심의 주 방향(현장이 긴 쪽) 순서로 정렬해, 폭 120m·1,000쌍 이하의 촘촘한 묶음으로 나눈다.
//      묶음마다 그 구역(겹침 상자들의 합 + 1m)과 만나는 잎 타일만 읽고, 묶음 객체의 삼각형 중 구역과 만나는 것만 형식 배열로
//      모아 BVH 를 만들고 교차 + 관통깊이(apsClash 와 같은 함수, 표본 256). 묶음이 끝나면 형상을 모두 버린다 — 들고 있는
//      것은 한 묶음 구역 분량뿐이라 모델 전체 대 전체도 메모리가 넘치지 않는다
//      (2026-11-26 TEST 전체 간섭에서 브라우저 Out of Memory — 전 객체 형상을 한꺼번에 들고 있었음).
//   선택: 같은 파일끼리의 쌍 제외(groupOf), 남은 시간 표시.
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
  /** 객체 → 묶음 번호(예: 최상위 파일). 주면 같은 묶음끼리의 쌍은 검사하지 않는다(「같은 파일끼리 제외」). */
  groupOf?: (dbId: number) => number;
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
export function candidatePairs(boxes: Float32Array, idsA: readonly number[], idsB: readonly number[], pad: number, limit = Infinity,
  groupOf?: (dbId: number) => number): Pairs & { truncated: boolean } {
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
      if (groupOf && groupOf(e) === groupOf(q)) continue;
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
export async function estimateClash(urls: Record<string, string>, boxes: Float32Array, idsA: readonly number[], idsB: readonly number[], tolerance: number,
  groupOf?: (dbId: number) => number, limit = 3_000_000) {
  const pairs = candidatePairs(boxes, idsA, idsB, Math.max(0, tolerance), limit, groupOf);
  const wanted = new Set<number>();
  for (let i = 0; i < pairs.count; i++) { wanted.add(pairs.a[i]); wanted.add(pairs.b[i]); }
  const leaves = await leafTiles(urls);
  const tiles = tilesFor(leaves, [...wanted].map(id => boxOf(boxes, id)).filter((x): x is Float32Array => !!x), 0.01);
  return { pairs: pairs.count, truncated: pairs.truncated, objects: wanted.size, tiles: tiles.length };
}

let seq = 0;
const element = (id: number, m: { name: string; category: string }): ElementMeta => ({ modelID: 0, expressID: id, name: m.name, category: m.category || 'UNKNOWN' });

/** 한 묶음: 쌍 수 상한과 주 방향 폭(m) 상한 — 묶음 구역 안의 형상만 모은다. */
const BATCH_PAIRS = 1000;
const BATCH_SPAN = 120;
/** 관통깊이 표본(정점 수, 양쪽 각각) — 기존 뷰어(1,200)보다 적게: 전체 검사는 수십만 쌍. */
const DEPTH_SAMPLES = 256;

export async function runMirClashDetection(input: MirClashInput): Promise<ClashHit[]> {
  const { urls, boxes, idsA, idsB, type, tolerance, meta, onProgress, shouldCancel } = input;
  const maxHits = input.maxHits ?? 20000;
  const pad = Math.max(0, tolerance);
  onProgress?.(0.01, '경계상자 비교');
  await yieldToUi();
  const pairs = candidatePairs(boxes, idsA, idsB, pad, 3_000_000, input.groupOf);
  if (pairs.truncated) throw new Error('후보 쌍이 300만 개를 넘습니다. 대상을 파일·분류 단위로 나누거나 「같은 파일끼리 제외」를 켜세요.');
  if (!pairs.count || shouldCancel?.()) { onProgress?.(1, '완료'); return []; }
  const leaves: LeafTile[] = await leafTiles(urls);

  // 쌍의 겹침 상자(허용오차만큼 넓힘)와, 현장의 주 방향(x·y 중 긴 쪽)으로 그 중심 순서.
  const n = pairs.count;
  const ov = new Float32Array(n * 6);
  let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = pairs.a[i] * 6, b = pairs.b[i] * 6;
    for (let k = 0; k < 3; k++) {
      ov[i * 6 + k] = Math.max(boxes[a + k], boxes[b + k]) - pad;
      ov[i * 6 + 3 + k] = Math.min(boxes[a + 3 + k], boxes[b + 3 + k]) + pad;
    }
    lo0 = Math.min(lo0, ov[i * 6]); hi0 = Math.max(hi0, ov[i * 6 + 3]); lo1 = Math.min(lo1, ov[i * 6 + 1]); hi1 = Math.max(hi1, ov[i * 6 + 4]);
  }
  const axis = hi0 - lo0 >= hi1 - lo1 ? 0 : 1;
  const key = new Float32Array(n);
  for (let i = 0; i < n; i++) key[i] = (ov[i * 6 + axis] + ov[i * 6 + 3 + axis]) / 2;
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((p, q) => key[p] - key[q] || p - q);

  const identity = new THREE.Matrix4();
  const overlap = new THREE.Box3(), ca = new THREE.Vector3(), cb = new THREE.Vector3();
  const hits: ClashHit[] = [];
  const hitOf = (a: number, b: number, point: THREE.Vector3, depth: number): ClashHit => ({
    id: `mirclash-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    a: element(a, meta(a)), b: element(b, meta(b)),
    point: { x: point.x, y: point.y, z: point.z }, depth,
  });
  const build = (id: number, chunks: Float32Array[] | undefined): ApsClashGeom | null => {
    if (!chunks?.length) return null;
    let len = 0;
    for (const c of chunks) len += c.length;
    if (len < 9) return null;
    const all = new Float32Array(len);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(all, 3));
    const bvh = new MeshBVH(geometry);
    (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
    const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    return { dbId: id, geometry, box, bvh };
  };

  const started = performance.now();
  let done = 0, batchNo = 0;
  const eta = () => {
    if (done < 200) return '';
    const s = ((performance.now() - started) / done) * (n - done) / 1000;
    return s > 90 ? ` · 남은 시간 약 ${Math.round(s / 60)}분` : ` · 남은 시간 약 ${Math.max(1, Math.round(s))}초`;
  };
  for (let from = 0; from < n && !shouldCancel?.() && hits.length < maxHits;) {
    // 묶음: 주 방향으로 BATCH_SPAN m 안, BATCH_PAIRS 쌍까지(겹침이 아주 긴 쌍은 혼자 한 묶음).
    let to = from + 1;
    const start = ov[order[from] * 6 + axis];
    while (to < n && to - from < BATCH_PAIRS && ov[order[to] * 6 + 3 + axis] - start <= BATCH_SPAN && ov[order[to - 1] * 6 + 3 + axis] - start <= BATCH_SPAN) to++;
    batchNo++;
    const region = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const want = new Set<number>();
    for (let j = from; j < to; j++) {
      const i = order[j];
      for (let k = 0; k < 3; k++) { region[k] = Math.min(region[k], ov[i * 6 + k] - 1); region[k + 3] = Math.max(region[k + 3], ov[i * 6 + 3 + k] + 1); }
      want.add(pairs.a[i]); want.add(pairs.b[i]);
    }
    const wantedBoxes = [...want].map(id => boxOf(boxes, id)).filter((x): x is Float32Array => !!x);
    const inRegion = new Set(tilesFor(leaves, [region], 0).map(t => t.path));
    const tiles = tilesFor(leaves, wantedBoxes, 0.01).filter(t => inRegion.has(t.path));
    // 타일별로 모아 타일 순서대로 합친다(실행마다 같은 결과).
    const perTile: Map<number, Float32Array[]>[] = new Array(tiles.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, tiles.length) }, async () => {
      for (let i = next++; i < tiles.length; i = next++) {
        if (shouldCancel?.()) return;
        const own = new Map<number, Float32Array[]>();
        await collectTriangles(await tileBytes(urls, tiles[i].path), want, own, region);
        perTile[i] = own;
      }
    }));
    const chunks = new Map<number, Float32Array[]>();
    for (const own of perTile) if (own) for (const [id, list] of own) { const all = chunks.get(id); if (all) all.push(...list); else chunks.set(id, [...list]); }
    const geoms = new Map<number, ApsClashGeom | null>();
    const geomOf = (id: number) => { if (!geoms.has(id)) geoms.set(id, build(id, chunks.get(id))); return geoms.get(id)!; };
    for (let j = from; j < to; j++) {
      const i = order[j], a = pairs.a[i], b = pairs.b[i];
      const ga = geomOf(a), gb = geomOf(b);
      if (ga && gb) {
        const intersects = ga.bvh.intersectsGeometry(gb.geometry, identity);
        overlap.copy(ga.box).intersect(gb.box);
        const middle = () => (overlap.isEmpty() ? ga.box.getCenter(ca).clone().lerp(gb.box.getCenter(cb), 0.5) : overlap.getCenter(new THREE.Vector3()));
        if (type === 'hard') {
          if (intersects) {
            const depth = penetrationDepth(ga, gb, overlap, DEPTH_SAMPLES);
            if (depth >= tolerance) hits.push(hitOf(a, b, middle(), depth));
          }
        } else if (intersects) hits.push(hitOf(a, b, middle(), 0));
        else {
          ga.box.getCenter(ca); gb.box.getCenter(cb);
          hits.push(hitOf(a, b, ca.clone().lerp(cb, 0.5), ca.distanceTo(cb)));
        }
      }
      done++;
      if (done % 150 === 0) {
        onProgress?.(0.03 + (done / n) * 0.97, `간섭 검사 ${done.toLocaleString()}/${n.toLocaleString()}쌍 · ${hits.length.toLocaleString()}건${eta()}`);
        await yieldToUi();
        if (shouldCancel?.()) break;
      }
      if (hits.length >= maxHits) break;
    }
    for (const g of geoms.values()) g?.geometry.dispose();
    from = to;
  }
  onProgress?.(1, hits.length >= maxHits ? `결과가 ${maxHits.toLocaleString()}건에 닿아 멈췄습니다` : '완료');
  return hits;
}
