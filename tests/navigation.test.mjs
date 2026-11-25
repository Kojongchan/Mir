import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/viewer2/navigation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { roomSize, wheelStep, ROOM_W, ROOM_H, ROOM_REACH, ROOM_MIN, WHEEL_STOP } = mod;

/** A packed depth grid (rows bottom first) from a function of (column, row) → metres or null (nothing drawn). */
const grid = (depthAt, far = 1000) => {
  const out = new Uint8Array(ROOM_W * ROOM_H * 4);
  for (let r = 0; r < ROOM_H; r++) for (let c = 0; c < ROOM_W; c++) {
    const d = depthAt(c, r);
    if (d === null) continue;
    // three.js packDepthToRGBA of d / far
    let v = d / far;
    const k = (r * ROOM_W + c) * 4;
    for (let b = 0; b < 4; b++) { v *= 255; const byte = Math.min(255, Math.floor(v)); out[k + b] = byte; v -= byte; }
  }
  return out;
};

test('room size: a tunnel seen along its axis is as wide as its edges, the open air has none', () => {
  // Tunnel: the edges 4–8 m away, the far end (centre) 300 m.
  const tunnel = grid((c, r) => {
    const edge = Math.min(c, ROOM_W - 1 - c, r, ROOM_H - 1 - r);
    return edge < 3 ? 4 + edge + (r < 2 ? 2 : 0) : 300;
  });
  const room = roomSize(tunnel, 1000);
  assert.ok(room > 5 && room < 8, `tunnel room ${room}`);
  // Outdoors: the upper half is sky.
  const outdoors = grid((c, r) => (r >= ROOM_H / 2 ? null : 50 + r * 20));
  assert.equal(roomSize(outdoors, 1000), Infinity);
  // Looking down at the ground: every edge about the same distance — a room as big as the view, harmless.
  assert.ok(Math.abs(roomSize(grid(() => 120), 1000) - 120) < 0.5);
});

test('wheel step: steady steps in a room, never through the surface; outdoors 15.7% of the way as before', () => {
  const notch = Math.pow(0.95, 100 / 30); // a mouse notch off a Mac
  // Outdoors (no room): proportional to the way, in and out inverse.
  assert.ok(Math.abs(wheelStep(1000, Infinity, notch, true, true) - 157.2) < 0.5);
  const back = wheelStep(1000 - wheelStep(1000, Infinity, notch, true, true), Infinity, notch, false, true);
  assert.ok(Math.abs(back - wheelStep(1000, Infinity, notch, true, true)) < 1e-6, 'a notch out undoes a notch in');
  // A 10 m room: the far end of the tunnel 300 m or 40 m away gives the same step; a nearer wall less.
  const far = wheelStep(300, 10, notch, true, true), mid = wheelStep(40, 10, notch, true, true);
  assert.equal(far, mid);
  assert.ok(Math.abs(far - ROOM_REACH * 10 * (1 - notch)) < 1e-9);
  assert.ok(wheelStep(8, 10, notch, true, true) < far);
  // The floor 2 m ahead: at least ROOM_MIN of the room per notch, stopping WHEEL_STOP before it.
  let reach = 2;
  const steps = [];
  for (let k = 0; k < 8; k++) { const s = wheelStep(reach, 10, notch, true, true); steps.push(s); reach -= s; }
  assert.ok(Math.abs(steps[0] - ROOM_MIN * 10 * (1 - notch)) < 1e-9);
  assert.ok(Math.abs(reach - WHEEL_STOP) < 1e-9, `stopped ${reach} m from the floor`);
  assert.equal(steps.at(-1), 0);
  // A point over empty space (no surface) is no wall: the camera may pass it.
  assert.ok(wheelStep(0.2, 10, notch, true, false) > 0.2);
});
