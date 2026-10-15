/**
 * Property shards kept in this browser (Cache Storage), shared by the property panel (useModelIndex) and the
 * property-value search worker: one cache per model, cleared when its index is rebuilt (the index generation is in the
 * signed tree URL: …/<model>/meta/runs/<gen>/tree.json). Signed URLs change every session, so the HTTP cache never hits.
 */
const MARKER = 'https://props-cache.mir.invalid/__gen';

/** Cache key of shard k. */
export const propsKey = (k: number) => `https://props-cache.mir.invalid/p/${k}`;

/** Cache name and index generation of a model, from its signed tree URL (null: not a model index URL). */
export function propsCacheOf(treeUrl: string): { name: string; gen: string } | null {
  const m = /\/([A-Za-z0-9]{1,40})\/meta\/(runs\/[A-Za-z0-9-]+)\/tree\.json(?:\?|$)/.exec(treeUrl);
  return m ? { name: `mir-props:${m[1]}`, gen: m[2] } : null;
}

/** Open the model's cache, emptied first if it holds another generation; null when storage is unavailable. */
export async function openPropsCache(treeUrl: string): Promise<Cache | null> {
  const of = propsCacheOf(treeUrl);
  if (!of || typeof caches === 'undefined') return null;
  try {
    let cache = await caches.open(of.name);
    const marker = await cache.match(MARKER);
    const current = marker && (await marker.text()) === of.gen;
    if (marker && !current) { await caches.delete(of.name); cache = await caches.open(of.name); }
    if (!current) await cache.put(MARKER, new Response(of.gen));
    return cache;
  } catch { return null; } // storage blocked (private mode, quota)
}
