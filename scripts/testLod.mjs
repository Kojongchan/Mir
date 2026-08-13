// 로컬 검증: 합성 지형(부드러운 언덕)을 만들어 LOD 클러스터링 두 방식을 비교한다.
//  - zfixed: XY 만 격자스냅, Z(높이)는 실제값 유지(현재 수정) → 계단 없음
//  - zsnap : XYZ 전부 격자스냅(옛 방식) → 4m 계단(논밭)
// 원본/두 LOD 를 GLB 로 써서 renderDiag(PW_OBLIQUE=1)로 프로파일을 눈으로 비교.
import fs from 'node:fs';

function finalizeGlb(outPath, pos, nrm, idx, color) {
  const bv = [], acc = [], pieces = []; let bo = 0;
  const addV = (typed, target) => { const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength); bv.push({ buffer: 0, byteOffset: bo, byteLength: buf.length, target }); pieces.push(buf); bo += buf.length; return bv.length - 1; };
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let v = 0; v < pos.length; v += 3) { if (pos[v] < mnx) mnx = pos[v]; if (pos[v + 1] < mny) mny = pos[v + 1]; if (pos[v + 2] < mnz) mnz = pos[v + 2]; if (pos[v] > mxx) mxx = pos[v]; if (pos[v + 1] > mxy) mxy = pos[v + 1]; if (pos[v + 2] > mxz) mxz = pos[v + 2]; }
  const pA = acc.push({ bufferView: addV(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [mnx, mny, mnz], max: [mxx, mxy, mxz] }) - 1;
  const nA = acc.push({ bufferView: addV(nrm, 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' }) - 1;
  const iA = acc.push({ bufferView: addV(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1;
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ mode: 4, attributes: { POSITION: pA, NORMAL: nA }, indices: iA, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }], accessors: acc, bufferViews: bv, buffers: [{ byteLength: bo }] };
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8'); const jsonPad = (4 - (jsonBuf.length % 4)) % 4; const jsonChunkLen = jsonBuf.length + jsonPad; const total = 12 + 8 + jsonChunkLen + 8 + bo;
  const fd = fs.openSync(outPath, 'w'); const head = Buffer.alloc(20); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8); head.writeUInt32LE(jsonChunkLen, 12); head.writeUInt32LE(0x4e4f534a, 16); fs.writeSync(fd, head); fs.writeSync(fd, jsonBuf); if (jsonPad) fs.writeSync(fd, Buffer.alloc(jsonPad, 0x20)); const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bo, 0); binHead.writeUInt32LE(0x004e4942, 4); fs.writeSync(fd, binHead); for (const p of pieces) fs.writeSync(fd, p); fs.closeSync(fd);
}
function recomputeNormals(pos, idx) {
  const nrm = new Float32Array(pos.length);
  for (let k = 0; k + 2 < idx.length; k += 3) { const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3; const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]; const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]; const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; nrm[a] += fx; nrm[a + 1] += fy; nrm[a + 2] += fz; nrm[b] += fx; nrm[b + 1] += fy; nrm[b + 2] += fz; nrm[c] += fx; nrm[c + 1] += fy; nrm[c + 2] += fz; }
  for (let v = 0; v < nrm.length; v += 3) { const x = nrm[v], y = nrm[v + 1], z = nrm[v + 2], l = Math.hypot(x, y, z) || 1; nrm[v] = x / l; nrm[v + 1] = y / l; nrm[v + 2] = z / l; }
  return nrm;
}
// 합성 지형: N×N 그리드, 부드러운 언덕 높이. 좌표계는 실모델과 동일(z=높이).
const N = 200, L = 400, sp = L / N; // 2m 간격
const H = (x, y) => 15 * Math.sin(x / 60) + 12 * Math.cos(y / 50) + 8 * Math.sin((x + y) / 40);
const pos0 = new Float32Array(N * N * 3);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = i * sp - L / 2, y = j * sp - L / 2; const o = (j * N + i) * 3; pos0[o] = x; pos0[o + 1] = y; pos0[o + 2] = H(x, y); }
const idx0 = [];
for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx0.push(a, c, b, b, c, d); }
const I0 = Uint32Array.from(idx0);
finalizeGlb('lodtest_orig.glb', pos0, recomputeNormals(pos0, I0), I0, [0.2, 0.6, 0.25, 1]);
console.log(`[test] 원본 정점 ${N * N} 삼각형 ${I0.length / 3}`);

function cluster(pos, idx, cell, zSnap) {
  const map = new Map(); const lp = [];
  const remap = new Uint32Array(pos.length / 3);
  for (let v = 0; v < pos.length / 3; v++) {
    const qx = Math.round(pos[v * 3] / cell), qy = Math.round(pos[v * 3 + 1] / cell), qz = Math.round(pos[v * 3 + 2] / cell);
    const key = `${qx}_${qy}_${qz}`; let ri = map.get(key);
    if (ri === undefined) { ri = lp.length / 3; map.set(key, ri); lp.push(qx * cell, qy * cell, zSnap ? qz * cell : pos[v * 3 + 2]); }
    remap[v] = ri;
  }
  const out = [];
  for (let k = 0; k + 2 < idx.length; k += 3) { const a = remap[idx[k]], b = remap[idx[k + 1]], c = remap[idx[k + 2]]; if (a !== b && b !== c && a !== c) out.push(a, b, c); }
  return { pos: Float32Array.from(lp), idx: Uint32Array.from(out) };
}
for (const [name, zSnap, col] of [['zfixed', false, [0.2, 0.55, 0.9, 1]], ['zsnap', true, [0.9, 0.4, 0.2, 1]]]) {
  const c = cluster(pos0, I0, 4, zSnap);
  finalizeGlb(`lodtest_${name}.glb`, c.pos, recomputeNormals(c.pos, c.idx), c.idx, col);
  console.log(`[test] LOD(${name}) 정점 ${c.pos.length / 3} 삼각형 ${c.idx.length / 3}`);
}
