/** Column-major projection * view. Keep world coordinates in double precision. */
export function viewPlanes(view: ArrayLike<number>, projection: ArrayLike<number>, padding = 0.2, front = false): number[][] {
  if (view.length !== 16 || projection.length !== 16 ||
      !Array.from(view).every(Number.isFinite) || !Array.from(projection).every(Number.isFinite)) return [];
  const m = Array.from({ length: 16 }, (_, n) => {
    const row = n % 4, col = Math.floor(n / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + projection[k * 4 + row] * view[col * 4 + k], 0);
  });
  // Side planes only: near/far clipping is the renderer's responsibility, including log depth.
  // Padding preloads the perimeter and keeps boundary geometry visible while orbiting.
  // `front` adds w >= 0: side planes alone accept a wide box just behind a perspective eye.
  return [0, 1].flatMap(row => [-1, 1].map(sign =>
    [0, 1, 2, 3].map(col => (1 + padding) * m[col * 4 + 3] + sign * m[col * 4 + row])))
    .concat(front ? [[0, 1, 2, 3].map(col => m[col * 4 + 3])] : []);
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

/** Loading-only priority by apparent size on screen (box diagonal / eye-to-box gap), like
 * screen-space error: a near structure at the screen edge outranks a distant one in the centre.
 * The side-plane frustum is unbounded in depth, so a centre-first band would queue every far tile
 * along the view axis ahead of the visible foreground. Centre and on-screen only weight the size.
 * Off-screen tiles follow by eye distance. Eye-to-box distance does not depend on the orbit pivot.
 * Keep every candidate, including long geometry crossing the frustum.
 */
export function prioritizeCameraView<T extends { worldAabb: number[] }>(tiles: T[], view: ArrayLike<number>, projection: ArrayLike<number>, eye: ArrayLike<number>): T[] {
  const padded = viewPlanes(view, projection, 0.2, true), screen = viewPlanes(view, projection, 0, true), center = viewPlanes(view, projection, -0.65, true);
  const finite = (box: number[]) => box.length === 6 && [...box, ...Array.from(eye)].every(Number.isFinite);
  const gap = (box: number[]) => finite(box)
    ? Math.hypot(...[0,1,2].map(i => Math.max(box[i] - eye[i], 0, eye[i] - box[i+3]))) : Infinity;
  const diagonal = (box: number[]) => finite(box) ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) : 0;
  return tiles.map((tile,index) => {
    const box = tile.worldAabb, distance = gap(box), size = diagonal(box);
    const weight = !inTileView(box, padded) ? 0 : inTileView(box, center) ? 2 : inTileView(box, screen) ? 1 : 0.25;
    // The size term keeps eye-containing tiles finite: they all share the top score.
    const apparent = weight && Number.isFinite(distance) ? weight * size / (distance + 0.1 * size + 1e-9) : 0;
    return { tile, index, visible: weight > 0, apparent, distance };
  }).sort((a,b) => Number(b.visible) - Number(a.visible) || b.apparent - a.apparent || a.distance - b.distance || a.index - b.index)
    .map(v=>v.tile);
}
