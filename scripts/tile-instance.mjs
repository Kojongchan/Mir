/** Preserve source geometry inside its spatial tile, with a transform per object.
 * Restrict to positive similarity transforms: shear/mirroring/nonuniform scale retain
 * the established baked path, including its normal and winding behavior.
 */
export function tileInstance(positions, normals, transform, origin) {
  const m = transform ? Array.from(transform) : [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  if (m.length !== 16 || !m.every(Number.isFinite) || !origin?.every(Number.isFinite) ||
      origin.length !== 3 || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1 ||
      !normals || normals.length !== positions.length || positions.length % 3) return null;
  const cols = [m.slice(0,3),m.slice(4,7),m.slice(8,11)];
  const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
  const s = dot(cols[0],cols[0]);
  if (s < 1e-20 || cols.some(c=>Math.abs(dot(c,c)-s)>s*1e-8) ||
      [[0,1],[0,2],[1,2]].some(([a,b])=>Math.abs(dot(cols[a],cols[b]))>s*1e-8)) return null;
  const det = m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);
  if (det <= 0) return null;
  const pos = Float32Array.from(positions), nrm = new Float32Array(normals.length);
  // Never introduce extra local-position rounding to achieve sharing.
  if (pos.some((v,i)=>!Number.isFinite(v) || v !== positions[i])) return null;
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  for (let i=0;i<pos.length;i+=3) {
    const len = Math.hypot(normals[i],normals[i+1],normals[i+2]);
    if (!Number.isFinite(len) || len === 0) return null;
    for (let a=0;a<3;a++) {
      nrm[i+a]=normals[i+a]/len;
      min[a]=Math.min(min[a],pos[i+a]);max[a]=Math.max(max[a],pos[i+a]);
    }
  }
  for(let a=0;a<3;a++) m[12+a]-=origin[a];
  return {pos,nrm,min,max,matrix:m};
}
