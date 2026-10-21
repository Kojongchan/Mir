// Worker of scripts/skins.mjs: contained skins of one tile's objects. One BVH per object (the tile's and the
// partners'), a grid of their boxes; for each of the tile's triangles, the other objects' faces within SKIN_REACH that
// are parallel and straight across, judged by local thickness (rays both ways through each object's own mesh).
import { parentPort } from 'node:worker_threads';
import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const CELL = 8; // metres: grid of object boxes
const key = (x, y, z) => `${x},${y},${z}`;

parentPort.on('message', ({ job, pos, ids, idx, asked, reach, parallel, thicker, coarser, share }) => {
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
    const bvh = new MeshBVH(geometry, { maxLeafTris: 8 });
    const box = new Box3();
    bvh.getBoundingBox(box);
    let area = 0;
    for (let k = 0; k < l.length; k += 3) area += tri.set(a.fromArray(local, l[k] * 3), b.fromArray(local, l[k + 1] * 3), c.fromArray(local, l[k + 2] * 3)).getArea();
    objects.set(id, { id, bvh, index: geometry.index.array, box, meanArea: area / (l.length / 3) });
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
    const hit = o.bvh.raycastFirst(ray, DoubleSide, 0, 100);
    return hit ? hit.distance + 0.002 : Infinity;
  });
  const faceNormal = (o, f, out) => tri.set(a.fromArray(local, o.index[f * 3] * 3), b.fromArray(local, o.index[f * 3 + 1] * 3),
    c.fromArray(local, o.index[f * 3 + 2] * 3)).getNormal(out);
  // Pass 1: per asked triangle, the same-side candidates with their thickness; per pair (B, A) the areas.
  const nt = idx.length / 3, found = [], pairs = new Map();
  for (let t = 0; t < nt; t++) {
    if (!asked[t]) continue;
    const B = objects.get(ids[idx[t * 3]]);
    tri.set(a.fromArray(local, idx[t * 3] * 3), b.fromArray(local, idx[t * 3 + 1] * 3), c.fromArray(local, idx[t * 3 + 2] * 3));
    const area = tri.getArea();
    if (!(area > 1e-6)) continue;
    tri.getNormal(nB); tri.getMidpoint(p);
    const cell = grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    if (!cell) continue;
    let sides = null, tB = 0;
    const list = [];
    for (const id of cell) {
      if (id === B.id) continue;
      const A = objects.get(id);
      if (A.box.distanceToPoint(p) > reach) continue;
      const r = A.bvh.closestPointToPoint(p, {}, 0, reach);
      if (!r || r.distance > reach) continue;
      faceNormal(A, r.faceIndex, nA);
      if (Math.abs(nB.dot(nA)) < parallel) continue;
      d.copy(r.point).sub(p);
      if (r.distance > 0.001 && Math.abs(d.dot(nA)) < 0.95 * r.distance) continue; // beside that face, not across it
      if (!sides) {
        sides = through(B, p, nB);
        tB = Math.min(sides[0], sides[1]);
        if (!Number.isFinite(tB)) break; // B is open here: no body to judge
      }
      q.copy(r.point);
      const [aPlus, aMinus] = through(A, q, nA), tA = Math.min(aPlus, aMinus);
      if (!Number.isFinite(tA)) continue;
      // Each body's side of the skin: where its own surface comes again first.
      const bodyB = sides[0] <= sides[1] ? 1 : -1, bodyA = aPlus <= aMinus ? 1 : -1;
      if (bodyB * bodyA * nB.dot(nA) <= 0) continue; // bodies on opposite sides: faces touching, not one skin
      const overlap = bodyB * d.dot(nB) < tB; // A's skin is reached within B's thickness: the bodies overlap here
      const thick = tA > thicker * tB, duplicate = !thick && tB < thicker * tA && B.meanArea > coarser * A.meanArea;
      const k = `${B.id}~${id}`;
      let e = pairs.get(k);
      if (!e) pairs.set(k, (e = { all: 0, over: 0, out: 0 }));
      e.all += area; if (overlap) e.over += area; if (thick || duplicate) e.out += area;
      list.push(id, tA);
    }
    if (list.length) found.push(t, list);
  }
  // Pairs where most of B's skin facing A overlaps A's body and A is the outer one (thicker, or the finer duplicate).
  const contained = new Set();
  for (const [k, e] of pairs) if (e.over >= share * e.all && e.out >= share * e.all) contained.add(k);
  // Pass 2: per triangle the outermost contained partner (the thickest); per vertex whether it is on a shared skin.
  const partner = new Float32Array(nt), shared = new Uint8Array(n);
  for (let k = 0; k < found.length; k += 2) {
    const t = found[k], list = found[k + 1], own = ids[idx[t * 3]];
    let best = 0, bestT = -1;
    for (let j = 0; j < list.length; j += 2) if (contained.has(`${own}~${list[j]}`) && list[j + 1] > bestT) { best = list[j]; bestT = list[j + 1]; }
    partner[t] = best;
    shared[idx[t * 3]] = shared[idx[t * 3 + 1]] = shared[idx[t * 3 + 2]] = 1;
  }
  parentPort.postMessage({ job, partner, shared, pairs: contained.size }, [partner.buffer, shared.buffer]);
});
