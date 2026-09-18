type RegionTile = { cx: number; cy: number; cz: number; r: number; worldAabb?: number[] };

/** Rank a region independently from the camera animation. Never mutates the manifest. */
export function rankTileRegion<T extends RegionTile>(tiles: T[], center: number[], radius: number, nearestFallback = false): T[] {
  const distance = (t: T, c: number[]) => Math.hypot(t.cx - c[0], t.cy - c[1], t.cz - c[2]);
  const valid = tiles.filter(t => [t.cx, t.cy, t.cz, t.r].every(Number.isFinite) && t.r >= 0 &&
    (!t.worldAabb || (t.worldAabb.length === 6 && t.worldAabb.every(Number.isFinite) &&
      [0, 1, 2].every(i => t.worldAabb![i] <= t.worldAabb![i + 3]))));
  // A long bridge can intersect the focus while its centre is hundreds of metres away.
  // Its bounding sphere also includes large empty areas alongside it. Use box distance
  // for both eligibility and priority, keeping centre distance only as a stable tie-break.
  const gap = (t: T, c: number[]) => t.worldAabb
    ? Math.hypot(...c.map((v, i) => Math.max(t.worldAabb![i] - v, 0, v - t.worldAabb![i + 3])))
    : Math.max(0, distance(t, c) - t.r);
  const region = (c: number[]) => valid.map(tile => ({ tile, gap: gap(tile, c), distance: distance(tile, c) }))
    .filter(t => t.gap < radius)
    .sort((a, b) => a.gap - b.gap || a.distance - b.distance)
    .map(t => t.tile);
  if (center.length !== 3 || !center.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0) return [];
  const candidates = region(center);
  if (candidates.length || !nearestFallback || !valid.length) return candidates;
  const nearest = valid.reduce((a, b) => gap(a, center) <= gap(b, center) ? a : b);
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
