// Worker of scripts/clearance.mjs: per asked vertex, which of the distances `limits` (ascending, metres) have a
// triangle of another object within them. One BVH per object (three-mesh-bvh) and a grid of the objects' boxes: a
// vertex only looks at the other objects whose box is within reach, each test stopping at the first triangle within
// it. One BVH for the whole tile spent its time on the vertex's own object (a track tile: 13 s; this way a fraction).
import { parentPort } from 'node:worker_threads';
import { Box3, BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const CELL = 4; // metres: grid of object boxes
const key = (x, y, z) => `${x},${y},${z}`;

parentPort.on('message', ({ job, pos, ids, idx, ask, limits }) => {
  const n = ids.length, reach = limits[limits.length - 1];
  // Float32 positions relative to the first vertex (a tile spans a few hundred metres: 0.03 mm steps).
  const local = new Float32Array(n * 3);
  for (let v = 0; v < n * 3; v++) local[v] = pos[v] - pos[v % 3];
  const position = new BufferAttribute(local, 3);
  // Triangles per object.
  const lists = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const id = ids[idx[t]];
    let l = lists.get(id);
    if (!l) lists.set(id, (l = []));
    l.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const objects = new Map(), grid = new Map();
  for (const [id, l] of lists) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setIndex(new BufferAttribute(Uint32Array.from(l), 1));
    const bvh = new MeshBVH(geometry, { maxLeafTris: 8 });
    const box = new Box3();
    bvh.getBoundingBox(box);
    objects.set(id, { bvh, box });
    const lo = box.min, hi = box.max;
    for (let x = Math.floor((lo.x - reach) / CELL); x <= Math.floor((hi.x + reach) / CELL); x++)
      for (let y = Math.floor((lo.y - reach) / CELL); y <= Math.floor((hi.y + reach) / CELL); y++)
        for (let z = Math.floor((lo.z - reach) / CELL); z <= Math.floor((hi.z + reach) / CELL); z++) {
          const k = key(x, y, z), c = grid.get(k);
          if (c) c.push(id); else grid.set(k, [id]);
        }
  }
  const p = new Vector3(), q = new Vector3();
  let radius = 0;
  const hit = { boundsTraverseOrder: box => box.distanceToPoint(p), intersectsBounds: box => box.distanceToPoint(p) <= radius,
    intersectsTriangle: tri => tri.closestPointToPoint(p, q).distanceTo(p) <= radius };
  // Per vertex: the limit below the smallest one with another object within it (0 below the first), or the last limit
  // when none has; `value < error` then tells whether a copy of that error must keep the vertex.
  const out = new Float32Array(n).fill(reach);
  for (let v = 0; v < n; v++) {
    if (!ask[v]) continue;
    p.set(local[v * 3], local[v * 3 + 1], local[v * 3 + 2]);
    const own = ids[v], near = grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)));
    if (!near) continue;
    let best = limits.length; // index of the smallest limit with another object within it
    for (const id of near) {
      if (id === own) continue;
      const o = objects.get(id), gap = o.box.distanceToPoint(p);
      for (let k = best - 1; k >= 0 && limits[k] >= gap; k--) {
        radius = limits[k];
        if (!o.bvh.shapecast(hit)) break;
        best = k;
      }
      if (best === 0) break;
    }
    if (best < limits.length) out[v] = best ? limits[best - 1] : 0;
  }
  parentPort.postMessage({ job, out }, [out.buffer]);
});
