/**
 * Tiles kept in this browser across visits (Cache Storage), keyed by the tileset run and the file path. Signed URLs
 * change every session, so the HTTP cache never hits and every visit downloaded everything again; tile loading is
 * bound by request latency (many small files), not bandwidth. One cache per model: a new run replaces the old one.
 */
const MARKER = 'https://tile-cache.mir.invalid/__run';
const keyOf = (path: string) => `https://tile-cache.mir.invalid/${path}`;

/**
 * Model folder and run of a signed tileset URL (…/<model>/tiles3d/runs/<id>/tileset.json), or null. The third
 * viewer's trial tileset (…/tiles3d-svf/…) gets its own cache (`<model>-svf`), so switching viewers keeps both.
 */
export function runOf(tilesetUrl: string): { model: string; run: string } | null {
  const m = /\/([A-Za-z0-9]{1,40})\/tiles3d(-svf)?\/(runs\/[A-Za-z0-9-]+)\/tileset\.json(?:\?|$)/.exec(tilesetUrl);
  return m ? { model: m[1] + (m[2] ?? ''), run: m[3] } : null;
}

export type TileCacheStats = { hits: number; stored: number };

/**
 * A 3d-tiles-renderer plugin that answers tile downloads from the cache and stores what it fetches. `pathOf` maps a
 * request URL back to its path in the run (null: not a tile file, fetched as usual).
 */
export function tileCachePlugin(model: string, run: string, pathOf: (url: string) => string | null) {
  const stats: TileCacheStats = { hits: 0, stored: 0 };
  const ready: Promise<Cache | null> = (async () => {
    if (typeof caches === 'undefined') return null; // not a secure context
    try {
      const name = `mir-tiles:${model}`;
      let cache = await caches.open(name);
      const marker = await cache.match(MARKER);
      const current = marker && (await marker.text()) === run;
      if (marker && !current) { await caches.delete(name); cache = await caches.open(name); }
      if (!current) await cache.put(MARKER, new Response(run));
      return cache;
    } catch { return null; } // storage blocked (private mode, quota)
  })();
  return {
    name: 'MIR_TILE_CACHE',
    stats,
    async fetchData(url: string, options?: RequestInit): Promise<Response> {
      const path = pathOf(url);
      const cache = path ? await ready : null;
      if (!cache || !path) return fetch(url, options);
      const hit = await cache.match(keyOf(path)).catch(() => undefined);
      if (hit) { stats.hits++; return hit; }
      const res = await fetch(url, options);
      if (res.ok) cache.put(keyOf(path), res.clone()).then(() => { stats.stored++; }, () => {});
      return res;
    },
  };
}
