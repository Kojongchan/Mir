/**
 * Prefetch (user decision "A 먼저"): while the view rests, the files of the tiles around the camera — each tile's
 * original level, its simplified copies and the structure levels above them — are fetched into this browser's tile
 * cache (tileCache.ts) without being parsed, nearest first, so a move nearby loads them from the cache. A 550 m move in
 * a tunnel of the third viewer took 4.5 s from the network and 1.0 s from the cache (61 tiles, 1.3 s of it the
 * browser's own work). Terrain (aerial photos) is left to the viewer.
 */

/** A structure tile's file, with the tile's bounding sphere in the tileset frame. */
export type NearbyFile = { path: string; centre: [number, number, number]; radius: number };

type TileJson = { boundingVolume?: { box?: number[]; sphere?: number[] }; content?: { uri?: string }; children?: TileJson[] };

/**
 * Structure files of a tileset tree — originals `c/d<n>.glb`, copies `c/m<k>-<n>.glb` and the levels above them
 * `c/h<n>.glb` (a 250 m move missed 16 of them) — each with its tile's bounding sphere. Not the far files of tiles
 * without an original (`f`) or terrain (`t`, `g`).
 */
export function structureFiles(root: TileJson | null | undefined): NearbyFile[] {
  const out: NearbyFile[] = [];
  const stack: TileJson[] = root ? [root] : [];
  while (stack.length) {
    const t = stack.pop()!;
    for (const c of t.children ?? []) stack.push(c);
    const uri = t.content?.uri ?? '';
    if (!/^c\/(?:d\d+|m\d+-\d+|h\d+)\.glb$/.test(uri)) continue;
    const b = t.boundingVolume?.box, s = t.boundingVolume?.sphere;
    if (b && b.length >= 12) {
      out.push({ path: uri, centre: [b[0], b[1], b[2]], radius: Math.hypot(Math.hypot(b[3], b[4], b[5]), Math.hypot(b[6], b[7], b[8]), Math.hypot(b[9], b[10], b[11])) });
    } else if (s && s.length >= 4) out.push({ path: uri, centre: [s[0], s[1], s[2]], radius: s[3] });
  }
  return out;
}

/** Paths of the files whose tile comes within `reach` of point `p` (tileset frame), nearest first, leaving out `skip`. */
export function nearestFiles(files: readonly NearbyFile[], p: readonly number[], reach: number, skip: ReadonlySet<string>): string[] {
  const near: [string, number][] = [];
  for (const f of files) {
    if (skip.has(f.path)) continue;
    const gap = Math.hypot(f.centre[0] - p[0], f.centre[1] - p[1], f.centre[2] - p[2]) - f.radius;
    if (gap <= reach) near.push([f.path, gap]);
  }
  return near.sort((a, b) => a[1] - b[1]).map(([path]) => path);
}
