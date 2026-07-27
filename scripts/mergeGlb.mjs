// =====================================================================
// 병합 GLB 빌더 — svf-utils IMF 장면을 "(재질 + 정점색)별 소수 메시"로 병합하고 각
// 정점에 dbId(_DBID)를 심어 단일 GLB 로 만든다. 거대 모델은 큰 메시를 meshoptimizer 로
// 단순화(decimation)해 정점·메모리를 급감시켜 브라우저가 감당하게 한다.
//   - 객체-당-노드(수십만 노드) → glTF JSON 512MB 한계 회피(노드=재질 수준).
//   - 큰 Civil 3D 솔리드 단순화 → 정점 1억 → 수백만, GLB 수백 MB → 데스크톱 로드 가능.
//   - 단일 패스 + 그룹별 청크 누적(메모리 피크 최소화 → OOM 회피).
// 색: DWG 등은 재질(diffuse)이 흰색이고 실제 색(ACI 색상)이 **정점색**(getColors)에
//   실려 온다. xeokit GLTFLoaderPlugin 은 정점색(COLOR_0)을 렌더하지 않으므로, 프래그
//   먼트의 대표 정점색을 재질 baseColor 로 승격시켜 "(재질,색) 조합"별로 그룹핑한다.
// 런타임(자체 뷰어)은 _DBID 로 객체별 시공/철거/미시공을 셰이더로 표현.
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

// 프래그먼트의 대표 정점색(0~1 RGBA). 프래그먼트는 대개 단색(엔티티 1개 = ACI 색 1개)
// 이므로 평균으로 충분. 색이 없으면 null. channels=3(선/점) 또는 4(메시).
function fragColor(raw, nv, channels) {
  if (!raw || nv <= 0 || raw.length < nv * channels) return null;
  let r = 0, g = 0, b = 0, a = 0;
  for (let v = 0; v < nv; v++) {
    r += raw[v * channels]; g += raw[v * channels + 1]; b += raw[v * channels + 2];
    a += channels === 4 ? raw[v * channels + 3] : 1;
  }
  return [r / nv, g / nv, b / nv, a / nv];
}
// (재질, 대표색) 조합을 그룹 키로. 색 없으면 재질 단독.
function groupKey(matId, color) {
  if (!color) return `m${matId}`;
  const q = color.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  return `m${matId}#${q[0]}_${q[1]}_${q[2]}_${q[3]}`;
}

// 카메라 초점 박스 {center, half}. 축별로 '지오메트리 가중치의 85% 를 담는 가장 좁은
// 구간'을 찾아(2-포인터) 밀집 영역에 맞춘다. 멀리 흩어진 소수(타이틀블록·측량 격자·
// 측점 등)를 제외 → flyTo 가 빈 공간/전 구간을 맞춰 모델이 콩알처럼 보이던 문제 방지.
// 실좌표(회전 전) 기준.
function robustFocus(foci) {
  if (!foci.length) return null;
  const total = foci.reduce((s, f) => s + f.w, 0);
  const need = total * 0.85;
  const axis = (i) => {
    const arr = foci.map((f) => ({ v: f.c[i], w: f.w })).sort((a, b) => a.v - b.v);
    let lo = 0, acc = 0, bestW = Infinity, bestLo = 0, bestHi = arr.length - 1;
    for (let hi = 0; hi < arr.length; hi++) {
      acc += arr[hi].w;
      while (acc - arr[lo].w >= need) { acc -= arr[lo].w; lo++; }
      if (acc >= need) {
        const w = arr[hi].v - arr[lo].v;
        if (w < bestW) { bestW = w; bestLo = lo; bestHi = hi; }
      }
    }
    const a = arr[bestLo].v, b = arr[bestHi].v;
    // 초점은 중심점 분포 → 부재 크기만큼 여유(15%+최소치)를 둔다.
    return { center: (a + b) / 2, half: Math.max((b - a) / 2 * 1.15, 0.5) };
  };
  const fx = axis(0), fy = axis(1), fz = axis(2);
  return { center: [fx.center, fy.center, fz.center], half: [fx.half, fy.half, fz.half] };
}

export async function buildMergedGlb(imf, opts) {
  const log = opts.log || (() => {});
  const decimate = process.env.DECIMATE !== '0';
  const ratio = Number(process.env.DECIMATE_RATIO || 0.2); // 큰 메시를 이 비율로 축소
  const minTris = Number(process.env.DECIMATE_MIN_TRIS || 1000); // 이 삼각형 수 초과만 단순화
  const targetError = Number(process.env.DECIMATE_ERROR || 1e3);
  if (decimate) await MeshoptSimplifier.ready;

  const nodeCount = imf.getNodeCount();
  // 프래그먼트별 중심점(가중=정점수) — 카메라 초점(focus) 계산용. DWG 등은 원점의 타이틀블록
  // + 실측좌표의 도면처럼 **멀리 떨어진 이상치**가 섞여 전체 AABB 가 거대해지면 flyTo 가 빈
  // 공간을 맞춰 모델이 콩알처럼 보인다. 중심점 분위수(1~99%)로 이상치를 뺀 초점을 구워둔다.
  const foci = [];
  // 전체 실제 좌표 범위(진단 로그용).
  const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
  const bump = (x, y, z) => {
    if (x < gmin[0]) gmin[0] = x; if (y < gmin[1]) gmin[1] = y; if (z < gmin[2]) gmin[2] = z;
    if (x > gmax[0]) gmax[0] = x; if (y > gmax[1]) gmax[1] = y; if (z > gmax[2]) gmax[2] = z;
  };
  // 그룹((재질,색))별 청크 누적. key -> { matId, color, posCh, nrmCh, dbCh, idxCh, ... }
  const groups = new Map();
  const groupOf = (matId, color) => {
    const key = groupKey(matId, color);
    let g = groups.get(key);
    if (!g) {
      g = { matId, color, posCh: [], nrmCh: [], dbCh: [], idxCh: [], base: 0, vtx: 0, idxN: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      groups.set(key, g);
    }
    return g;
  };

  // 선(line) 전용 그룹 — 삼각형과 프리미티브 모드가 달라(1 vs 4) 분리 누적. 법선 없음.
  // DWG/도면·선형이 여기로 들어간다(예전엔 통째로 버려서 DWG 가 안 보였음).
  const lineGroups = new Map();
  const lineGroupOf = (matId, color) => {
    const key = groupKey(matId, color);
    let g = lineGroups.get(key);
    if (!g) {
      g = { matId, color, posCh: [], dbCh: [], idxCh: [], base: 0, vtx: 0, idxN: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      lineGroups.set(key, g);
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
    const g = lineGroupOf(node.material ?? -1, fragColor(geom.getColors?.(), nv, 3));
    let sx = 0, sy = 0, sz = 0;
    for (let v = 0; v < nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) { ox = m[0] * x + m[4] * y + m[8] * z + m[12]; oy = m[1] * x + m[5] * y + m[9] * z + m[13]; oz = m[2] * x + m[6] * y + m[10] * z + m[14]; }
      else { ox = x; oy = y; oz = z; }
      pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;
      sx += ox; sy += oy; sz += oz;
      db[v] = node.dbid;
    }
    bump(g.min[0], g.min[1], g.min[2]); bump(g.max[0], g.max[1], g.max[2]);
    foci.push({ c: [sx / nv, sy / nv, sz / nv], w: nv });
    const reidx = new Uint32Array(idx32.length);
    for (let k = 0; k < idx32.length; k++) reidx[k] = idx32[k] + g.base;
    g.posCh.push(pos); g.dbCh.push(db); g.idxCh.push(reidx);
    g.base += nv; g.vtx += nv; g.idxN += reidx.length;
  };

  // 점(point) 전용 그룹 — mode:0(POINTS), 인덱스 없음.
  const pointGroups = new Map();
  const pointGroupOf = (matId, color) => {
    const key = groupKey(matId, color);
    let g = pointGroups.get(key);
    if (!g) {
      g = { matId, color, posCh: [], dbCh: [], vtx: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      pointGroups.set(key, g);
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
    const g = pointGroupOf(node.material ?? -1, fragColor(geom.getColors?.(), nv, 3));
    let sx = 0, sy = 0, sz = 0;
    for (let v = 0; v < nv; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      let ox, oy, oz;
      if (m) { ox = m[0] * x + m[4] * y + m[8] * z + m[12]; oy = m[1] * x + m[5] * y + m[9] * z + m[13]; oz = m[2] * x + m[6] * y + m[10] * z + m[14]; }
      else { ox = x; oy = y; oz = z; }
      pos[v * 3] = ox; pos[v * 3 + 1] = oy; pos[v * 3 + 2] = oz;
      if (ox < g.min[0]) g.min[0] = ox; if (oy < g.min[1]) g.min[1] = oy; if (oz < g.min[2]) g.min[2] = oz;
      if (ox > g.max[0]) g.max[0] = ox; if (oy > g.max[1]) g.max[1] = oy; if (oz > g.max[2]) g.max[2] = oz;
      sx += ox; sy += oy; sz += oz;
      db[v] = node.dbid;
    }
    bump(g.min[0], g.min[1], g.min[2]); bump(g.max[0], g.max[1], g.max[2]);
    foci.push({ c: [sx / nv, sy / nv, sz / nv], w: nv });
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
    // 대표 정점색은 단순화 전 원본에서(메시 색은 RGBA=정점당 4). DWG 등의 실제 색.
    const color = fragColor(geom.getColors?.(), verts.length / 3, 4);

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
    const g = groupOf(node.material ?? -1, color);

    let sx = 0, sy = 0, sz = 0;
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
      sx += ox; sy += oy; sz += oz;
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
    bump(g.min[0], g.min[1], g.min[2]); bump(g.max[0], g.max[1], g.max[2]);
    foci.push({ c: [sx / nv, sy / nv, sz / nv], w: nv });
    const reidx = new Uint32Array(idx32.length);
    for (let k = 0; k < idx32.length; k++) reidx[k] = idx32[k] + g.base;
    g.posCh.push(pos); g.nrmCh.push(nrm); g.dbCh.push(db); g.idxCh.push(reidx);
    g.base += nv; g.vtx += nv; g.idxN += reidx.length;

    if (++processed % 50000 === 0) log(`[merge]   ${processed} 객체 (단순화 ${decimated})`);
  }
  // 솔리드(삼각형) 부재가 하나라도 있으면 선/점은 대개 엣지/주석 클러터(IFC 의 와이어프레임
  // 11만개 등) → 제외. 순수 선형(솔리드 0 = DWG 도면)만 선/점 유지. 정점수 비율은 엣지선이
  // 많아 오판하므로 '솔리드 존재 여부'로 판단. INCLUDE_LINES=1 로 강제 포함 가능.
  const includeLines = process.env.INCLUDE_LINES === '1' || fragCount === 0;
  const colGroups = [...groups.values(), ...lineGroups.values(), ...pointGroups.values()].filter((g) => g.color).length;
  log(`[merge] 프래그먼트 ${fragCount} · 재질그룹 ${groups.size} · 단순화 ${decimated} · 선 ${lineFrag} · 점 ${pointFrag} · 선/점포함 ${includeLines} · 색그룹 ${colGroups}`);
  const focus = robustFocus(foci);
  const fmt = (a) => a.map((x) => (Number.isFinite(x) ? x.toFixed(1) : x)).join(',');
  const span = gmax.map((v, i) => v - gmin[i]);
  log(`[merge] bbox min=(${fmt(gmin)}) max=(${fmt(gmax)}) span=(${fmt(span)})`);
  if (focus) log(`[merge] focus center=(${fmt(focus.center)}) half=(${fmt(focus.half)})`);

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

  // 그룹의 baseColor: 대표 정점색이 있으면 그 색(DWG ACI/레이어색 등), 없으면 재질
  // diffuse, 그것도 없으면 포맷별 기본색. 선/점은 SVF 원색을 그대로 보존한다(레이어 색을
  // 뭉개지 않음). 흰 색상7 선은 어두운 배경에서 CAD 처럼 흰색으로 보인다.
  const baseColorOf = (g, fallback) => {
    if (g.color) return [g.color[0], g.color[1], g.color[2], g.color[3] ?? 1];
    const mat = imf.getMaterial(g.matId);
    const d = mat?.diffuse;
    return d ? [d.x, d.y, d.z, mat?.opacity ?? 1] : fallback;
  };

  for (const g of groups.values()) {
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

    const mat = imf.getMaterial(g.matId);
    const rawColor = baseColorOf(g, [0.72, 0.74, 0.77, 1]);
    // 솔리드가 순수 검정(CAD '색상7 자동'·ByLayer 미해결이 SVF 에서 흔히 검정으로 옴)이면
    // 조명을 받아도 검정이라 코리더 등이 형체 없는 검은 덩어리로 보인다 → 음영이 드러나는
    // 중립 회색으로 보정(불투명도는 유지). 선/점은 흰 배경에서 잘 보이므로 보정 안 함.
    const nearBlack = rawColor[0] < 0.06 && rawColor[1] < 0.06 && rawColor[2] < 0.06;
    const baseColor = nearBlack ? [0.55, 0.55, 0.55, rawColor[3]] : rawColor;
    // 색 진단용 로그(포맷별 재질 색이 원본과 다른지 확인).
    log(`[merge] mat ${g.matId}: rgb=(${rawColor.slice(0, 3).map((x) => (+x).toFixed(2)).join(',')}) a=${(+rawColor[3]).toFixed(2)}${nearBlack ? '→gray' : ''} metal=${mat?.metallic ?? '-'} rough=${mat?.roughness ?? '-'} vtxColor=${!!g.color}`);
    // 원본 재질의 metallic/roughness 를 그대로 반영(예전엔 0/0.9 로 하드코딩해 금속 등이
    // 무광 플라스틱처럼 보였다). 정점색으로 온 경우는 재질 정보가 없으니 비금속 기본값.
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: baseColor,
        // glTF 는 0~1 — svf-utils 가 간혹 범위 밖 값(예: roughness 15624)을 줘서 클램프한다.
        metallicFactor: g.color ? 0 : Math.min(1, Math.max(0, mat?.metallic ?? 0)),
        roughnessFactor: g.color ? 0.9 : Math.min(1, Math.max(0, mat?.roughness ?? 0.9)),
      },
      doubleSided: true,
      ...(baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}),
    });
    meshes.push({ primitives: [{ mode: 4, attributes: { POSITION: posAcc, NORMAL: nrmAcc, _DBID: dbAcc }, indices: idxAcc, material: materials.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1 });
  }

  // 선(line) 그룹 → mode:1 프리미티브(법선 없음). 솔리드 지배 모델에선 제외(클러터).
  for (const g of includeLines ? lineGroups.values() : []) {
    if (g.vtx === 0) continue;
    const pos = concatF(g.posCh, g.vtx * 3); g.posCh.length = 0;
    const dbid = concatF(g.dbCh, g.vtx); g.dbCh.length = 0;
    const idxA = concatU(g.idxCh, g.idxN); g.idxCh.length = 0;
    totalV += g.vtx;

    const posAcc = accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: g.vtx, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const dbAcc = accessors.push({ bufferView: addView(dbid, 34962), componentType: 5126, count: g.vtx, type: 'SCALAR' }) - 1;
    const idxAcc = accessors.push({ bufferView: addView(idxA, 34963), componentType: 5125, count: idxA.length, type: 'SCALAR' }) - 1;

    const baseColor = baseColorOf(g, [0.1, 0.12, 0.16, 1]);
    materials.push({ pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: 1 }, ...(baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}) });
    meshes.push({ primitives: [{ mode: 1, attributes: { POSITION: posAcc, _DBID: dbAcc }, indices: idxAcc, material: materials.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1 });
  }

  // 점(point) 그룹 → mode:0 프리미티브(인덱스 없음).
  for (const g of includeLines ? pointGroups.values() : []) {
    if (g.vtx === 0) continue;
    const pos = concatF(g.posCh, g.vtx * 3); g.posCh.length = 0;
    const dbid = concatF(g.dbCh, g.vtx); g.dbCh.length = 0;
    totalV += g.vtx;

    const posAcc = accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: g.vtx, type: 'VEC3', min: g.min, max: g.max }) - 1;
    const dbAcc = accessors.push({ bufferView: addView(dbid, 34962), componentType: 5126, count: g.vtx, type: 'SCALAR' }) - 1;
    const baseColor = baseColorOf(g, [0.1, 0.12, 0.16, 1]);
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

  return { glbPath: opts.outPath, bytes: total, groups: nodes.length, vertices: totalV, decimated, focus };
}
