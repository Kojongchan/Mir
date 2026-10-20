// Worker of scripts/clearance.mjs: per asked vertex, the distance to the nearest triangle of another object (capped at
// `reach`), over a BVH of the triangles (three-mesh-bvh shapecast).
import { parentPort } from 'node:worker_threads';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

parentPort.on('message', ({ job, pos, ids, idx, ask, reach, stopAt }) => {
  const n = ids.length;
  // Float32 positions relative to the first vertex (a tile spans a few hundred metres: 0.03 mm steps).
  const local = new Float32Array(n * 3);
  for (let v = 0; v < n * 3; v++) local[v] = pos[v] - pos[v % 3];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(local, 3));
  geometry.setIndex(new BufferAttribute(idx, 1));
  const bvh = new MeshBVH(geometry, { maxLeafTris: 8 });
  // The BVH reorders the index: each triangle's object from its first vertex.
  const index = geometry.index.array, owner = new Float32Array(index.length / 3);
  for (let t = 0; t < owner.length; t++) owner[t] = ids[index[t * 3]];
  const out = new Float32Array(n).fill(reach), p = new Vector3(), q = new Vector3();
  for (let v = 0; v < n; v++) {
    if (!ask[v]) continue;
    p.set(local[v * 3], local[v * 3 + 1], local[v * 3 + 2]);
    const own = ids[v];
    let best = reach;
    bvh.shapecast({
      intersectsBounds: box => box.distanceToPoint(p) < best,
      intersectsTriangle: (tri, t) => {
        if (owner[t] === own) return false;
        best = Math.min(best, tri.closestPointToPoint(p, q).distanceTo(p));
        return best <= stopAt;
      },
    });
    out[v] = best;
  }
  parentPort.postMessage({ job, out }, [out.buffer]);
});
