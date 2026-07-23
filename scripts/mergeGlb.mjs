// =====================================================================
// 병합 GLB 빌더 — svf-utils IMF 장면을 "재질별 소수 메시"로 병합하고 각 정점에
// dbId(_DBID)를 심어 단일 GLB 로 만든다. 거대 모델은 큰 메시를 meshoptimizer 로
// 단순화(decimation)해 정점·메모리를 급감시켜 브라우저가 감당하게 한다.
//   - 객체-당-노드(수십만 노드) → glTF JSON 512MB 한계 회피(노드=재질 수준).
//   - 큰 Civil 3D 솔리드 단순화 → 정점 1억 → 수백만, GLB 수백 MB → 데스크톱 로드 가능.
//   - 단일 패스 + 그룹별 청크 누적(메모리 피크 최소화 → OOM 회피).
// 런타임(자체 Three.js 뷰어)은 _DBID 로 객체별 시공/철거/미시공을 셰이더로 표현.
// =====================================================================
import fs from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const NODE_OBJECT = 1; // IMF.NodeKind.Object
const GEOM_MESH = 0; // IMF.GeometryKind.Mesh
const GEOM_LINES = 1; // IMF.GeometryKind.Lines (DWG 선형 등)
const GEOM_POINTS = 2; // IMF.GeometryKind.Points (측점 등)
const TRANSFORM_MATRIX = 0; // IMF.TransformKind.Matrix

function composeMatrix(t) {
  const sx = t.scale?.x ?? 1, sy = t.scale?.y ?? 1, sz = t.scale?.z ?? 1;
  const qx = t.rotation?.x ?? 0, qy = t.rotation?.y ?? 0, qz = t.rotation?.z ?? 0, qw = t.rotation?.w ?? 1;
  const tx = t.translation?.x ?? 0, ty = t.translation?.y ?? 0, tz = t.translation?.z ?? 0;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function matrixOf(transform) {
  if (!transform) return null;
  if (transform.kind === TRANSFORM_MATRIX && transform.elements) return transform.elements;
  return composeMatrix(transform);
}

// indices 가 참조하는 정점만 남기고 재색인(단순화 후 미사용 정점 제거).
function compact(indices, verts, normals) {
  const map = new Map();
  const newIdx = new Uint32Array(indices.length);
  let n = 0;
  for (let k = 0; k < indices.length; k++) {
    const oi = indices[k];
    let ni = map.get(oi);
    if (ni === undefined) { ni = n++; map.set(oi, ni); }
    newIdx[k] = ni;
  }
  const pos = new Float32Array(n * 3);
  const nrm = normals ? new Float32Array(n * 3) : null;
  for (const [oi, ni] of map) {
    pos[ni * 3] = verts[oi * 3]; pos[ni * 3 + 1] = verts[oi * 3 + 1]; pos[ni * 3 + 2] = verts[oi * 3 + 2];
    if (nrm) { nrm[ni * 3] = normals[oi * 3]; nrm[ni * 3 + 1] = normals[oi * 3 + 1]; nrm[ni * 3 + 2] = normals[oi * 3 + 2]; }
  }
  return { idx: newIdx, verts: pos, normals: nrm, nv: n };
}

export async function buildMergedGlb(imf, opts) {
  const log = opts.log || (() => {});
  const decimate = process.env.DECIMATE !== '0';
  const ratio = Number(process.env.DECIMATE_RATIO || 0.2); // 큰 메시를 이 비율로 축소
  const minTris = Number(process.env.DECIMATE_MIN_TRIS || 1000); // 이 삼각형 수 초과만 단순화
  const targetError = Number(process.env.DECIMATE_ERROR || 1e3);
  if (decimate) await MeshoptSimplifier.ready;

  const nodeCount = imf.getNodeCount();
  // 그룹(재질)별 청크 누적.
  const groups = new Map(); // matId -> { posCh:[], nrmCh:[], dbCh:[], idxCh:[], base, vtx, idxN, min, max }
  const groupOf = (matId) => {
    let g = groups.get(matId);
    if (!g) {
      g = { posCh: [], nrmCh: [], dbCh: [], idxCh: [], base: 0, vtx: 0, idxN: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      groups.set(matId, g);
    }
    return g;
  };

  // 선(line) 전용 그룹 — 삼각형과 프리미티브 모드가 달라(1 vs 4) 분리 누적. 법선 없음.
  // DWG/도면·선형이 여기로 들어간다(예전엔 통째로 버려서 DWG 가 안 보였음).
  const lineGroups = new Map();
  const lineGroupOf = (matId) => {
    let g = lineGroups.get(matId);
    if (!g) {
      g = { posCh: [], dbCh: [], idxCh: [], base: 0, vtx: 0, idxN: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      lineGroups.set(matId, g);
    }
    return g;
  };
  let lineFrag = 0;
  const addLine = (node, geom) => {
    const verts = geom.getVertices();
    const idx = geom.getIndices();
    if (!verts || !idx || verts.length === 0 || idx.length === 0) return;
    lineFrag++;
    const idx32 = idx instanceof Uint32Array ? idx : Uint32Array.from(idx);
    const nv = verts.length / 3;
    const m = matrixOf(node.transform);
    const pos = new Float32Array(nv * 3);
    const db = new Float32Array(nv);
    const g = lineGroupOf(node.material ?? -1);
    for (let v = 0; v < nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) { ox = m[0] * x + m[4] * y + m[8] * z + m[12]; oy = m[1] * x + m[5] * y + m[9] * z + m[13]; oz = m[2] * x + m[6] * y + m[10] * z + m[14]; }
      else { ox = x; oy = y; oz = z; }
      pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;
      db[v] = node.dbid;
    }
    const reidx = new Uint32Array(idx32.length);
    for (let k = 0; k < idx32.length; k++) reidx[k] = idx32[k] + g.base;
    g.posCh.push(pos); g.dbCh.push(db); g.idxCh.push(reidx);
    g.base += nv; g.vtx += nv; g.idxN += reidx.length;
  };

  // 점(point) 전용 그룹 — mode:0(POINTS), 인덱스 없음.
  const pointGroups = new Map();
  const pointGroupOf = (matId) => {
    let g = pointGroups.get(matId);
    if (!g) {
      g = { posCh: [], dbCh: [], vtx: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      pointGroups.set(matId, g);
    }
    return g;
  };
  let pointFrag = 0;
  const addPoint = (node, geom) => {
    const verts = geom.getVertices();
    if (!verts || verts.length === 0) return;
    pointFrag++;
    const nv = verts.length / 3;
    const m = matrixOf(node.transform);
    const pos = new Float32Array(nv * 3);
    const db = new Float32Array(nv);
    const g = pointGroupOf(node.material ?? -1);
    for (let v = 0; v < nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) { ox = m[0] * x + m[4] * y + m[8] * z + m[12]; oy = m[1] * x + m[5] * y + m[9] * z + m[13]; oz = m[2] * x + m[6] * y + m[10] * z + m[14]; }
      else { ox = x; oy = y; oz = z; }
      pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;
      db[v] = node.dbid;
    }
    g.posCh.push(pos); g.dbCh.push(db); g.vtx += nv;
  };

  let processed = 0, decimated = 0, fragCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    const node = imf.getNode(i);
    if (node.kind !== NODE_OBJECT) continue;
    const geom = imf.getGeometry(node.geometry);
    if (!geom) continue;
    if (geom.kind === GEOM_LINES) { addLine(node, geom); continue; }
    if (geom.kind === GEOM_POINTS) { addPoint(node, geom); continue; }
    if (geom.kind !== GEOM_MESH) continue;
    let verts = geom.getVertices();
    let idx = geom.getIndices();
    let normals = geom.getNormals();
    if (!verts || !idx || verts.length === 0 || idx.length === 0) continue;
    fragCount++;

    let idx32 = idx instanceof Uint32Array ? idx : Uint32Array.from(idx);

    // 큰 메시만 단순화.
    if (decimate && idx32.length / 3 > minTris) {
      const target = Math.max(3, Math.floor((idx32.length * ratio) / 3) * 3);
      try {
        const [simpIdx] = MeshoptSimplifier.simplify(idx32, verts, 3, target, targetError, ['LockBorder']);
        if (simpIdx && simpIdx.length >= 3 && simpIdx.length < idx32.length) {
          const c = compact(simpIdx, verts, normals);
          verts = c.verts; normals = c.normals; idx32 = c.idx;
          decimated++;
        }
      } catch {
        /* 단순화 실패 시 원본 사용 */
      }
    }

    const nv = verts.length / 3;
    const m = matrixOf(node.transform);
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const db = new Float32Array(nv);
    const g = groupOf(node.material ?? -1);

    for (let v = 0; v < nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) {
        ox = m[0] * x + m[4] * y + m[8] * z + m[12];
        oy = m[1] * x + m[5] * y + m[9] * z + m[13];
        oz = m[2] * x + m[6] * y + m[10] * z + m[14];
      } else { ox = x; oy = y; oz = z; }
      pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;
      let nx = 0, ny = 0, nz = 1;
      if (normals) {
        const a = normals[v * 3], b = normals[v * 3 + 1], c = normals[v * 3 + 2];
        if (m) { nx = m[0] * a + m[4] * b + m[8] * c; ny = m[1] * a + m[5] * b + m[9] * c; nz = m[2] * a + m[6] * b + m[10] * c; }
        else { nx = a; ny = b; nz = c; }
        const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      }
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
      db[v] = node.dbid;
    }
    const reidx = new Uint32Array(idx32.length);
    for (let k = 0; k < idx32.length; k++) reidx[k] = idx32[k] + g.base;
    g.posCh.push(pos); g.nrmCh.push(nrm); g.dbCh.push(db); g.idxCh.push(reidx);
    g.base += nv; g.vtx += nv; g.idxN += reidx.length;

    if (++processed % 50000 === 0) log(`[merge]   ${processed} 객체 (단순화 ${decimated})`);
  }
  log(`[merge] 프래그먼트 ${fragCount} · 재질그룹 ${groups.size} · 단순화 ${decimated} · 선 ${lineFrag} · 점 ${pointFrag}`);

  // 청크 → 그룹별 연속 배열로 합치고 glTF/GLB 작성.
  const concatF = (chunks, total) => { const out = new Float32Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };
  const concatU = (chunks, total) => { const out = new Uint32Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };

  const bufferViews = [], accessors = [], meshes = [], materials = [], nodes = [], pieces = [];
  let byteOffset = 0, totalV = 0;
  const addView = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    pieces.push(buf); byteOffset += buf.length; return bufferViews.length - 1;
  };

  for (const [matId, g] of groups) {
    if (g.vtx === 0) continue;
    const pos = concatF(g.posCh, g.vtx * 3); g.posCh.length = 0;
    const nrm = concatF(g.nrmCh, g.vtx * 3); g.nrmCh.length = 0;
    const dbid = concatF(g.dbCh, g.vtx); g.dbCh.length = 0;
    const idxA = concatU(g.idxCh, g.idxN); g.idxCh.length = 0;
    totalV += g.vtx;

    const posView = addView(pos, 34962);
    const posAcc = accessors.push({ bufferView: posView, componentType: 5126, count: g.vtx, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const nrmAcc = accessors.push({ bufferView: addView(nrm, 34962), componentType: 5126, count: g.vtx, type: 'VEC3' }) - 1;
    const dbAcc = accessors.push({ bufferView: addView(dbid, 34962), componentType: 5126, count: g.vtx, type: 'SCALAR' }) - 1;
    const idxAcc = accessors.push({ bufferView: addView(idxA, 34963), componentType: 5125, count: idxA.length, type: 'SCALAR' }) - 1;

    const mat = imf.getMaterial(matId);
    const d = mat?.diffuse;
    const baseColor = d ? [d.x, d.y, d.z, mat?.opacity ?? 1] : [0.72, 0.74, 0.77, 1];
    // 원본 재질의 metallic/roughness 를 그대로 반영(예전엔 0/0.9 로 하드코딩해 금속 등이
    // 무광 플라스틱처럼 보였다). 값 없으면 비금속 기본값.
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: baseColor,
        metallicFactor: mat?.metallic ?? 0,
        roughnessFactor: mat?.roughness ?? 0.9,
      },
      doubleSided: true,
      ...(baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}),
    });
    meshes.push({ primitives: [{ mode: 4, attributes: { POSITION: posAcc, NORMAL: nrmAcc, _DBID: dbAcc }, indices: idxAcc, material: materials.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1 });
  }

  // 선(line) 그룹 → mode:1 프리미티브(법선 없음). DWG 선형이 보이게 된다.
  for (const [matId, g] of lineGroups) {
    if (g.vtx === 0) continue;
    const pos = concatF(g.posCh, g.vtx * 3); g.posCh.length = 0;
    const dbid = concatF(g.dbCh, g.vtx); g.dbCh.length = 0;
    const idxA = concatU(g.idxCh, g.idxN); g.idxCh.length = 0;
    totalV += g.vtx;

    const posAcc = accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: g.vtx, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const dbAcc = accessors.push({ bufferView: addView(dbid, 34962), componentType: 5126, count: g.vtx, type: 'SCALAR' }) - 1;
    const idxAcc = accessors.push({ bufferView: addView(idxA, 34963), componentType: 5125, count: idxA.length, type: 'SCALAR' }) - 1;

    const mat = imf.getMaterial(matId);
    const d = mat?.diffuse;
    const baseColor = d ? [d.x, d.y, d.z, mat?.opacity ?? 1] : [0.1, 0.12, 0.16, 1];
    materials.push({ pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: 1 }, ...(baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}) });
    meshes.push({ primitives: [{ mode: 1, attributes: { POSITION: posAcc, _DBID: dbAcc }, indices: idxAcc, material: materials.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1 });
  }

  // 점(point) 그룹 → mode:0 프리미티브(인덱스 없음).
  for (const [matId, g] of pointGroups) {
    if (g.vtx === 0) continue;
    const pos = concatF(g.posCh, g.vtx * 3); g.posCh.length = 0;
    const dbid = concatF(g.dbCh, g.vtx); g.dbCh.length = 0;
    totalV += g.vtx;

    const posAcc = accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: g.vtx, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const dbAcc = accessors.push({ bufferView: addView(dbid, 34962), componentType: 5126, count: g.vtx, type: 'SCALAR' }) - 1;
    const mat = imf.getMaterial(matId);
    const d = mat?.diffuse;
    const baseColor = d ? [d.x, d.y, d.z, mat?.opacity ?? 1] : [0.1, 0.12, 0.16, 1];
    materials.push({ pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: 1 } });
    meshes.push({ primitives: [{ mode: 0, attributes: { POSITION: posAcc, _DBID: dbAcc }, material: materials.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1 });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'mir-merge-glb' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: byteOffset }],
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const total = 12 + 8 + jsonChunkLen + 8 + byteOffset;
  const fd = fs.openSync(opts.outPath, 'w');
  const head = Buffer.alloc(20);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonChunkLen, 12); head.writeUInt32LE(0x4e4f534a, 16);
  fs.writeSync(fd, head);
  fs.writeSync(fd, jsonBuf);
  if (jsonPad) fs.writeSync(fd, Buffer.alloc(jsonPad, 0x20));
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(byteOffset, 0); binHead.writeUInt32LE(0x004e4942, 4);
  fs.writeSync(fd, binHead);
  for (const piece of pieces) fs.writeSync(fd, piece);
  fs.closeSync(fd);

  return { glbPath: opts.outPath, bytes: total, groups: nodes.length, vertices: totalV, decimated };
}
