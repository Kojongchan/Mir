/** Deduplicate identical position/normal tuples without snapping or removing faces.
 * Preserve numeric precision until the existing world-to-local transform is applied.
 */
export function weldExact(verts, idx, normals) {
  if (verts.length % 3 || (normals && normals.length !== verts.length)) throw new Error('Invalid vertex attributes');
  const keys = new Map(), mapping = new Uint32Array(verts.length / 3);
  const positions = [], directions = [];
  for (let v = 0; v < mapping.length; v++) {
    const offset = v * 3;
    const values = [verts[offset], verts[offset + 1], verts[offset + 2]];
    if (normals) values.push(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (!values.every(Number.isFinite)) throw new Error('Non-finite vertex attribute');
    const key = values.join(',');
    let target = keys.get(key);
    if (target === undefined) {
      target = positions.length / 3; keys.set(key, target);
      positions.push(...values.slice(0, 3));
      if (normals) directions.push(...values.slice(3));
    }
    mapping[v] = target;
  }
  const indices = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= mapping.length) throw new Error('Invalid vertex index');
    indices[i] = mapping[idx[i]];
  }
  return { verts: Float64Array.from(positions), idx: indices,
    normals: normals ? Float64Array.from(directions) : null };
}
