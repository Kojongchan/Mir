import { MeshoptSimplifier } from 'meshoptimizer';

// Conservative motion-only approximation. Never subsample triangles or discard
// a component to meet a budget. Error is in source-coordinate units, not meters.
export async function simplifyTileMesh(pos, nrm, indices, { ratio = .2, relativeError = .001 } = {}) {
  await MeshoptSimplifier.ready;
  if (!(ratio > 0 && ratio < 1) || !(relativeError > 0 && relativeError <= .01)) throw new Error('Invalid LOD limits');
  const original = { pos, nrm, idx: indices, reduced: false };
  const nv = pos.length / 3;
  if (!Number.isInteger(nv) || nrm?.length !== pos.length || indices.length % 3 ||
      !pos.every(Number.isFinite) || !nrm.every(Number.isFinite) ||
      !indices.every(i => Number.isInteger(i) && i >= 0 && i < nv)) throw new Error('Invalid LOD geometry');
  if (indices.length < 96) return original;
  // Separate disconnected islands so a tiny detached part cannot disappear.
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < indices.length; i += 3) {
    const a = root(indices[i]); parent[root(indices[i + 1])] = a; parent[root(indices[i + 2])] = a;
  }
  const islands = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const r = root(indices[i]); if (!islands.has(r)) islands.set(r, []);
    islands.get(r).push(indices[i], indices[i + 1], indices[i + 2]);
  }
  const bounds = idx => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of idx) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], pos[v * 3 + a]); b[a + 3] = Math.max(b[a + 3], pos[v * 3 + a]); }
    return b;
  };
  const chosen = [];
  for (const list of islands.values()) {
    const input = Uint32Array.from(list); let output = input;
    if (input.length >= 96) {
      const b = bounds(input), scale = Math.max(b[3]-b[0], b[4]-b[1], b[5]-b[2]);
      // Localize each component so model coordinates cannot inflate error tolerance.
      const ids = [...new Set(input)], remap = new Map(ids.map((v,i)=>[v,i]));
      const local = Float32Array.from(ids.flatMap(v => [pos[v*3]-b[0],pos[v*3+1]-b[1],pos[v*3+2]-b[2]]));
      const localIdx = Uint32Array.from(input, v => remap.get(v));
      try {
        const [result, error] = MeshoptSimplifier.simplify(localIdx, local, 3,
          Math.max(3, Math.floor(input.length * ratio / 3) * 3), relativeError, ['LockBorder']);
        const candidate = Uint32Array.from(result, v => ids[v]);
        const c = bounds(candidate);
        const valid = candidate.length >= 3 && candidate.length < input.length && candidate.length % 3 === 0 &&
          Number.isFinite(error) && error <= relativeError &&
          candidate.every(v => v < nv) && c.every((v,a) => Number.isFinite(v) && Math.abs(v-b[a]) <= Math.max(1e-6, Math.min(scale * relativeError * 2, (b[a%3+3]-b[a%3]) * .01)));
        if (valid) output = candidate;
      } catch { /* Unsupported topology retains the complete original component. */ }
    }
    for (const v of output) chosen.push(v);
  }
  if (chosen.length >= indices.length) return original;
  // Compact referenced positions and normals; preserve normal seams and exact values.
  const map = new Map(), p = [], n = [];
  const idx = Uint32Array.from(chosen, v => {
    if (!map.has(v)) { map.set(v, map.size); p.push(pos[v*3],pos[v*3+1],pos[v*3+2]); n.push(nrm[v*3],nrm[v*3+1],nrm[v*3+2]); }
    return map.get(v);
  });
  return { pos: Float32Array.from(p), nrm: Float32Array.from(n), idx, reduced: true };
}
