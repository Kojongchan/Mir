/**
 * Moving through the model in rooms (tunnels, buildings): how far the surroundings are and how far a wheel notch goes.
 * Pure functions (tests/navigation.test.mjs); TilesViewer reads the depths and moves the camera.
 */

/** Depth / far packed by the pick material (three.js packDepthToRGBA) at byte `at`. */
export const unpackDepth = (rgba: ArrayLike<number>, at: number) =>
  rgba[at] / 255 + rgba[at + 1] / 65025 + rgba[at + 2] / 16581375 + rgba[at + 3] / 4228250625;

/**
 * Room size (TilesViewer.sampleRoom): the view's depth on a ROOM_W × ROOM_H grid, read at rest. Inside a tunnel every
 * screen edge shows a wall, floor or ceiling a few metres away; outdoors at least one edge shows sky or the far ground.
 */
export const ROOM_W = 32, ROOM_H = 18;
/**
 * Wheel in a room (user report "터널 안 움직임이 부자연스럽고 느림"): a notch goes 15.7% of the way to the surface under
 * the cursor, as outdoors, but that way counts at most ROOM_REACH and at least ROOM_MIN room sizes — pointing down a
 * tunnel took 2–25 m per notch by where the cursor met the far end, pointing at the floor 0.58 → 0.29 m and ever less —
 * and a notch stops WHEEL_STOP m before that surface. A drag rotates about a point at most PIVOT_REACH room sizes away
 * (about the tunnel's far end, 51 m ahead, the eye swung 77 m through the walls). Measured in that tunnel (room 9.9 m):
 * 3.1 m per notch down the tunnel at ROOM_REACH 2, 0.62 m toward the floor until 0.3 m above it, a 200 px drag moved the
 * eye 7.4 m about a point 4.9 m ahead; outdoors (room Infinity) as before.
 */
export const ROOM_REACH = 1.5, ROOM_MIN = 0.4, WHEEL_STOP = 0.3, PIVOT_REACH = 0.3;

/**
 * How far the surroundings are (m) from a room grid of packed depths (rows bottom first): the largest of the median
 * depths along the four screen edges; Infinity when an edge shows mostly nothing (sky: outdoors, no room).
 */
export function roomSize(rgba: ArrayLike<number>, far: number, width = ROOM_W, height = ROOM_H): number {
  const depth = (c: number, r: number) => {
    const k = (r * width + c) * 4;
    return rgba[k] || rgba[k + 1] || rgba[k + 2] || rgba[k + 3] ? unpackDepth(rgba, k) * far : Infinity;
  };
  const median = (cells: [number, number][]) => cells.map(([c, r]) => depth(c, r)).sort((a, b) => a - b)[cells.length >> 1];
  const rows = (r0: number) => Array.from({ length: 2 * width }, (_, k): [number, number] => [k % width, r0 + (k >= width ? 1 : 0)]);
  const cols = (c0: number) => Array.from({ length: 2 * height }, (_, k): [number, number] => [c0 + (k >= height ? 1 : 0), k % height]);
  return Math.max(median(rows(0)), median(rows(height - 2)), median(cols(0)), median(cols(width - 2)));
}

/**
 * Metres one wheel event moves the camera along the cursor's ray: `reach` m to the point the gesture moves toward,
 * `room` the room size (Infinity outdoors), `scale` camera-controls' dolly factor for the event (0.95 per unit: 0.843 a
 * mouse notch), `surface`: that point is on a surface (a notch stops WHEEL_STOP m before it). Out is the inverse of in.
 */
export function wheelStep(reach: number, room: number, scale: number, forward: boolean, surface: boolean): number {
  const way = Number.isFinite(room) ? Math.min(Math.max(reach, ROOM_MIN * room), ROOM_REACH * room) : reach;
  if (!forward) return way * (1 / scale - 1);
  const step = way * (1 - scale);
  return surface ? Math.min(step, Math.max(0, reach - WHEEL_STOP)) : step;
}
