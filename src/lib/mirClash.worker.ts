/// <reference lib="webworker" />
// 자체 엔진 간섭 검출의 협역 묶음을 화면 스레드 밖에서(여러 개 병렬) 돈다 — mirClash.ts 가 묶음을 나눠 보낸다.
// 풀어 둔 타일은 워커마다 예산 안에서 들고 있어 이웃 묶음이 재사용한다.
import { runClashBatch, TileStore, type ClashBatch } from './mirClashBatch';

type Request =
  | { type: 'init'; urls: Record<string, string>; budget: number }
  | { type: 'batch'; id: number; job: ClashBatch };

let store: TileStore | null = null;

self.onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === 'init') { store = new TileStore(m.urls, m.budget); return; }
  try {
    if (!store) throw new Error('간섭 워커가 준비되지 않았습니다');
    const r = await runClashBatch(m.job, store);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'done', id: m.id, hits: r.hits, stats: r.stats }, [r.hits.buffer]);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
