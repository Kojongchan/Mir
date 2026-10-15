/// <reference lib="webworker" />
// Property-value search off the main thread: loads every property shard once (≈8 MB for 250k objects),
// then answers searches from the in-memory index (src/viewer/PropSearchIndex.ts). Shards come from this browser's
// cache when the property panel already stored them, and what is downloaded here is stored for it.
import { PropSearchIndex, type Shard } from './PropSearchIndex';
import { propsKey } from './propsCache';

type Request = { type: 'search'; key: string; urls?: string[]; cacheName?: string | null; query: string; seq: number };
let index: PropSearchIndex | null = null;
let indexKey = '';
let loading: Promise<void> | null = null;

async function load(urls: string[], key: string, cacheName: string | null | undefined) {
  const cache = cacheName && typeof caches !== 'undefined' ? await caches.open(cacheName).catch(() => null) : null;
  const next = new PropSearchIndex();
  let done = 0, k = 0;
  const worker = async () => {
    for (let i = k++; i < urls.length; i = k++) {
      let r = cache ? await cache.match(propsKey(i)).catch(() => undefined) : undefined;
      if (!r) {
        r = await fetch(urls[i]);
        if (r.ok && cache) cache.put(propsKey(i), r.clone()).catch(() => {});
      }
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
  const { key, urls, cacheName, query, seq } = e.data;
  try {
    if (indexKey !== key || !index) {
      if (!urls) { postMessage({ type: 'need-urls', seq }); return; }
      loading ??= load(urls, key, cacheName).finally(() => { loading = null; });
      await loading;
    }
    postMessage({ type: 'result', seq, ids: index!.search(query), objects: index!.size });
  } catch (err) {
    postMessage({ type: 'error', seq, message: (err as Error).message });
  }
};
