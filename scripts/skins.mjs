// Contained skins (build-tiles3d.mjs, third viewer): faces of an object lying on the skin of another object that holds
// it, drawn behind that skin. The tunnels' excavation (a solid) holds the shotcrete and lining, modelled twice (per
// piece and as long sweeps tessellated in 5 m chords): their outer faces weave up to 25 cm in and out of the
// excavation's, and the nearer one changed every few metres — contour lines over the inclined tunnel (user report
// "경사터널 … 겹치면서", PI-1_굴착). Each triangle of a tile's opaque objects gets the object whose skin hides it (0:
// none); the viewer draws it SKIN_PUSH m deeper while that object is shown (objectState.ts).
//   containedSkins  per triangle the hiding object, per vertex whether it lies on a skin shared with another object
//   applySkins      the group with a `skin` value per vertex (vertices split where a pushed and a plain face meet)
import os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * Rule (measured over the inclined tunnel PI-1: 46 tiles, 189 objects): another object's face within SKIN_REACH m,
 * parallel (|cos| ≥ PARALLEL) and straight across; both bodies on the same side of the two faces (the shotcrete's
 * outer face and the excavation's, not two faces touching back to back); A the outer one — THICKER times as thick
 * there (excavation 9–12 m, shotcrete 5–9 cm, lining 34 cm), or the finer of two of a thickness (a sweep's triangles
 * COARSER times a piece's) over SHARE of B's skin facing A; and the bodies overlap there by DEPTH of the thinner one's
 * thickness on average. Over the 46 tiles around PI-1 the shotcrete and lining in the excavation overlap it by 38–100%
 * (weaving in and out); layers lying on one another (shotcrete on the lining, lining on lining, a 9 cm finish on the
 * 31 cm wall of the emergency turning bay — pushed by a 50% share of "A's skin within B's thickness", which a layer
 * lying on another meets by rounding: patches of the wall showed through, run 222) by 0–19%, and stay in front; so
 * does a finish panel 10 cm in front of a wall.
 */
export const SKIN_REACH = 0.25, PARALLEL = 0.985, THICKER = 1.5, COARSER = 2, SHARE = 0.5, DEPTH = 0.25;

let pool = null;
const pending = new Map();
let nextJob = 0, turn = 0;
const busy = new Map();
function hold(w, delta) {
  const n = (busy.get(w) ?? 0) + delta;
  busy.set(w, n);
  if (n > 0) w.ref(); else w.unref();
}
function workers() {
  if (pool) return pool;
  const size = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) || 1));
  pool = Array.from({ length: size }, () => {
    const w = new Worker(new URL('./skins-worker.mjs', import.meta.url));
    w.on('message', ({ job, partner, shared, pairs }) => { const p = pending.get(job); pending.delete(job); hold(w, -1); p?.resolve({ partner, shared, pairs }); });
    w.on('error', e => { for (const [job, p] of pending) if (p.worker === w) { pending.delete(job); hold(w, -1); p.reject(e); } });
    w.unref();
    return w;
  });
  return pool;
}

/**
 * A tile's opaque group ({ pos, ids, idx }, positions in the tileset frame) and the other objects near it (same form,
 * from the model's source; objects of the group left out) → { partner: Float32Array per triangle of the group (dbId of
 * the object that holds it there, 0 none), shared: Uint8Array per vertex (on a skin shared with another object, kept
 * in place in the simplified copies), pairs: number of contained pairs }.
 */
export async function containedSkins(group, partners) {
  const nt = group ? group.idx.length / 3 : 0;
  if (!nt) return { partner: new Float32Array(0), shared: new Uint8Array(0), pairs: 0 };
  const others = partners && partners.idx.length ? nearSurface(group, partners) : null;
  const nv = group.ids.length, total = nv + (others ? others.ids.length : 0);
  const pos = new Float64Array(total * 3), ids = new Float32Array(total);
  const idx = new Uint32Array(group.idx.length + (others ? others.idx.length : 0)), asked = new Uint8Array(idx.length / 3);
  pos.set(group.pos.subarray(0, nv * 3)); ids.set(group.ids.subarray(0, nv)); idx.set(group.idx); asked.fill(1, 0, nt);
  if (others) {
    pos.set(others.pos.subarray(0, others.ids.length * 3), nv * 3);
    ids.set(others.ids, nv);
    for (let k = 0; k < others.idx.length; k++) idx[group.idx.length + k] = others.idx[k] + nv;
  }
  const pool = workers(), job = nextJob++, worker = pool[turn++ % pool.length];
  const out = await new Promise((resolve, reject) => {
    pending.set(job, { resolve, reject, worker });
    hold(worker, 1);
    worker.postMessage({ job, pos, ids, idx, asked, reach: SKIN_REACH, parallel: PARALLEL, thicker: THICKER, coarser: COARSER, share: SHARE, depth: DEPTH },
      [pos.buffer, ids.buffer, idx.buffer, asked.buffer]);
  });
  return { partner: out.partner.subarray(0, nt), shared: out.shared.subarray(0, nv), pairs: out.pairs };
}

/**
 * The partners with a face within SKIN_REACH of the group's faces (on a 1 m grid of the group's triangle boxes), whole
 * (their thickness is measured through them): an object near the tile only by its box is left out — a junction tile's
 * neighbours by box were 12.2 million triangles, the rule's time 35 s.
 */
export function nearSurface(group, partners) {
  const CELL = 1, near = new Set();
  const cells = (box, pad, visit) => {
    for (let x = Math.floor((box[0] - pad) / CELL); x <= Math.floor((box[3] + pad) / CELL); x++)
      for (let y = Math.floor((box[1] - pad) / CELL); y <= Math.floor((box[4] + pad) / CELL); y++)
        for (let z = Math.floor((box[2] - pad) / CELL); z <= Math.floor((box[5] + pad) / CELL); z++) if (visit(`${x},${y},${z}`)) return true;
    return false;
  };
  const boxOf = (pos, idx, t) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) { const x = pos[idx[t + k] * 3 + a]; if (x < b[a]) b[a] = x; if (x > b[a + 3]) b[a + 3] = x; }
    return b;
  };
  for (let t = 0; t < group.idx.length; t += 3) cells(boxOf(group.pos, group.idx, t), SKIN_REACH, k => { near.add(k); return false; });
  const keep = new Set();
  for (let t = 0; t < partners.idx.length; t += 3) {
    const id = partners.ids[partners.idx[t]];
    if (!keep.has(id) && cells(boxOf(partners.pos, partners.idx, t), 0, k => near.has(k))) keep.add(id);
  }
  if (!keep.size) return null;
  const remap = new Int32Array(partners.ids.length).fill(-1), idx = [];
  let n = 0;
  for (let t = 0; t < partners.idx.length; t += 3) {
    if (!keep.has(partners.ids[partners.idx[t]])) continue;
    for (let k = 0; k < 3; k++) { const v = partners.idx[t + k]; if (remap[v] < 0) remap[v] = n++; idx.push(remap[v]); }
  }
  const pos = new Float64Array(n * 3), ids = new Float32Array(n);
  for (let v = 0; v < remap.length; v++) if (remap[v] >= 0) { pos.set(partners.pos.subarray(v * 3, v * 3 + 3), remap[v] * 3); ids[remap[v]] = partners.ids[v]; }
  return { pos, ids, idx: Uint32Array.from(idx) };
}

/**
 * The group with `skin` (Float32Array per vertex: the partner of its triangles) and `lock` (per vertex, from `shared`):
 * a vertex whose triangles have different partners is copied once per partner, so each face carries its own (the
 * simplifier keeps such copies together as a seam). Without any partner the group comes back as it was (no skin).
 */
export function applySkins(group, partner, shared) {
  const nv = group.ids.length;
  if (!partner.some(p => p > 0)) return { group, lock: shared };
  const first = new Float32Array(nv).fill(-1), extra = [], extraOf = new Map(), idx = new Uint32Array(group.idx.length);
  for (let i = 0; i < group.idx.length; i++) {
    const v = group.idx[i], p = partner[(i / 3) | 0];
    if (first[v] < 0) first[v] = p;
    if (first[v] === p) { idx[i] = v; continue; }
    const k = v * 4294967296 + p;
    let r = extraOf.get(k);
    if (r === undefined) { r = nv + extra.length; extra.push(v); extraOf.set(k, r); }
    idx[i] = r;
  }
  const n = nv + extra.length, source = v => (v < nv ? v : extra[v - nv]);
  const out = { pos: new Float64Array(n * 3), rgba: new Uint8Array(n * 4), ids: new Float32Array(n), idx, skin: new Float32Array(n) };
  const lock = new Uint8Array(n);
  out.pos.set(group.pos.subarray(0, nv * 3)); out.rgba.set(group.rgba.subarray(0, nv * 4)); out.ids.set(group.ids.subarray(0, nv));
  for (let v = 0; v < nv; v++) { out.skin[v] = Math.max(0, first[v]); lock[v] = shared[v]; }
  for (const [k, p] of extraOf) {
    const r = p, v = source(r);
    out.pos.set(group.pos.subarray(v * 3, v * 3 + 3), r * 3);
    out.rgba.set(group.rgba.subarray(v * 4, v * 4 + 4), r * 4);
    out.ids[r] = group.ids[v];
    out.skin[r] = k - v * 4294967296;
    lock[r] = shared[v];
  }
  return { group: out, lock };
}
