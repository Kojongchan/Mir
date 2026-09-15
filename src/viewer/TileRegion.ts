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

/** Orbit keeps eye/look distance and region centre; pan/dolly eventually crosses this margin. */
export function regionNeedsRefresh(previous: { center: number[]; distance: number } | undefined, center: number[], distance: number): boolean {
  if (!previous) return true;
  const movement = Math.hypot(...center.map((n, i) => n - previous.center[i]));
  const margin = Math.min(200, Math.max(50, previous.distance * 0.15));
  return movement > margin || distance > previous.distance * 1.5 || distance < previous.distance / 1.5;
}

/** Keep the view target beyond the near clipping plane, including repeated wheel input. */
export function safeDollyFactor(distance: number, factor: number, near: number): number {
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(factor) || factor <= 0) return 1;
  const minimum = Math.max(2, near * 4);
  return factor < 1 ? Math.max(factor, minimum / distance) : factor;
}
