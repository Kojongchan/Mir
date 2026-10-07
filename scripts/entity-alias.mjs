// Owners of fragments that convert2xkt renamed. Every glTF node of a tile is named with its SVF dbId; when one
// object has several fragments in the same file, convert2xkt keeps the first name and calls the others
// `entity-N`, so selection, highlights and properties lose those fragments. Each renamed fragment is matched
// here to a source fragment (SVF FragmentList: dbId + world box) of an object that is named in the same file.
// Pure: arrays in, plain objects out.

const NAMED = /^\d+$/;
const GENERATED = /^entity-(\d+)$/;
const CELL = 1; // metres; candidate lookup by the box's minimum corner
const CENTRE_CELL = 4; // metres; second pass looks up by centre

/** Per-axis match tolerance: file quantization, float32 source boxes at survey coordinates, slack. */
const tolerance = (step, value) => 0.03 + 2 * step + 2.5e-7 * Math.abs(value);

/** Index of source fragments: dbId per fragment, world boxes, fragments per dbId. */
export function indexFragments(list) {
  const db = new Int32Array(list.length), boxes = new Float64Array(list.length * 6), byDb = new Map();
  list.forEach((f, i) => {
    db[i] = f.dbId;
    boxes.set(f.bbox, i * 6);
    const ids = byDb.get(f.dbId);
    if (ids) ids.push(i); else byDb.set(f.dbId, [i]);
  });
  return { db, boxes, byDb };
}

/**
 * The converter writes `world − origin` (a whole-metre origin). Estimated from named entities of objects with
 * a single source fragment (unambiguous): the most common rounded difference of their minimum corners.
 */
export function estimateOrigin(files, fragments, maxSamples = 20000) {
  const votes = new Map();
  let samples = 0;
  for (const { ids, boxes } of files) {
    for (let e = 0; e < ids.length && samples < maxSamples; e++) {
      if (!NAMED.test(ids[e]) || Number.isNaN(boxes[e * 6])) continue;
      const list = fragments.byDb.get(Number(ids[e]));
      if (!list || list.length !== 1) continue;
      const f = list[0] * 6;
      const key = [0, 1, 2].map(a => Math.round(fragments.boxes[f + a] - boxes[e * 6 + a])).join(',');
      votes.set(key, (votes.get(key) ?? 0) + 1);
      samples++;
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { origin: best[0].split(',').map(Number), votes: best[1], samples } : null;
}

/**
 * Aliases of one file as flat pairs [N, dbId, N, dbId, …] for its `entity-N` entities. Named entities first
 * claim their own fragment; each renamed one then takes the closest unclaimed fragment of a named object.
 */
export function matchFile({ ids, boxes, steps }, fragments, origin) {
  const fb = fragments.boxes;
  const named = new Set();
  for (const id of ids) if (NAMED.test(id)) named.add(Number(id));
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const grid = new Map();
  for (const d of named) for (const f of fragments.byDb.get(d) ?? []) {
    const key = cellKey(...[0, 1, 2].map(a => Math.floor((fb[f * 6 + a] - origin[a]) / CELL)));
    const cell = grid.get(key);
    if (cell) cell.push(f); else grid.set(key, [f]);
  }
  const candidates = e => {
    const base = [0, 1, 2].map(a => Math.floor(boxes[e * 6 + a] / CELL)), out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const f of grid.get(cellKey(base[0] + dx, base[1] + dy, base[2] + dz)) ?? []) out.push(f);
    return out;
  };
  /** Largest per-axis error in tolerances (≤ 1 is a match). */
  const fit = (e, f) => {
    let worst = 0;
    for (let a = 0; a < 6; a++) {
      const source = fb[f * 6 + a];
      const err = Math.abs(boxes[e * 6 + a] - (source - origin[a % 3])) / tolerance(steps[e * 3 + a % 3], source);
      if (err > worst) worst = err;
    }
    return worst;
  };
  const taken = new Set();
  const stats = { entities: ids.length, named: 0, namedMatched: 0, generated: 0, matched: 0, contained: 0, ambiguous: 0 };
  const left = [];
  ids.forEach((id, e) => {
    if (!NAMED.test(id) || Number.isNaN(boxes[e * 6])) return;
    stats.named++;
    let best = -1, bestFit = 1;
    for (const f of candidates(e)) {
      if (fragments.db[f] !== Number(id) || taken.has(f)) continue;
      const v = fit(e, f);
      if (v <= bestFit) { best = f; bestFit = v; }
    }
    if (best >= 0) { taken.add(best); stats.namedMatched++; }
  });
  const pairs = [];
  ids.forEach((id, e) => {
    const g = GENERATED.exec(id);
    if (!g || Number.isNaN(boxes[e * 6])) return;
    stats.generated++;
    let best = -1, bestFit = 1;
    const fits = [];
    for (const f of candidates(e)) {
      if (taken.has(f)) continue;
      const v = fit(e, f);
      if (v > 1) continue;
      fits.push(f);
      if (v <= bestFit) { best = f; bestFit = v; }
    }
    if (best < 0) { left.push(e); return; }
    if (fits.some(f => fragments.db[f] !== fragments.db[best])) stats.ambiguous++;
    taken.add(best);
    pairs.push(Number(g[1]), fragments.db[best]);
    stats.matched++;
  });

  // Second pass: a source box of rotated geometry is the box of its rotated local box, so it can be larger
  // than the entity's tight box. Accept a box that contains the entity with nearly the same centre.
  const centreGrid = new Map();
  const centreOf = (arr, i, shift) => [0, 1, 2].map(a => (arr[i * 6 + a] + arr[i * 6 + a + 3]) / 2 - (shift ? origin[a] : 0));
  for (const d of named) for (const f of fragments.byDb.get(d) ?? []) {
    if (taken.has(f)) continue;
    const key = cellKey(...centreOf(fb, f, true).map(v => Math.floor(v / CENTRE_CELL)));
    const cell = centreGrid.get(key);
    if (cell) cell.push(f); else centreGrid.set(key, [f]);
  }
  const loose = (e, f) => {
    const c = centreOf(boxes, e, false), fc = centreOf(fb, f, true);
    let diag = 0;
    for (let a = 0; a < 3; a++) {
      const tol = tolerance(steps[e * 3 + a], fb[f * 6 + a]);
      if (boxes[e * 6 + a] < fb[f * 6 + a] - origin[a] - tol || boxes[e * 6 + a + 3] > fb[f * 6 + a + 3] - origin[a] + tol) return Infinity;
      diag += (fb[f * 6 + a + 3] - fb[f * 6 + a]) ** 2;
    }
    const off = Math.hypot(c[0] - fc[0], c[1] - fc[1], c[2] - fc[2]);
    return off <= Math.max(0.1, 0.1 * Math.sqrt(diag)) ? off : Infinity;
  };
  for (const e of left) {
    const base = centreOf(boxes, e, false).map(v => Math.floor(v / CENTRE_CELL));
    let best = -1, bestOff = Infinity, rivals = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const f of centreGrid.get(cellKey(base[0] + dx, base[1] + dy, base[2] + dz)) ?? []) {
        if (taken.has(f)) continue;
        const off = loose(e, f);
        if (off === Infinity) continue;
        if (best >= 0 && fragments.db[f] !== fragments.db[best]) rivals++;
        if (off < bestOff) { best = f; bestOff = off; }
      }
    if (best < 0) continue;
    if (rivals) stats.ambiguous++;
    taken.add(best);
    pairs.push(Number(GENERATED.exec(ids[e])[1]), fragments.db[best]);
    stats.matched++; stats.contained++;
  }
  return { pairs, stats };
}
