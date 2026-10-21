import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/viewer2/walk.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', 'require', code)(mod, m => (m === 'three' ? THREE : null));
const { stepWalker, slide, fly, floorUnder, keysToMove, eyeHeight, STATURE, STEP_HEIGHT, RADIUS, HEAD_CLEARANCE, JUMP_HEIGHT } = mod;
const { Vector3 } = THREE;

/** A world of boxes [minX, minY, minZ, maxX, maxY, maxZ] (Y up): the first box face a ray meets, with its normal. */
const world = boxes => (origin, dir, far) => {
  let best = null;
  for (const b of boxes) {
    let t0 = -Infinity, t1 = Infinity, axis = -1, sign = 0;
    let miss = false;
    for (let a = 0; a < 3; a++) {
      const o = origin.getComponent(a), d = dir.getComponent(a), lo = b[a], hi = b[a + 3];
      if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) { miss = true; break; } continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d, s = -1;
      if (ta > tb) { [ta, tb] = [tb, ta]; s = 1; }
      if (ta > t0) { t0 = ta; axis = a; sign = s; }
      t1 = Math.min(t1, tb);
    }
    if (miss || t0 > t1 || t0 < 0 || t0 > far || axis < 0) continue;
    if (!best || t0 < best.distance) {
      const normal = new Vector3(); normal.setComponent(axis, sign);
      best = { distance: t0, normal };
    }
  }
  return best;
};
const walker = (x, y, z, height = STATURE) => ({ feet: new Vector3(x, y, z), vy: 0, grounded: true, gravity: true, collide: true, height });
const walk = (w, cast, move, frames, dt = 1 / 60) => { for (let k = 0; k < frames; k++) stepWalker(w, move.clone().multiplyScalar(dt), 0, dt, cast); };

// Floor at y 0 from x −20 to 10; a step 0.3 m high from 10 to 15; a wall 1.2 m high from 30; a pit 5 m deep from −20 to −10.
const site = world([
  [-10, -1, -10, 10, 0, 10],
  [10, -1, -10, 15, 0.3, 10],
  [15, -1, -10, 30, 0, 10],
  [30, -1, -10, 31, 1.2, 10],
  [-20, -6, -10, -10, -5, 10],
]);

test('walking follows the floor and climbs a step', () => {
  const w = walker(0, 0, 0);
  walk(w, site, new Vector3(2, 0, 0), 60);                 // 2 m in a second
  assert.ok(Math.abs(w.feet.x - 2) < 1e-6 && Math.abs(w.feet.y) < 1e-9);
  walk(w, site, new Vector3(2, 0, 0), 5 * 60);             // onto the step at x 10
  assert.ok(w.feet.x > 10 && w.feet.x < 15, `x ${w.feet.x}`);
  assert.ok(Math.abs(w.feet.y - 0.3) < 1e-9, `on the step, y ${w.feet.y}`);
  assert.ok(STEP_HEIGHT >= 0.3);
});

test('a wall higher than a step stops the body RADIUS before it; a pit is fallen into with gravity', () => {
  const w = walker(25, 0, 0);
  walk(w, site, new Vector3(4, 0, 0), 3 * 60);
  assert.ok(Math.abs(w.feet.x - (30 - RADIUS)) < 1e-6, `stopped at ${w.feet.x}`);
  const p = walker(-9, 0, 0);
  walk(p, site, new Vector3(-2, 0, 0), 45);                // over the edge at x −10
  assert.ok(p.feet.x < -10 && p.feet.y < 0 && p.feet.y > -5, `falling, y ${p.feet.y}`);
  walk(p, site, new Vector3(0, 0, 0), 120);
  assert.ok(Math.abs(p.feet.y + 5) < 1e-9 && p.grounded, `landed, y ${p.feet.y}`);
});

test('the body slides along a wall it meets at an angle', () => {
  const w = walker(28, 0, 0);
  slide(w, new Vector3(2, 0, 2), site);                    // 45° into the wall at x 30
  assert.ok(Math.abs(w.feet.x - (30 - RADIUS)) < 1e-6);
  assert.ok(w.feet.z > 1.5, `slid along the wall to z ${w.feet.z}`);
});

test('no floor below: the person stays; gravity off: up to a ceiling and down to the floor', () => {
  const lost = walker(100, 3, 100);
  walk(lost, site, new Vector3(0, 0, 0), 30);
  assert.equal(lost.feet.y, 3);
  const roofed = world([[-10, -1, -10, 10, 0, 10], [-10, 3, -10, 10, 4, 10]]);
  const f = { ...walker(0, 0, 0), gravity: false };
  fly(f, 5, roofed);
  assert.ok(Math.abs(f.feet.y + f.height - (3 - HEAD_CLEARANCE)) < 1e-9, `head under the ceiling, feet ${f.feet.y}`);
  fly(f, -5, roofed);
  assert.equal(f.feet.y, 0);
  assert.equal(floorUnder(new Vector3(0, 0.2, 0), roofed), 0);
});

test('keys: WASD and arrows, Q/E up and down, Shift runs, Space jumps', () => {
  assert.deepEqual(keysToMove(new Set(['KeyW', 'KeyD', 'ShiftLeft'])), { right: 1, back: -1, up: 0, run: true, jump: false });
  assert.deepEqual(keysToMove(new Set(['ArrowDown', 'KeyQ'])), { right: 0, back: 1, up: -1, run: false, jump: false });
  assert.equal(keysToMove(new Set(['Space'])).jump, true);
});

test('Space jumps JUMP_HEIGHT and lands; a low ceiling stops the head; the eye follows the height', () => {
  const w = walker(0, 0, 0), dt = 1 / 120;
  let top = 0;
  stepWalker(w, new Vector3(), 0, dt, site, true);
  for (let k = 0; k < 240; k++) { stepWalker(w, new Vector3(), 0, dt, site); top = Math.max(top, w.feet.y); }
  assert.ok(Math.abs(top - JUMP_HEIGHT) < 0.03, `jumped ${top} m`);
  assert.ok(w.grounded && w.feet.y === 0, 'landed');
  const low = world([[-10, -1, -10, 10, 0, 10], [-10, 2.0, -10, 10, 3, 10]]);
  const u = walker(0, 0, 0);
  stepWalker(u, new Vector3(), 0, dt, low, true);
  let head = 0;
  for (let k = 0; k < 240; k++) { stepWalker(u, new Vector3(), 0, dt, low); head = Math.max(head, u.feet.y + u.height); }
  assert.ok(Math.abs(head - (2.0 - HEAD_CLEARANCE)) < 1e-9, `head stopped at ${head} under the ceiling at 2 m`);
  assert.ok(u.grounded && u.feet.y === 0, 'and came down');
  assert.ok(Math.abs(eyeHeight(walker(0, 0, 0)) - 1.6146) < 1e-3 && Math.abs(eyeHeight(walker(0, 0, 0, 1.9)) - 1.7784) < 1e-3);
});
