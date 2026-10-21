import { Vector3 } from 'three';

/**
 * Walk mode (user requests: "나비스웍스 중력 기능 참고 … WASD", "보행모드는 별도의 기능", "건설 캐릭터 … 스페이스바는
 * 점프 … 키는 대한민국 평균 남성 키"): a person of `height` m (STATURE: Korean men's mean, 8th Size Korea survey
 * 2021) whose eye is EYE_RATIO of it above the floor, moved with the keys, turned with the mouse. Gravity keeps the feet
 * on the floor below — up and down steps of at most STEP_HEIGHT, a fall past that, a jump of JUMP_HEIGHT — and visible
 * objects stop the body RADIUS m before them (it slides along a wall, the head stops HEAD_CLEARANCE under a ceiling); hidden objects
 * are passed through. The scene is only read through `Cast` (TilesViewer casts rays against the loaded tiles), so these
 * functions are tested on their own (tests/walk.test.mjs).
 */
export const STATURE = 1.725, MIN_STATURE = 1.4, MAX_STATURE = 2.0;
/** Eye height over stature (anthropometric tables: about 0.936). */
export const EYE_RATIO = 0.936;
export const eyeHeight = (w: { height: number }) => w.height * EYE_RATIO;
/** Stairs, kerbs and rails are climbed; a higher ledge is a wall (or a jump). */
export const STEP_HEIGHT = 0.45;
export const RADIUS = 0.3;
/** Room kept over the head under a ceiling. */
export const HEAD_CLEARANCE = 0.05;
export const GRAVITY = 9.8, MAX_FALL = 50;
export const JUMP_HEIGHT = 0.5, JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** Floors searched this far below the feet; none (outside the model): the person stays at that height. */
export const FLOOR_SEARCH = 500;
/** Walking speed at the start (m/s); Shift runs RUN_FACTOR times faster; the wheel changes it by SPEED_STEP. */
export const WALK_SPEED = 2, RUN_FACTOR = 3, SPEED_STEP = 1.25, MIN_SPEED = 0.25, MAX_SPEED = 100;

/** First surface along a ray: distance and the surface's unit normal (world), or null. */
export type Hit = { distance: number; normal: Vector3 };
export type Cast = (origin: Vector3, dir: Vector3, far: number) => Hit | null;
export type Walker = { feet: Vector3; vy: number; grounded: boolean; gravity: boolean; collide: boolean; height: number };

const UP = new Vector3(0, 1, 0), DOWN = new Vector3(0, -1, 0);

/** Height (y) of the floor under `feet` — looked for from STEP_HEIGHT above them, so a step up is found — or null. */
export function floorUnder(feet: Vector3, cast: Cast, below = FLOOR_SEARCH): number | null {
  const origin = feet.clone().addScaledVector(UP, STEP_HEIGHT + 0.05);
  const hit = cast(origin, DOWN, below + STEP_HEIGHT + 0.05);
  return hit ? origin.y - hit.distance : null;
}

/** Move the feet horizontally by `move` (its y is ignored), stopping RADIUS m before walls and sliding along them. */
export function slide(w: Walker, move: Vector3, cast: Cast): void {
  const rest = new Vector3(move.x, 0, move.z);
  if (!w.collide) { w.feet.add(rest); return; }
  // Rays that stop a step: just over a climbable ledge, the waist, the eyes.
  const body = [STEP_HEIGHT + 0.05, w.height * 0.55, eyeHeight(w) - 0.05];
  for (let round = 0; round < 3; round++) {
    const length = rest.length();
    if (length < 1e-6) return;
    const dir = rest.clone().divideScalar(length);
    let allowed = length, wall: Vector3 | null = null;
    for (const height of body) {
      const hit = cast(w.feet.clone().addScaledVector(UP, height), dir, length + RADIUS / 0.3);
      if (!hit) continue;
      // RADIUS kept square to the wall: along the ray that is RADIUS / cos (a wall met at 45° is 0.42 m away).
      const keep = hit.distance - RADIUS / Math.max(Math.abs(hit.normal.dot(dir)), 0.3);
      if (keep < allowed) { allowed = Math.max(0, keep); wall = hit.normal; }
    }
    w.feet.addScaledVector(dir, allowed);
    if (!wall) return;
    // The rest of the way along the wall: without its part into the wall (the normal laid flat, facing the walker).
    const n = new Vector3(wall.x, 0, wall.z);
    if (n.lengthSq() < 1e-8) return;
    n.normalize();
    if (n.dot(dir) > 0) n.negate();
    rest.copy(dir).multiplyScalar(length - allowed);
    rest.addScaledVector(n, -rest.dot(n));
  }
}

/** Room above the head (m) up to `far`: the head stops HEAD_CLEARANCE under a ceiling. */
function headroom(w: Walker, far: number, cast: Cast): number {
  if (!w.collide) return far;
  const hit = cast(w.feet.clone().addScaledVector(UP, w.height), UP, far + HEAD_CLEARANCE);
  return hit ? Math.max(0, Math.min(far, hit.distance - HEAD_CLEARANCE)) : far;
}

/** Move up (`rise` > 0) or down, with gravity off: the head stops under a ceiling, the feet on a floor. */
export function fly(w: Walker, rise: number, cast: Cast): void {
  if (!rise) return;
  if (!w.collide) { w.feet.y += rise; return; }
  if (rise > 0) { w.feet.y += headroom(w, rise, cast); return; }
  const floor = floorUnder(w.feet, cast, -rise);
  w.feet.y = floor === null ? w.feet.y + rise : Math.max(w.feet.y + rise, Math.min(w.feet.y, floor));
}

/**
 * One frame of `dt` s: the horizontal move, then height — with gravity the feet follow the floor up and down by
 * STEP_HEIGHT, `jump` leaves the floor at JUMP_SPEED, and past a larger drop the person falls (GRAVITY, at most
 * MAX_FALL m/s) until landing; without gravity `rise` m up or down.
 */
export function stepWalker(w: Walker, move: Vector3, rise: number, dt: number, cast: Cast, jump = false): void {
  slide(w, move, cast);
  if (!w.gravity) { w.vy = 0; w.grounded = false; fly(w, rise, cast); return; }
  if (jump && w.grounded) { w.vy = JUMP_SPEED; w.grounded = false; }
  const floor = floorUnder(w.feet, cast);
  if (floor === null && w.vy <= 0) { w.vy = 0; w.grounded = false; return; } // nothing below: the person stays
  if (w.grounded && floor !== null && floor >= w.feet.y - STEP_HEIGHT) { w.feet.y = floor; w.vy = 0; return; }
  w.grounded = false;
  w.vy = Math.max(w.vy - GRAVITY * dt, -MAX_FALL);
  let dy = w.vy * dt;
  if (dy > 0) { const room = headroom(w, dy, cast); if (room < dy) { dy = room; w.vy = 0; } } // a ceiling stops the jump
  const y = w.feet.y + dy;
  if (floor !== null && y <= floor) { w.feet.y = floor; w.vy = 0; w.grounded = true; } else w.feet.y = y;
}

/**
 * Keys held (KeyboardEvent.code) → the walk direction in the view's own frame: x right, z back; up/down (Q/E, gravity
 * off), Shift runs, Space jumps (gravity on) or rises (off).
 */
export function keysToMove(keys: ReadonlySet<string>): { right: number; back: number; up: number; run: boolean; jump: boolean } {
  const on = (...codes: string[]) => (codes.some(c => keys.has(c)) ? 1 : 0);
  return {
    right: on('KeyD', 'ArrowRight') - on('KeyA', 'ArrowLeft'),
    back: on('KeyS', 'ArrowDown') - on('KeyW', 'ArrowUp'),
    up: on('KeyE', 'Space') - on('KeyQ', 'KeyC'),
    run: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    jump: keys.has('Space'),
  };
}
