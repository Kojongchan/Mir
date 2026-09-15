type RegionTile = { cx: number; cy: number; cz: number; r: number };

/** Rank a region independently from the camera animation. Never mutates the manifest. */
export function rankTileRegion<T extends RegionTile>(tiles: T[], center: number[], radius: number, nearestFallback = false): T[] {
  const distance = (t: T, c: number[]) => Math.hypot(t.cx - c[0], t.cy - c[1], t.cz - c[2]);
  const valid = tiles.filter(t => [t.cx, t.cy, t.cz, t.r].every(Number.isFinite) && t.r >= 0);
  const region = (c: number[]) => valid.filter(t => distance(t, c) - t.r < radius)
    .sort((a, b) => distance(a, c) - distance(b, c));
  if (center.length !== 3 || !center.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0) return [];
  const candidates = region(center);
  if (candidates.length || !nearestFallback || !valid.length) return candidates;
  const nearest = valid.reduce((a, b) => distance(a, center) - a.r <= distance(b, center) - b.r ? a : b);
  return region([nearest.cx, nearest.cy, nearest.cz]);
}
