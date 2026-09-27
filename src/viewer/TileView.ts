/** Column-major projection * view. Keep world coordinates in double precision. */
export function viewPlanes(view: ArrayLike<number>, projection: ArrayLike<number>, padding = 0.2): number[][] {
  if (view.length !== 16 || projection.length !== 16 ||
      !Array.from(view).every(Number.isFinite) || !Array.from(projection).every(Number.isFinite)) return [];
  const m = Array.from({ length: 16 }, (_, n) => {
    const row = n % 4, col = Math.floor(n / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + projection[k * 4 + row] * view[col * 4 + k], 0);
  });
  // Side planes only: near/far clipping is the renderer's responsibility, including log depth.
  // Padding preloads the perimeter and keeps boundary geometry visible while orbiting.
  return [0, 1].flatMap(row => [-1, 1].map(sign =>
    [0, 1, 2, 3].map(col => (1 + padding) * m[col * 4 + 3] + sign * m[col * 4 + row])));
}

/** Conservative AABB test. Missing, inverted or nonfinite bounds must fail open. */
export function inTileView(box: ArrayLike<number>, planes: number[][]): boolean {
  if (box.length !== 6 || !Array.from(box).every(Number.isFinite) ||
      [0, 1, 2].some(i => box[i] > box[i + 3])) return true;
  return !planes.some(p => {
    const values = [0, 1, 2].map(i => p[i] * box[p[i] >= 0 ? i + 3 : i]);
    const epsilon = 1e-7 * Math.max(1, Math.abs(p[3]), ...values.map(Math.abs));
    return values.reduce((sum, v) => sum + v, p[3]) < -epsilon;
  });
}

/** Reorders every candidate; never filters membership, destroys geometry or cancels downloads. */
export function prioritizeTileView<T extends { worldAabb: number[] }>(tiles: T[], planes: number[][], look: ArrayLike<number>): T[] {
  return tiles.map((tile, index) => ({ tile, index, visible: inTileView(tile.worldAabb, planes),
    gap: Math.hypot(...[0, 1, 2].map(i => Math.max(tile.worldAabb[i] - look[i], 0, look[i] - tile.worldAabb[i + 3]))) }))
    .sort((a, b) => Number(b.visible) - Number(a.visible) || a.gap - b.gap || a.index - b.index)
    .map(x => x.tile);
}
