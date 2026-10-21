// Worker of scripts/skins.mjs: contained skins of one tile's objects. One BVH per object (the tile's and the
// partners'), a grid of their boxes; for each of the tile's triangles, the other objects' faces within SKIN_REACH that
// are parallel and straight across, judged by local thickness (rays both ways through each object's own mesh).
import { parentPort } from 'node:worker_threads';
import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const CELL = 8; // metres: grid of object boxes
const key = (x, y, z) => `${x},${y},${z}`;

parentPort.on('message', ({ job, pos, ids, idx, asked, reach, parallel, thicker, coarser, share, depth: sunk }) => {
  const n = ids.length;
  // Float32 positions relative to the first vertex (a tile and its neighbours span a few hundred metres).
  const local = new Float32Array(n * 3);
  for (let v = 0; v < n * 3; v++) local[v] = pos[v] - pos[v % 3];
  const position = new BufferAttribute(local, 3);
  const lists = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const id = ids[idx[t]];
    let l = lists.get(id);
    if (!l) lists.set(id, (l = []));
    l.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const tri = new Triangle(), a = new Vector3(), b = new Vector3(), c = new Vector3();
  const objects = new Map(), grid = new Map();
  for (const [id, l] of lists) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setIndex(new BufferAttribute(Uint32Array.from(l), 1));
    const box = new Box3();
    let area = 0;
    for (let k = 0; k < l.length; k += 3) {
      area += tri.set(a.fromArray(local, l[k] * 3), b.fromArray(local, l[k + 1] * 3), c.fromArray(local, l[k + 2] * 3)).getArea();
      box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    }
    // The hierarchy is built when a triangle first comes near the object (most neighbours never do: 12 million
    // triangles around a junction tile took 9 s to index). It reorders `index` in place; face numbers follow it.
    let bvh = null;
    objects.set(id, { id, index: geometry.index.array, box, meanArea: area / (l.length / 3),
      get bvh() { return (bvh ??= new MeshBVH(geometry, { maxLeafTris: 8 })); } });
    for (let x = Math.floor((box.min.x - reach) / CELL); x <= Math.floor((box.max.x + reach) / CELL); x++)
      for (let y = Math.floor((box.min.y - reach) / CELL); y <= Math.floor((box.max.y + reach) / CELL); y++)
        for (let z = Math.floor((box.min.z - reach) / CELL); z <= Math.floor((box.max.z + reach) / CELL); z++) {
          const k = key(x, y, z), cell = grid.get(k);
          if (cell) cell.push(id); else grid.set(k, [id]);
        }
  }
  const ray = new Ray(), p = new Vector3(), nB = new Vector3(), nA = new Vector3(), q = new Vector3(), d = new Vector3();
  /** Distance to the object's own surface along +dir and −dir from a point on it (2 mm off): its local thickness. */
  const through = (o, point, dir) => [1, -1].map(sign => {
    ray.origin.copy(point).addScaledVector(dir, sign * 0.002);
    ray.direction.copy(dir).multiplyScalar(sign);
    const hit = o.bvh.raycastFirst(ray, DoubleSide, 0, 30); // a tunnel's excavation is 10–15 m across
    return hit ? hit.distance + 0.002 : Infinity;
  });
  const faceNormal = (o, f, out) => tri.set(a.fromArray(local, o.index[f * 3] * 3), b.fromArray(local, o.index[f * 3 + 1] * 3),
    c.fromArray(local, o.index[f * 3 + 2] * 3)).getNormal(out);
  const thickness = new Map(); // A's thickness at the middle of one of its faces (many of B's triangles meet the same face)
  const areaOf = t => tri.set(a.fromArray(local, idx[t * 3] * 3), b.fromArray(local, idx[t * 3 + 1] * 3), c.fromArray(local, idx[t * 3 + 2] * 3)).getArea();
  /**
   * Triangle t of B against the other objects in its cell (or only `only`): for each face within reach, parallel,
   * straight across and with both bodies on the same side, `visit(A, tA, depth, outer, inner)` — depth: the share of
   * the thinner body's thickness lying within the other one there; outer: A is the outer one (thicker, or the finer
   * of two of a thickness), inner: B is.
   */
  const judge = (t, only, visit) => {
    const B = objects.get(ids[idx[t * 3]]);
    tri.set(a.fromArray(local, idx[t * 3] * 3), b.fromArray(local, idx[t * 3 + 1] * 3), c.fromArray(local, idx[t * 3 + 2] * 3));
    if (!(tri.getArea() > 1e-6)) return;
    tri.getNormal(nB); tri.getMidpoint(p);
    const list = only ?? grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    if (!list) return;
    let sides = null, tB = 0;
    for (const id of list) {
      if (id === B.id) continue;
      const A = objects.get(id);
      if (!A || A.box.distanceToPoint(p) > reach) continue;
      const r = A.bvh.closestPointToPoint(p, {}, 0, reach);
      if (!r || r.distance > reach) continue;
      faceNormal(A, r.faceIndex, nA);
      if (Math.abs(nB.dot(nA)) < parallel) continue;
      d.copy(r.point).sub(p);
      if (r.distance > 0.001 && Math.abs(d.dot(nA)) < 0.95 * r.distance) continue; // beside that face, not across it
      if (!sides) {
        sides = through(B, p, nB);
        tB = Math.min(sides[0], sides[1]);
        if (!Number.isFinite(tB)) return; // B is open here: no body to judge
      }
      const cached = id * 16777216 + r.faceIndex;
      let at = thickness.get(cached);
      if (!at) {
        const n0 = nA.clone();
        tri.set(a.fromArray(local, A.index[r.faceIndex * 3] * 3), b.fromArray(local, A.index[r.faceIndex * 3 + 1] * 3), c.fromArray(local, A.index[r.faceIndex * 3 + 2] * 3));
        tri.getMidpoint(q);
        thickness.set(cached, (at = through(A, q, n0)));
        nA.copy(n0);
      }
      const tA = Math.min(at[0], at[1]);
      if (!Number.isFinite(tA)) continue;
      // Each body's side of the skin: where its own surface comes again first.
      const bodyB = sides[0] <= sides[1] ? 1 : -1, bodyA = at[0] <= at[1] ? 1 : -1;
      if (bodyB * bodyA * nB.dot(nA) <= 0) continue; // bodies on opposite sides: faces touching, not one skin
      // Across the skins, towards the bodies: B's body spans [0, tB], A's [s, s + tA]. A layer lying on another
      // (shotcrete on the lining, a finish on a wall: s = tB) overlaps it nowhere, though thinner.
      const s = bodyB * d.dot(nB);
      const depth = Math.max(0, Math.min(tB, s + tA) - Math.max(0, s)) / Math.min(tA, tB);
      const outer = tA > thicker * tB || (tB < thicker * tA && B.meanArea > coarser * A.meanArea);
      const inner = tB > thicker * tA || (tA < thicker * tB && A.meanArea > coarser * B.meanArea);
      visit(id, tA, depth, outer, inner);
    }
  };
  // Pass 1, over a sample of each object's skin (its SAMPLE largest triangles): per pair (B, A) the area facing A, that
  // area times the bodies' depth share, the part where A is the outer one and where B is.
  const SAMPLE = 2000, byObject = new Map();
  for (let t = 0; t < idx.length / 3; t++) {
    if (!asked[t]) continue;
    const id = ids[idx[t * 3]], l = byObject.get(id);
    if (l) l.push(t); else byObject.set(id, [t]);
  }
  const pairs = new Map();
  for (const [own, list] of byObject) {
    const sample = list.length <= SAMPLE ? list : list.map(t => [t, areaOf(t)]).sort((x, y) => y[1] - x[1]).slice(0, SAMPLE).map(([t]) => t);
    for (const t of sample) {
      const area = areaOf(t);
      judge(t, null, (id, tA, depth, outer, inner) => {
        const k = `${own}~${id}`;
        let e = pairs.get(k);
        if (!e) pairs.set(k, (e = { all: 0, depth: 0, out: 0, in: 0 }));
        e.all += area; e.depth += depth * area; if (outer) e.out += area; if (inner) e.in += area;
      });
    }
  }
  // Contained pairs: over B's skin facing A the bodies overlap by `sunk` of the thinner one's thickness on average,
  // and A is the outer one (B goes behind A). The reverse (B holds A) only keeps B's skin in place in the copies, as
  // A's tile pushes A.
  const push = new Map(), hold = new Map(), add = (m, own, id) => { const l = m.get(own); if (l) l.push(id); else m.set(own, [id]); };
  let contained = 0;
  for (const [k, e] of pairs) {
    if (e.depth < sunk * e.all) continue;
    const [own, id] = k.split('~').map(Number);
    if (e.out >= share * e.all) { add(push, own, id); contained++; } else if (e.in >= share * e.all) add(hold, own, id);
  }
  // Pass 2, every triangle of the objects in such pairs against those partners only: the outermost one it lies on
  // (the thickest), and whether it is on a shared skin.
  const nt = idx.length / 3, partner = new Float32Array(nt), shared = new Uint8Array(n);
  for (const [own, list] of byObject) {
    const pushed = push.get(own) ?? [], held = hold.get(own) ?? [];
    if (!pushed.length && !held.length) continue;
    const only = [...pushed, ...held];
    for (const t of list) {
      let best = 0, bestT = -1, near = false;
      judge(t, only, (id, tA) => { near = true; if (pushed.includes(id) && tA > bestT) { best = id; bestT = tA; } });
      partner[t] = best;
      if (near) shared[idx[t * 3]] = shared[idx[t * 3 + 1]] = shared[idx[t * 3 + 2]] = 1;
    }
  }
  parentPort.postMessage({ job, partner, shared, pairs: contained }, [partner.buffer, shared.buffer]);
});
