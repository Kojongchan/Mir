/**
 * Tiles kept in this browser across visits (Cache Storage). Signed URLs change every session, so the HTTP cache never
 * hits and every visit downloaded everything again; tile loading is bound by request latency (many small files), not
 * bandwidth. A tile file stored by its content (…/files/<SHA-256>.glb, scripts/build-tiles3d.mjs current.json v2) is
 * kept under its hash, so a new build's unchanged tiles stay; other files under their run and path. One cache per model
 * and viewer: entries the open run does not list are removed in the background.
 */
const BASE = 'https://tile-cache.mir.invalid/';
const HASHED = /\/files\/([0-9a-f]{64})\.glb(?:\?|$)/;

/** The cache key of a run's file (`url`: its signed URL, which names a stored file's hash). */
export function cacheKeyOf(run: string, path: string, url: string | undefined): string {
  const m = url ? HASHED.exec(url) : null;
  return m ? `${BASE}h/${m[1]}` : `${BASE}r/${run}/${path}`;
}

/**
 * Model folder and run of a signed tileset URL (…/<model>/tiles3d/runs/<id>/tileset.json), or null. The third
 * viewer's trial tileset (…/tiles3d-svf/…) gets its own cache (`<model>-svf`), so switching viewers keeps both.
 */
export function runOf(tilesetUrl: string): { model: string; run: string } | null {
  const m = /\/([A-Za-z0-9]{1,40})\/tiles3d(-svf)?\/(runs\/[A-Za-z0-9-]+)\/tileset\.json(?:\?|$)/.exec(tilesetUrl);
  return m ? { model: m[1] + (m[2] ?? ''), run: m[3] } : null;
}

export type TileCacheStats = { hits: number; stored: number; prefetched: number; prefetchedBytes: number; pruned: number };

/**
 * A 3d-tiles-renderer plugin that answers tile downloads from the cache and stores what it fetches. `urls`: the run's
 * files (path → signed URL; renewed URLs keep their paths and hashes); `pathOf` maps a request URL back to its path
 * (null: not a tile file, fetched as usual).
 */
export function tileCachePlugin(model: string, run: string, urls: Record<string, string>, pathOf: (url: string) => string | null) {
  const stats: TileCacheStats = { hits: 0, stored: 0, prefetched: 0, prefetchedBytes: 0, pruned: 0 };
  const keyOf = (path: string, url = urls[path]) => cacheKeyOf(run, path, url);
  const ready: Promise<Cache | null> = (async () => {
    if (typeof caches === 'undefined') return null; // not a secure context
    try { return await caches.open(`mir-tiles:${model}`); } catch { return null; } // storage blocked (private mode, quota)
  })();
  // Entries of other runs (a file a newer build changed, or an older cache's layout), once the tiles have started.
  void ready.then(cache => new Promise<Cache | null>(res => setTimeout(() => res(cache), 5000))).then(async cache => {
    if (!cache) return;
    try {
      const wanted = new Set(Object.entries(urls).map(([path, url]) => keyOf(path, url)));
      for (const request of await cache.keys()) {
        if (wanted.has(request.url)) continue;
        if (await cache.delete(request)) stats.pruned++;
      }
    } catch { /* storage went away: the next visit prunes */ }
  });
  return {
    name: 'MIR_TILE_CACHE',
    stats,
    async fetchData(url: string, options?: RequestInit): Promise<Response> {
      const path = pathOf(url);
      const cache = path ? await ready : null;
      if (!cache || !path) return fetch(url, options);
      const key = keyOf(path, url);
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) { stats.hits++; return hit; }
      const res = await fetch(url, options);
      if (res.ok) cache.put(key, res.clone()).then(() => { stats.stored++; }, () => {});
      return res;
    },
    /** Whether a file of this run is in the cache (false when the cache is unavailable). */
    async has(path: string): Promise<boolean> {
      const cache = await ready;
      return !!cache && !!(await cache.match(keyOf(path)).catch(() => undefined));
    },
    /** Fetch a file into the cache without parsing it (prefetch.ts); its size in bytes, 0 when not stored. */
    async store(path: string, url: string, signal?: AbortSignal): Promise<number> {
      const cache = await ready;
      if (!cache) return 0;
      const res = await fetch(url, { signal });
      if (!res.ok) return 0;
      const body = await res.arrayBuffer();
      await cache.put(keyOf(path, url), new Response(body, { headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' } }));
      stats.prefetched++; stats.prefetchedBytes += body.byteLength;
      return body.byteLength;
    },
  };
}
