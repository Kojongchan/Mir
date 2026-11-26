import type { ElementMeta } from '../viewer/IfcViewer';
import type { ClashHit, ClashType } from './clash';
import { leafTiles, tilesFor, type LeafTile } from '../viewer2/tileGeometry';
import { runClashBatch, TileStore, type BatchResult, type ClashBatch } from './mirClashBatch';

// =====================================================================
// 자체 엔진(3D Tiles) 간섭 검출 — 기존 APS 간섭(apsClash.ts)과 같은 판정·같은 결과 형식(ClashHit).
//   1) 광역: 객체 상자(objects.bin, 타일셋 좌표)로 후보쌍(허용오차만큼 넓혀 겹치는 쌍)을 추린다 — 두 집합을 합쳐
//      x 축 정렬 후 한 번 훑기(같은 쌍은 한 번만, 쌍은 정수 배열에).
//   2) 협역: 쌍을 겹침 상자 중심의 주 방향(현장이 긴 쪽) 순서로 정렬해, 폭 120m·1,000쌍 이하의 촘촘한 묶음으로 나눈다.
//      묶음은 웹 워커 여러 개(코어 수 − 1, 최대 4)가 나눠 돈다(mirClash.worker.ts → mirClashBatch.ts): 묶음 구역과 만나는
//      잎 타일만 읽고(풀어 둔 타일은 워커마다 예산 안에서 재사용), 묶음 객체의 삼각형 중 구역과 만나는 것만 모아 BVH →
//      교차 + 관통깊이(apsClash 와 같은 함수, 표본 256 → 허용오차 미만이면 1,200). 묶음이 끝나면 형상은 버린다 — 들고
//      있는 것은 묶음 구역 분량 + 풀어 둔 타일뿐이라 모델 전체 대 전체도 메모리가 넘치지 않는다
//      (2026-11-26 TEST 전체 간섭에서 브라우저 Out of Memory — 전 객체 형상을 한꺼번에 들고 있었음).
//      결과는 묶음 순서대로 합쳐 병렬이어도 실행마다 같다.
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

/** 한 묶음: 쌍 수 상한(작은 검사는 워커 수에 맞춰 더 잘게)과 주 방향 폭(m) 상한 — 묶음 구역 안의 형상만 모은다. */
const BATCH_PAIRS = 1000;
const BATCH_SPAN = 120;
/** 풀어 둔 타일을 들고 있는 상한(모든 워커 합) — 이웃 묶음이 같은 타일을 다시 풀지 않게. */
const DECODED_BUDGET = 384 * 1024 * 1024;

/** 마지막 검사의 단계별 시간(ms, 워커 합)·횟수 — 점검용(window.__mirClashStats). */
export type MirClashStats = { pairs: number; workers: number; batches: number; decodes: number; reuse: number; tileMs: number; buildMs: number; narrowMs: number; totalMs: number };

/** 묶음을 돌릴 일꾼: 웹 워커 여러 개(코어 수 − 1, 최대 4), 못 쓰면 화면 스레드 하나. */
type Runner = { run: (job: ClashBatch) => Promise<BatchResult>; dispose: () => void };

function workerRunners(urls: Record<string, string>, count: number): Runner[] {
  const out: Runner[] = [];
  for (let k = 0; k < count; k++) {
    const worker = new Worker(new URL('./mirClash.worker.ts', import.meta.url), { type: 'module' });
    const waiting = new Map<number, { resolve: (r: BatchResult) => void; reject: (e: Error) => void }>();
    let seqNo = 0;
    const failAll = (e: Error) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
    worker.onmessage = (e: MessageEvent<{ type: 'done' | 'error'; id: number; hits?: Float64Array; stats?: BatchResult['stats']; message?: string }>) => {
      const m = e.data, w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.type === 'done') w.resolve({ hits: m.hits!, stats: m.stats! });
      else w.reject(new Error(m.message || '간섭 워커 오류'));
    };
    worker.onerror = (e) => { e.preventDefault(); failAll(new Error(e.message || '간섭 워커 오류')); };
    worker.postMessage({ type: 'init', urls, budget: Math.max(64 * 1024 * 1024, DECODED_BUDGET / count) });
    out.push({
      run: (job) => new Promise<BatchResult>((resolve, reject) => {
        const id = ++seqNo;
        waiting.set(id, { resolve, reject });
        worker.postMessage({ type: 'batch', id, job }, [job.a.buffer, job.b.buffer]);
      }),
      dispose: () => { failAll(new Error('중지')); worker.terminate(); },
    });
  }
  return out;
}

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

  const hits: ClashHit[] = [];
  const hitOf = (a: number, b: number, x: number, y: number, z: number, depth: number): ClashHit => ({
    id: `mirclash-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    a: element(a, meta(a)), b: element(b, meta(b)),
    point: { x, y, z }, depth,
  });

  // 일꾼: 웹 워커(병렬), 만들 수 없으면 화면 스레드에서 같은 함수로.
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  let runners: Runner[] = [];
  try { if (typeof Worker !== 'undefined') runners = workerRunners(urls, Math.max(1, Math.min(4, cores - 1))); } catch { runners = []; }
  if (!runners.length) {
    const store = new TileStore(urls, DECODED_BUDGET);
    runners = [{ run: (job) => runClashBatch(job, store, shouldCancel), dispose: () => store.clear() }];
  }
  const batchPairs = Math.max(64, Math.min(BATCH_PAIRS, Math.ceil(n / (runners.length * 6))));
  const stats: MirClashStats = { pairs: n, workers: runners.length, batches: 0, decodes: 0, reuse: 0, tileMs: 0, buildMs: 0, narrowMs: 0, totalMs: 0 };
  (globalThis as { __mirClashStats?: MirClashStats }).__mirClashStats = stats;

  // 묶음 경계: 주 방향으로 BATCH_SPAN m 안, batchPairs 쌍까지(겹침이 아주 긴 쌍은 혼자 한 묶음).
  const bounds: number[] = [0];
  for (let f = 0; f < n;) {
    let to = f + 1;
    const start = ov[order[f] * 6 + axis];
    while (to < n && to - f < batchPairs && ov[order[to] * 6 + 3 + axis] - start <= BATCH_SPAN) to++;
    bounds.push(to);
    f = to;
  }
  const batchCount = bounds.length - 1;
  const batchOf = (index: number): ClashBatch => {
    const from = bounds[index], to = bounds[index + 1];
    const region = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const a = new Int32Array(to - from), b = new Int32Array(to - from);
    const want = new Set<number>();
    for (let j = from; j < to; j++) {
      const i = order[j];
      for (let k = 0; k < 3; k++) { region[k] = Math.min(region[k], ov[i * 6 + k] - 1); region[k + 3] = Math.max(region[k + 3], ov[i * 6 + 3 + k] + 1); }
      a[j - from] = pairs.a[i]; b[j - from] = pairs.b[i];
      want.add(pairs.a[i]); want.add(pairs.b[i]);
    }
    // 구역과 만나는 잎 중 묶음 객체 상자와도 만나는 것.
    const near = tilesFor(leaves, [region], 0);
    const wantedBoxes = [...want].map(id => boxOf(boxes, id)).filter((x): x is Float32Array => !!x);
    return { a, b, region, tiles: tilesFor(near, wantedBoxes, 0.01).map(t => t.path), type, tolerance };
  };
  // 일꾼은 이웃 묶음 몇 개를 연달아 맡는다(풀어 둔 타일을 그 일꾼이 다시 씀).
  const chunk = Math.max(1, Math.min(8, Math.floor(batchCount / (runners.length * 4))));
  let nextChunk = 0;

  // 묶음 결과는 묶음 순서대로 합친다(병렬이어도 실행마다 같은 결과·같은 순서).
  const started = performance.now();
  const ready = new Map<number, Float64Array>();
  let merged = 0, done = 0, stop = false;
  const merge = () => {
    for (let r = ready.get(merged); r; r = ready.get(merged)) {
      ready.delete(merged++);
      for (let k = 0; k + 5 < r.length && hits.length < maxHits; k += 6) hits.push(hitOf(r[k], r[k + 1], r[k + 2], r[k + 3], r[k + 4], r[k + 5]));
      if (hits.length >= maxHits) stop = true;
    }
  };
  const eta = () => {
    const ms = performance.now() - started;
    if (done < 200 || ms < 3000) return '';
    const s = (ms / done) * (n - done) / 1000;
    return s > 90 ? ` · 남은 시간 약 ${Math.round(s / 60)}분` : ` · 남은 시간 약 ${Math.max(1, Math.round(s))}초`;
  };
  const report = () => onProgress?.(0.03 + (done / n) * 0.97,
    `간섭 검사 ${done.toLocaleString()}/${n.toLocaleString()}쌍 · ${hits.length.toLocaleString()}건${runners.length > 1 ? ` · 병렬 ${runners.length}` : ''}${eta()}`);
  report();
  // 중지·결과 상한: 돌고 있는 묶음을 기다리지 않고 바로 끝낸다(일꾼은 아래에서 종료).
  let halt: () => void = () => {};
  const halted = new Promise<null>(resolve => { halt = () => resolve(null); });
  const watch = setInterval(() => { if (stop || shouldCancel?.()) halt(); }, 200);
  try {
    await Promise.all(runners.map(async (runner) => {
      for (;;) {
        const c = nextChunk++;
        if (c * chunk >= batchCount) return;
        for (let index = c * chunk; index < Math.min(batchCount, (c + 1) * chunk); index++) {
          if (stop || shouldCancel?.()) return;
          const job = batchOf(index), size = job.a.length;
          const r = await Promise.race([runner.run(job), halted]);
          if (!r || stop || shouldCancel?.()) return;
          stats.batches++; stats.decodes += r.stats.decodes; stats.reuse += r.stats.reuse;
          stats.tileMs += r.stats.tileMs; stats.buildMs += r.stats.buildMs; stats.narrowMs += r.stats.narrowMs;
          stats.totalMs = performance.now() - started;
          ready.set(index, r.hits);
          done += size;
          merge();
          report();
          if (runners.length === 1) await yieldToUi();
        }
      }
    }));
  } finally {
    clearInterval(watch);
    halt();
    for (const r of runners) r.dispose();
  }
  onProgress?.(1, hits.length >= maxHits ? `결과가 ${maxHits.toLocaleString()}건에 닿아 멈췄습니다` : '완료');
  return hits;
}
