// =====================================================================
// 병합 GLB 빌더 — svf-utils IMF 장면을 "재질별 소수 메시"로 병합하고 각 정점에
// dbId(_DBID 속성)를 심어 단일 GLB 로 만든다. 객체-당-노드 방식은 거대 모델에서
// glTF JSON(노드/액세서 수)이 512MB 한계를 넘어 직렬화가 불가능하므로, 노드 수를
// 재질 수 수준으로 줄여 한계를 회피하고 드로우콜도 급감시킨다(브라우저에서 가볍게).
// 런타임(자체 Three.js 뷰어)은 _DBID 로 객체를 식별해 시공/철거/미시공을 셰이더로
// 표현한다(재로딩 없이 GPU 즉시 갱신).
// =====================================================================
import fs from 'node:fs';

const NODE_OBJECT = 1; // IMF.NodeKind.Object
const GEOM_MESH = 0; // IMF.GeometryKind.Mesh
const TRANSFORM_MATRIX = 0; // IMF.TransformKind.Matrix

// Decomposed(scale/rotation/translation) → column-major 4x4.
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
  if (!transform) return null; // identity
  if (transform.kind === TRANSFORM_MATRIX && transform.elements) return transform.elements;
  return composeMatrix(transform); // Decomposed
}

/**
 * @param {*} imf  svf-utils SVFReader.read() 결과(IMF.IScene)
 * @param {*} opts { outPath: string, log?: fn }
 * @returns {{ glbPath:string, bytes:number, groups:number, vertices:number, dbids:number }}
 */
export function buildMergedGlb(imf, opts) {
  const log = opts.log || (() => {});
  const nodeCount = imf.getNodeCount();

  // ---- Pass 1: 유효 프래그먼트 수집 + 재질별 정점/인덱스 수 집계 ----
  const frags = []; // { node, geom, nv, ni, matId }
  const groupTotals = new Map(); // matId -> { nv, ni }
  for (let i = 0; i < nodeCount; i++) {
    const node = imf.getNode(i);
    if (node.kind !== NODE_OBJECT) continue;
    const geom = imf.getGeometry(node.geometry);
    if (!geom || geom.kind !== GEOM_MESH) continue;
    const verts = geom.getVertices();
    const idx = geom.getIndices();
    if (!verts || !idx || verts.length === 0 || idx.length === 0) continue;
    const nv = verts.length / 3;
    const matId = node.material ?? -1;
    frags.push({ node, geom, nv, ni: idx.length, matId });
    const g = groupTotals.get(matId) || { nv: 0, ni: 0 };
    g.nv += nv;
    g.ni += idx.length;
    groupTotals.set(matId, g);
  }
  log(`[merge] 프래그먼트 ${frags.length}개 · 재질그룹 ${groupTotals.size}개`);

  // ---- 그룹별 출력 버퍼 사전 할당(타입드 배열 = off-heap) ----
  const matIds = [...groupTotals.keys()];
  const groups = new Map(); // matId -> { pos, nrm, dbid, idx, vCursor, iCursor, baseVertex, min, max }
  for (const matId of matIds) {
    const { nv, ni } = groupTotals.get(matId);
    groups.set(matId, {
      pos: new Float32Array(nv * 3),
      nrm: new Float32Array(nv * 3),
      dbid: new Float32Array(nv),
      idx: new Uint32Array(ni),
      vCursor: 0,
      iCursor: 0,
      baseVertex: 0,
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    });
  }

  // ---- Pass 2: 변환 적용하며 그룹 버퍼 채우기 ----
  let processed = 0;
  for (const f of frags) {
    const g = groups.get(f.matId);
    const verts = f.geom.getVertices();
    const idx = f.geom.getIndices();
    const normals = f.geom.getNormals();
    const m = matrixOf(f.node.transform);
    const base = g.baseVertex;

    for (let v = 0; v < f.nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) {
        ox = m[0] * x + m[4] * y + m[8] * z + m[12];
        oy = m[1] * x + m[5] * y + m[9] * z + m[13];
        oz = m[2] * x + m[6] * y + m[10] * z + m[14];
      } else {
        ox = x; oy = y; oz = z;
      }
      const p = g.vCursor * 3;
      g.pos[p] = ox; g.pos[p + 1] = oy; g.pos[p + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;

      let nx = 0, ny = 0, nz = 1;
      if (normals) {
        const a = normals[v * 3], b = normals[v * 3 + 1], c = normals[v * 3 + 2];
        if (m) {
          nx = m[0] * a + m[4] * b + m[8] * c;
          ny = m[1] * a + m[5] * b + m[9] * c;
          nz = m[2] * a + m[6] * b + m[10] * c;
        } else { nx = a; ny = b; nz = c; }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
      }
      g.nrm[p] = nx; g.nrm[p + 1] = ny; g.nrm[p + 2] = nz;
      g.dbid[g.vCursor] = f.node.dbid;
      g.vCursor++;
    }
    for (let k = 0; k < idx.length; k++) g.idx[g.iCursor++] = idx[k] + base;
    g.baseVertex += f.nv;

    if (++processed % 50000 === 0) log(`[merge]   변환 ${processed}/${frags.length}`);
  }

  // ---- glTF JSON + 바이너리 레이아웃 ----
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const materials = [];
  const nodes = [];
  const pieces = []; // 스트리밍용: 순서대로 디스크에 쓸 타입드 배열
  let byteOffset = 0;
  let totalV = 0, totalDb = 0;

  const addView = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    pieces.push(buf);
    byteOffset += buf.length;
    return bufferViews.length - 1;
  };

  for (const matId of matIds) {
    const g = groups.get(matId);
    const nv = g.pos.length / 3;
    if (nv === 0) continue;
    totalV += nv; totalDb += nv;

    const posView = addView(g.pos, 34962);
    const posAcc = accessors.push({ bufferView: posView, componentType: 5126, count: nv, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const nrmView = addView(g.nrm, 34962);
    const nrmAcc = accessors.push({ bufferView: nrmView, componentType: 5126, count: nv, type: 'VEC3' }) - 1;
    const dbView = addView(g.dbid, 34962);
    const dbAcc = accessors.push({ bufferView: dbView, componentType: 5126, count: nv, type: 'SCALAR' }) - 1;
    const idxView = addView(g.idx, 34963);
    const idxAcc = accessors.push({ bufferView: idxView, componentType: 5125, count: g.idx.length, type: 'SCALAR' }) - 1;

    // 재질(있으면 diffuse/opacity 반영; 없으면 중립 회색).
    const m = imf.getMaterial(matId);
    const d = m?.diffuse;
    const baseColor = d ? [d.x, d.y, d.z, m?.opacity ?? 1] : [0.7, 0.72, 0.75, 1];
    materials.push({
      pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0.0, roughnessFactor: 0.9 },
      doubleSided: true,
      ...(baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}),
    });
    const matIndex = materials.length - 1;

    meshes.push({
      primitives: [{ mode: 4, attributes: { POSITION: posAcc, NORMAL: nrmAcc, _DBID: dbAcc }, indices: idxAcc, material: matIndex }],
    });
    nodes.push({ mesh: meshes.length - 1 });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'mir-merge-glb' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  // ---- GLB 스트리밍 기록(거대 바이너리라 한 번에 Buffer.alloc 회피) ----
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const binChunkLen = byteOffset; // 모든 조각이 4의 배수
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const fd = fs.openSync(opts.outPath, 'w');
  const head = Buffer.alloc(12 + 8);
  head.write('glTF', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonChunkLen, 12);
  head.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  fs.writeSync(fd, head);
  fs.writeSync(fd, jsonBuf);
  if (jsonPad) fs.writeSync(fd, Buffer.alloc(jsonPad, 0x20));
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunkLen, 0);
  binHead.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  fs.writeSync(fd, binHead);
  for (const piece of pieces) fs.writeSync(fd, piece);
  fs.closeSync(fd);

  return { glbPath: opts.outPath, bytes: total, groups: matIds.length, vertices: totalV, dbids: totalDb };
}
