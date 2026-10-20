// How close each vertex of a tile's original level is to another object, for the simplified copies (build-tiles3d.mjs).
// Two objects' layers a few centimetres apart (a tunnel portal's shotcrete over its lining, 3 cm) cut through each other
// once both are simplified by more than the gap: the 0.1 m copy of tile 931 showed the white lining in stripes through
// the grey shotcrete (user report "거리감에 따라 잔상", 5.1 % of the rays onto the shotcrete hit the lining first; 11.4 %
// in the 1 m copy). Vertices nearer another object than a copy's error are kept in place in that copy (0.3 %).
//   curvedVertices  vertices whose triangles are not all in one plane (flat ones can move in their plane)
//   nearOther       per vertex, which copy errors have a triangle of another object within them (worker threads)
import os from 'node:os';
import { Worker } from 'node:worker_threads';

/** 1 for vertices whose triangles' normals differ by more than `degrees` (curved surfaces, creases, corners). */
export function curvedVertices({ pos, idx }, count, degrees = 2) {
  const first = new Float32Array(count * 3), minDot = new Float32Array(count).fill(2);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    for (const v of [idx[t], idx[t + 1], idx[t + 2]]) {
      if (minDot[v] === 2) { first[v * 3] = nx / len; first[v * 3 + 1] = ny / len; first[v * 3 + 2] = nz / len; minDot[v] = 1; continue; }
      minDot[v] = Math.min(minDot[v], Math.abs(first[v * 3] * nx + first[v * 3 + 1] * ny + first[v * 3 + 2] * nz) / len);
    }
  }
  const limit = Math.cos((degrees * Math.PI) / 180);
  return Uint8Array.from(minDot, d => (d < limit ? 1 : 0));
}

let pool = null;
const pending = new Map(); // job → { resolve, reject, worker }
let nextJob = 0, turn = 0;
/** Workers keep the process alive only while they have a job (an idle pool must not hold the build open). */
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
    const w = new Worker(new URL('./clearance-worker.mjs', import.meta.url));
    w.on('message', ({ job, out }) => { const p = pending.get(job); pending.delete(job); hold(w, -1); p?.resolve(out); });
    w.on('error', e => { for (const [job, p] of pending) if (p.worker === w) { pending.delete(job); hold(w, -1); p.reject(e); } });
    w.unref();
    return w;
  });
  return pool;
}

/**
 * Groups of one tile ({ pos, ids, idx }, null allowed; the opaque and the transparent one) and the copies' errors
 * (metres) → per group a Float32Array per vertex, such that `value < error` exactly when a triangle of another object
 * (in any of the groups) lies within `error` of the vertex: the next smaller error with one within it (0 below the
 * smallest), or the largest error when none is (also for flat vertices). Measured in worker threads (one per core), so
 * several tiles are measured at once.
 */
export async function nearOther(groups, errors) {
  const limits = [...errors].sort((a, b) => a - b);
  const list = groups.map(g => (g && g.idx.length ? g : null));
  const counts = list.map(g => (g ? g.ids.length : 0)), total = counts.reduce((a, b) => a + b, 0);
  if (!total) return groups.map(() => null);
  const pos = new Float64Array(total * 3), ids = new Float32Array(total), ask = new Uint8Array(total);
  const idx = new Uint32Array(list.reduce((n, g) => n + (g ? g.idx.length : 0), 0));
  let v0 = 0, i0 = 0;
  for (const g of list) {
    if (!g) continue;
    const n = g.ids.length;
    pos.set(g.pos.subarray(0, n * 3), v0 * 3);
    ids.set(g.ids.subarray(0, n), v0);
    ask.set(curvedVertices(g, n), v0);
    for (let k = 0; k < g.idx.length; k++) idx[i0 + k] = g.idx[k] + v0;
    v0 += n; i0 += g.idx.length;
  }
  const pool = workers(), job = nextJob++, worker = pool[turn++ % pool.length];
  const out = await new Promise((resolve, reject) => {
    pending.set(job, { resolve, reject, worker });
    hold(worker, 1);
    worker.postMessage({ job, pos, ids, idx, ask, limits }, [pos.buffer, ids.buffer, idx.buffer, ask.buffer]);
  });
  let at = 0;
  return list.map((g, k) => { const n = counts[k], part = g ? out.slice(at, at + n) : null; at += n; return part; });
}
