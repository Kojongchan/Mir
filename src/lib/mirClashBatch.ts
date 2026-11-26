import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ClashType } from './clash';
import { penetrationDepth, type ApsClashGeom } from './apsClash';
import { decodeTile, tileBytes, trianglesOf, type DecodedTile } from '../viewer2/tileGeometry';

// =====================================================================
// 자체 엔진 간섭 검출의 협역 한 묶음(mirClash.ts 가 나눠 준다) — 웹 워커(mirClash.worker.ts)에서도, 워커를 못 쓰면
// 화면 스레드에서도 같은 함수로 돈다. 묶음 구역과 만나는 잎 타일(풀어 둔 것은 TileStore 에서 재사용)에서 묶음 객체의
// 삼각형 중 구역과 만나는 것만 모아 BVH → 교차 + 관통깊이(겹침 박스 안 정점). 묶음이 끝나면 형상은 버린다.
// =====================================================================

/** 한 묶음: 쌍(a[i]·b[i] dbId), 구역 [minX, minY, minZ, maxX, maxY, maxZ](타일셋 좌표), 읽을 잎 타일 경로(이 순서로 합침). */
export type ClashBatch = { a: Int32Array; b: Int32Array; region: number[]; tiles: string[]; type: ClashType; tolerance: number };
export type BatchStats = { decodes: number; reuse: number; tileMs: number; buildMs: number; narrowMs: number };
/** 결과: 간섭마다 [a, b, x, y, z, depth] 를 이어 붙인 배열(워커에서 그대로 넘긴다). */
export type BatchResult = { hits: Float64Array; stats: BatchStats };

/** 관통깊이: 겹침 박스 안 정점만 추려 최대 1,200 개(양쪽 각각)를 검사 — 기존 뷰어(전체 정점에서 1,200 표본)보다 겹친 부분을 촘촘히 본다. */
const DEPTH_SAMPLES = 1200;

/** 풀어 둔 타일(정점·삼각형): 최근 사용 순, 바이트 예산을 넘으면 오래된 것부터 버린다 — 이웃 묶음이 같은 타일을 다시 풀지 않게. */
export class TileStore {
  private readonly decoded = new Map<string, DecodedTile>();
  private readonly decoding = new Map<string, Promise<DecodedTile>>();
  private bytes = 0;
  decodes = 0;
  reuse = 0;
  constructor(private readonly urls: Record<string, string>, private readonly budget: number) {}

  async get(path: string): Promise<DecodedTile> {
    const hit = this.decoded.get(path);
    if (hit) { this.decoded.delete(path); this.decoded.set(path, hit); this.reuse++; return hit; }
    let job = this.decoding.get(path);
    if (!job) {
      job = tileBytes(this.urls, path).then(decodeTile).finally(() => this.decoding.delete(path));
      this.decoding.set(path, job);
      this.decodes++;
    }
    const tile = await job;
    if (!this.decoded.has(path)) {
      this.decoded.set(path, tile); this.bytes += tile.bytes;
      for (const [k, t] of this.decoded) {
        if (this.bytes <= this.budget || this.decoded.size <= 1) break;
        this.decoded.delete(k); this.bytes -= t.bytes;
      }
    }
    return tile;
  }

  clear(): void { this.decoded.clear(); this.bytes = 0; }
}

function build(id: number, chunks: Float32Array[] | undefined): ApsClashGeom | null {
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
}

const identity = new THREE.Matrix4();

export async function runClashBatch(job: ClashBatch, store: TileStore, shouldCancel?: () => boolean): Promise<BatchResult> {
  const { a: as, b: bs, region, tiles, type, tolerance } = job;
  const stats: BatchStats = { decodes: 0, reuse: 0, tileMs: 0, buildMs: 0, narrowMs: 0 };
  const d0 = store.decodes, r0 = store.reuse;
  const want = new Set<number>();
  for (let i = 0; i < as.length; i++) { want.add(as[i]); want.add(bs[i]); }
  // 타일별로 모아 타일 순서대로 합친다(실행마다 같은 결과).
  const t0 = performance.now();
  const perTile: Map<number, Float32Array[]>[] = new Array(tiles.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, async () => {
    for (let i = next++; i < tiles.length; i = next++) {
      if (shouldCancel?.()) return;
      const own = new Map<number, Float32Array[]>();
      trianglesOf(await store.get(tiles[i]), want, own, region);
      perTile[i] = own;
    }
  }));
  const chunks = new Map<number, Float32Array[]>();
  for (const own of perTile) if (own) for (const [id, list] of own) { const all = chunks.get(id); if (all) all.push(...list); else chunks.set(id, [...list]); }
  stats.tileMs = performance.now() - t0;
  stats.decodes = store.decodes - d0; stats.reuse = store.reuse - r0;

  const geoms = new Map<number, ApsClashGeom | null>();
  const geomOf = (id: number) => {
    if (!geoms.has(id)) { const t = performance.now(); geoms.set(id, build(id, chunks.get(id))); stats.buildMs += performance.now() - t; }
    return geoms.get(id)!;
  };
  const out: number[] = [];
  const overlap = new THREE.Box3(), ca = new THREE.Vector3(), cb = new THREE.Vector3(), p = new THREE.Vector3();
  const push = (a: number, b: number, point: THREE.Vector3, depth: number) => out.push(a, b, point.x, point.y, point.z, depth);
  for (let i = 0; i < as.length; i++) {
    if (i % 64 === 0 && shouldCancel?.()) break;
    const a = as[i], b = bs[i];
    const ga = geomOf(a), gb = geomOf(b);
    if (!ga || !gb) continue;
    const t1 = performance.now();
    const intersects = ga.bvh.intersectsGeometry(gb.geometry, identity);
    overlap.copy(ga.box).intersect(gb.box);
    const middle = () => (overlap.isEmpty() ? ga.box.getCenter(ca).lerp(gb.box.getCenter(cb), 0.5) : overlap.getCenter(p));
    if (type === 'hard') {
      if (intersects) {
        const depth = penetrationDepth(ga, gb, overlap, DEPTH_SAMPLES, true, tolerance);
        if (depth >= tolerance) push(a, b, middle(), depth);
      }
    } else if (intersects) push(a, b, middle(), 0);
    else {
      ga.box.getCenter(ca); gb.box.getCenter(cb);
      push(a, b, p.copy(ca).lerp(cb, 0.5), ca.distanceTo(cb));
    }
    stats.narrowMs += performance.now() - t1;
  }
  for (const g of geoms.values()) g?.geometry.dispose();
  return { hits: Float64Array.from(out), stats };
}
