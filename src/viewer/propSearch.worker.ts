/// <reference lib="webworker" />
// Property-value search off the main thread: loads every property shard once (≈8 MB for 250k objects),
// then answers searches from the in-memory index (src/viewer/PropSearchIndex.ts).
import { PropSearchIndex, type Shard } from './PropSearchIndex';

type Request = { type: 'search'; key: string; urls?: string[]; query: string; seq: number };
let index: PropSearchIndex | null = null;
let indexKey = '';
let loading: Promise<void> | null = null;

async function load(urls: string[], key: string) {
  const next = new PropSearchIndex();
  let done = 0;
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const r = await fetch(url);
      if (r.ok) next.addShard(await r.json() as Shard);
      else if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
      done++;
      if (done % 10 === 0 || done === urls.length) postMessage({ type: 'progress', done, total: urls.length });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  next.seal();
  index = next; indexKey = key;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { key, urls, query, seq } = e.data;
  try {
    if (indexKey !== key || !index) {
      if (!urls) { postMessage({ type: 'need-urls', seq }); return; }
      loading ??= load(urls, key).finally(() => { loading = null; });
      await loading;
    }
    postMessage({ type: 'result', seq, ids: index!.search(query), objects: index!.size });
  } catch (err) {
    postMessage({ type: 'error', seq, message: (err as Error).message });
  }
};
