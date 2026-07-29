// DXF → GLB (자체 DWG 파이프라인 · SVF 미경유). LibreDWG 가 만든 DXF 를 파싱해 '진짜 객체'
// (선·폴리선·호·원·블록)를 렌더용 선분으로 굽는다. SVF 테셀레이션과 달리:
//  · 호/원을 우리가 매끈하게 테셀레이션(각짐 최소).
//  · 레이어 색상 그대로. 선종류(대시)는 대시 구간만 방출해 표현.
//  · 측량좌표 → 로컬 원점 상대좌표(Float32 정밀도 보존).
// 출력: out/model.glb (mode:1 라인, 색상별 그룹) + out/focus.json.
import fs from 'node:fs';
import DxfParser from 'dxf-parser';

const dxfPath = process.argv[2] || 'out/original.dxf';
const outGlb = process.argv[3] || 'out/model.glb';
const log = (...a) => console.log('[dxf2glb]', ...a);

// ---- AutoCAD ACI(색인) → RGB : 표준 256색 팔레트 전체(index 0~255) ----
// Civil3D 도면은 레이어색이 팔레트 전 구간(10~249: 24색상×명도)에 흩어져 있어, 일부만
// 있으면 대부분 회색으로 뭉개진다. 전체 표준 팔레트를 넣어 각 레이어 고유색을 살린다.
const ACI_HEX = [
  0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x414141, 0x808080,
  0xff0000, 0xffaaaa, 0xbd0000, 0xbd7e7e, 0x810000, 0x815656, 0x680000, 0x684545, 0x4f0000, 0x4f3535,
  0xff3f00, 0xffbfaa, 0xbd2e00, 0xbd8d7e, 0x811f00, 0x816056, 0x681900, 0x684e45, 0x4f1300, 0x4f3b35,
  0xff7f00, 0xffd4aa, 0xbd5e00, 0xbd9d7e, 0x814000, 0x816b56, 0x683400, 0x685645, 0x4f2700, 0x4f4235,
  0xffbf00, 0xffeaaa, 0xbd8d00, 0xbdad7e, 0x816000, 0x817656, 0x684e00, 0x685f45, 0x4f3b00, 0x4f4935,
  0xffff00, 0xffffaa, 0xbdbd00, 0xbdbd7e, 0x818100, 0x818156, 0x686800, 0x686845, 0x4f4f00, 0x4f4f35,
  0xbfff00, 0xeaffaa, 0x8dbd00, 0xadbd7e, 0x608100, 0x768156, 0x4e6800, 0x5f6845, 0x3b4f00, 0x494f35,
  0x7fff00, 0xd4ffaa, 0x5ebd00, 0x9dbd7e, 0x408100, 0x6b8156, 0x346800, 0x566845, 0x274f00, 0x424f35,
  0x3fff00, 0xbfffaa, 0x2ebd00, 0x8dbd7e, 0x1f8100, 0x608156, 0x196800, 0x4e6845, 0x134f00, 0x3b4f35,
  0x00ff00, 0xaaffaa, 0x00bd00, 0x7ebd7e, 0x008100, 0x568156, 0x006800, 0x456845, 0x004f00, 0x354f35,
  0x00ff3f, 0xaaffbf, 0x00bd2e, 0x7ebd8d, 0x00811f, 0x568160, 0x006819, 0x45684e, 0x004f13, 0x354f3b,
  0x00ff7f, 0xaaffd4, 0x00bd5e, 0x7ebd9d, 0x008140, 0x56816b, 0x006834, 0x456856, 0x004f27, 0x354f42,
  0x00ffbf, 0xaaffea, 0x00bd8d, 0x7ebdad, 0x008160, 0x568176, 0x00684e, 0x45685f, 0x004f3b, 0x354f49,
  0x00ffff, 0xaaffff, 0x00bdbd, 0x7ebdbd, 0x008181, 0x568181, 0x006868, 0x456868, 0x004f4f, 0x354f4f,
  0x00bfff, 0xaaeaff, 0x008dbd, 0x7eadbd, 0x006081, 0x567681, 0x004e68, 0x455f68, 0x003b4f, 0x35494f,
  0x007fff, 0xaad4ff, 0x005ebd, 0x7e9dbd, 0x004081, 0x566b81, 0x003468, 0x455668, 0x00274f, 0x35424f,
  0x003fff, 0xaabfff, 0x002ebd, 0x7e8dbd, 0x001f81, 0x566081, 0x001968, 0x454e68, 0x00134f, 0x353b4f,
  0x0000ff, 0xaaaaff, 0x0000bd, 0x7e7ebd, 0x000081, 0x565681, 0x000068, 0x454568, 0x00004f, 0x35354f,
  0x3f00ff, 0xbfaaff, 0x2e00bd, 0x8d7ebd, 0x1f0081, 0x605681, 0x190068, 0x4e4568, 0x13004f, 0x3b354f,
  0x7f00ff, 0xd4aaff, 0x5e00bd, 0x9d7ebd, 0x400081, 0x6b5681, 0x340068, 0x564568, 0x27004f, 0x42354f,
  0xbf00ff, 0xeaaaff, 0x8d00bd, 0xad7ebd, 0x600081, 0x765681, 0x4e0068, 0x5f4568, 0x3b004f, 0x49354f,
  0xff00ff, 0xffaaff, 0xbd00bd, 0xbd7ebd, 0x810081, 0x815681, 0x680068, 0x684568, 0x4f004f, 0x4f354f,
  0xff00bf, 0xffaaea, 0xbd008d, 0xbd7ead, 0x810060, 0x815676, 0x68004e, 0x68455f, 0x4f003b, 0x4f3549,
  0xff007f, 0xffaad4, 0xbd005e, 0xbd7e9d, 0x810040, 0x81566b, 0x680034, 0x684556, 0x4f0027, 0x4f3542,
  0xff003f, 0xffaabf, 0xbd002e, 0xbd7e8d, 0x81001f, 0x815660, 0x680019, 0x68454e, 0x4f0013, 0x4f353b,
  0x333333, 0x505050, 0x696969, 0x828282, 0x9b9b9b, 0xb4b4b4,
];
function aciToRgb(i) {
  const h = ACI_HEX[i] ?? ACI_HEX[7]; // 범위 밖 → 흰색(7)
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

const t0 = Date.now();
log('DXF 읽는 중', dxfPath, (fs.statSync(dxfPath).size / 1e6).toFixed(1), 'MB');
const dxf = new DxfParser().parseSync(fs.readFileSync(dxfPath, 'utf8'));
log('파싱 완료', ((Date.now() - t0) / 1000).toFixed(1), 's · 엔티티', dxf.entities?.length ?? 0, '· 블록', Object.keys(dxf.blocks || {}).length);

const layers = dxf.tables?.layer?.layers || {};
function rgb01(rgb) { return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]; }
function colorOf(ent) {
  // 엔티티 색 우선(트루컬러 ent.color = 0xRRGGBB), 없으면 레이어색, 그것도 없으면 흰.
  if (typeof ent.color === 'number' && ent.color >= 0) {
    const c = ent.color; return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255];
  }
  if (typeof ent.colorIndex === 'number' && ent.colorIndex > 0 && ent.colorIndex < 256) return rgb01(aciToRgb(ent.colorIndex));
  const l = layers[ent.layer];
  if (l) {
    if (typeof l.color === 'number' && l.color >= 0) { const c = l.color; return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]; }
    if (typeof l.colorIndex === 'number') return rgb01(aciToRgb(Math.abs(l.colorIndex)));
  }
  return [0.85, 0.85, 0.85];
}

// ---- 색상별 선분 누적(로컬 원점 상대좌표) ----
// xeokit 는 line(mode:1) 을 정점 65,535개까지만 렌더 → 60k 버킷으로 쪼갠다. 폭주 방지 캡.
let ORIGIN = null;
const MAX_SEG = 15_000_000, BUCKET = 60000;
const bucketOf = new Map(); // colorKey -> 현재(안 찬) 버킷
const allGroups = [];        // [{ color, pos:number[] }]
let segCount = 0;
function seg(x1, y1, x2, y2, color) {
  if (segCount >= MAX_SEG) return;
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
  if (x1 === x2 && y1 === y2) return;
  if (!ORIGIN) ORIGIN = [Math.round(x1), Math.round(y1)];
  // 원점에서 500km 넘게 튀는 선분은 폭주/불량 데이터 → 제외(도면은 보통 수 km).
  if (Math.abs(x1 - ORIGIN[0]) > 500000 || Math.abs(y1 - ORIGIN[1]) > 500000 ||
      Math.abs(x2 - ORIGIN[0]) > 500000 || Math.abs(y2 - ORIGIN[1]) > 500000) return;
  const key = color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 8)).join('_');
  let g = bucketOf.get(key);
  if (!g || g.pos.length / 3 + 2 > BUCKET) { g = { color, pos: [] }; bucketOf.set(key, g); allGroups.push(g); }
  g.pos.push(x1 - ORIGIN[0], y1 - ORIGIN[1], 0, x2 - ORIGIN[0], y2 - ORIGIN[1], 0);
  segCount++;
}

// 2D 아핀 변환(블록 인스턴스용): {a,b,c,d,e,f} → x'=a*x+c*y+e, y'=b*x+d*y+f
const ID = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
function compose(m, n) { // m∘n (먼저 n, 다음 m)
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  };
}
function insertMatrix(ins) {
  const px = ins.position?.x ?? 0, py = ins.position?.y ?? 0;
  const sx = ins.xScale ?? 1, sy = ins.yScale ?? 1;
  const rot = (ins.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // scale → rotate → translate
  return { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, e: px, f: py };
}

function arcSegs(cx, cy, r, a0, a1, m, color) {
  if (!Number.isFinite(r) || r <= 0 || r > 100000) return; // 100km 초과 반경 = 불량/폭주 → 제외
  // a0,a1 도(degree). 반시계로 a0→a1. 반경 인지 테셀레이션: 현(chord) 오차를 반경의 ~1%로
  // 제한 → 작은 원(점마커 등)은 몇 분할만. (고정 3°/최대 256분할은 원 하나에 120분할 →
  // 수천 개면 정점 폭증·심한 렉.)
  let span = a1 - a0; while (span <= 0) span += 360;
  const spanRad = span * Math.PI / 180;
  const tol = Math.max(r * 0.01, 1e-4);
  const stepRad = 2 * Math.acos(Math.max(0, 1 - Math.min(1, tol / r)));
  const n = Math.max(2, Math.min(128, stepRad > 1e-6 ? Math.ceil(spanRad / stepRad) : 2));
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const ang = (a0 + span * i / n) * Math.PI / 180;
    const [x, y] = apply(m, cx + r * Math.cos(ang), cy + r * Math.sin(ang));
    if (prev) seg(prev[0], prev[1], x, y, color);
    prev = [x, y];
  }
}

let counts = {};
const circLayers = {}; // 진단: CIRCLE/ARC 가 어느 레이어에 몰려있나(잔여 원 잡음 추적용)
function emit(ent, m, depth = 0) {
  if (!ent || depth > 8) return;
  counts[ent.type] = (counts[ent.type] || 0) + 1;
  if (ent.type === 'CIRCLE' || ent.type === 'ARC') circLayers[ent.layer] = (circLayers[ent.layer] || 0) + 1;
  const color = colorOf(ent);
  switch (ent.type) {
    case 'LINE': {
      const s = ent.vertices?.[0] ?? ent.start, e = ent.vertices?.[1] ?? ent.end;
      if (!s || !e) break;
      const [x1, y1] = apply(m, s.x, s.y), [x2, y2] = apply(m, e.x, e.y);
      seg(x1, y1, x2, y2, color); break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const vs = ent.vertices || [];
      for (let i = 0; i < vs.length - 1; i++) polySeg(vs[i], vs[i + 1], m, color);
      if (ent.shape || ent.closed) if (vs.length > 2) polySeg(vs[vs.length - 1], vs[0], m, color);
      break;
    }
    case 'ARC': {
      arcSegs(ent.center.x, ent.center.y, ent.radius, ent.startAngle * 180 / Math.PI, ent.endAngle * 180 / Math.PI, m, color);
      break;
    }
    case 'CIRCLE': {
      arcSegs(ent.center.x, ent.center.y, ent.radius, 0, 360, m, color);
      break;
    }
    case 'INSERT': {
      const blk = dxf.blocks?.[ent.name];
      if (!blk?.entities) break;
      const bm = compose(m, insertMatrix(ent));
      const bx = blk.position?.x ?? 0, by = blk.position?.y ?? 0;
      const bm2 = compose(bm, { a: 1, b: 0, c: 0, d: 1, e: -bx, f: -by });
      for (const be of blk.entities) emit(be, bm2, depth + 1);
      break;
    }
    // TEXT/MTEXT/HATCH: v2 에서(문자 스트로크·해치 채움).
    default: break;
  }
}
// 폴리선 세그먼트(bulge=호 지원): startAngle/endAngle 대신 bulge 로 원호 근사.
// bulge = tan(θ/4), θ=포함각(부호: +반시계/−시계), 호는 v1→v2.
function polySeg(v1, v2, m, color) {
  const b = v1.bulge || 0;
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const chord = Math.hypot(dx, dy); if (chord < 1e-9) return;
  const straight = () => { const [x1, y1] = apply(m, v1.x, v1.y), [x2, y2] = apply(m, v2.x, v2.y); seg(x1, y1, x2, y2, color); };
  // 아주 작은 bulge = 사실상 직선. 그 이하를 원호로 풀면 반경이 폭주(거대 원)한다.
  if (Math.abs(b) < 0.02) { straight(); return; }
  const r = Math.abs(chord / (2 * Math.sin(2 * Math.atan(b)))); // |반경|
  if (!Number.isFinite(r) || r > chord * 400) { straight(); return; }
  const mx = (v1.x + v2.x) / 2, my = (v1.y + v2.y) / 2;
  // 중심 = 중점 + (부호있는 apothem)·(왼쪽 수직단위). apothem=(현/2)·cot(θ/2)=(현/2)·(1−b²)/(2b).
  // b 부호가 apothem 부호로 자동 반영돼 호가 올바른 쪽으로 그려진다(기존엔 반대편→여각 원호).
  const apothem = (chord / 2) * (1 - b * b) / (2 * b);
  const nx = -dy / chord, ny = dx / chord;
  const cx = mx + apothem * nx, cy = my + apothem * ny;
  let a0 = Math.atan2(v1.y - cy, v1.x - cx) * 180 / Math.PI;
  let a1 = Math.atan2(v2.y - cy, v2.x - cx) * 180 / Math.PI;
  if (b < 0) [a0, a1] = [a1, a0]; // 시계방향 호 → arcSegs(반시계) 로 뒤집어 그림
  arcSegs(cx, cy, r, a0, a1, m, color);
}

let bad = 0;
for (const ent of dxf.entities || []) { try { emit(ent, ID); } catch { bad++; } }
if (segCount >= MAX_SEG) log('⚠ 선분 캡 도달 — 일부 생략');
log('선분', segCount.toLocaleString(), '· 그룹', allGroups.length, '· 오류엔티티', bad, '· 종류', JSON.stringify(counts));
const topCirc = Object.entries(circLayers).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (topCirc.length) log('원/호 상위 레이어:', topCirc.map(([n, c]) => `${n}=${c}`).join(', '));

// ---- GLB 작성(mode:1 라인, 색상별 재질) ----
const bufferViews = [], accessors = [], meshes = [], materials = [], nodes = [], pieces = [];
let byteOffset = 0;
const addView = (typed, target) => {
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
  pieces.push(buf); byteOffset += buf.length; return bufferViews.length - 1;
};
const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
for (const g of allGroups) {
  const cnt = g.pos.length / 3; if (cnt === 0) continue;
  const pos = Float32Array.from(g.pos);
  const idx = new Uint32Array(cnt); for (let i = 0; i < cnt; i++) idx[i] = i;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cnt; i++) for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; if (v < gmin[k]) gmin[k] = v; if (v > gmax[k]) gmax[k] = v; }
  const posAcc = accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: cnt, type: 'VEC3', min: mn, max: mx }) - 1;
  const idxAcc = accessors.push({ bufferView: addView(idx, 34963), componentType: 5125, count: cnt, type: 'SCALAR' }) - 1;
  materials.push({ pbrMetallicRoughness: { baseColorFactor: [g.color[0], g.color[1], g.color[2], 1], metallicFactor: 0, roughnessFactor: 1 } });
  meshes.push({ primitives: [{ mode: 1, attributes: { POSITION: posAcc }, indices: idxAcc, material: materials.length - 1 }] });
  nodes.push({ mesh: meshes.length - 1 });
}
while (byteOffset % 4 !== 0) { pieces.push(Buffer.from([0])); byteOffset++; }
const bin = Buffer.concat(pieces);
const gltf = {
  asset: { version: '2.0', generator: 'mir-dxf2glb' },
  scenes: [{ nodes: nodes.map((_, i) => i) }], scene: 0, nodes, meshes, materials, accessors, bufferViews,
  buffers: [{ byteLength: bin.length }],
};
const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const binPad = (4 - (bin.length % 4)) % 4;
const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;
const out = Buffer.alloc(total); let o = 0;
out.write('glTF', o); o += 4; out.writeUInt32LE(2, o); o += 4; out.writeUInt32LE(total, o); o += 4;
out.writeUInt32LE(jsonBuf.length + jsonPad, o); o += 4; out.write('JSON', o); o += 4;
jsonBuf.copy(out, o); o += jsonBuf.length; for (let i = 0; i < jsonPad; i++) out[o++] = 0x20;
out.writeUInt32LE(bin.length + binPad, o); o += 4; out.write('BIN\0', o); o += 4;
bin.copy(out, o); o += bin.length;
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync(outGlb, out);
log('GLB 완료', outGlb, (out.length / 1e6).toFixed(1), 'MB · 노드', nodes.length);

// focus(밀집영역): 간단히 bbox 중심/반. ORIGIN 상대. (SVF 경로와 동일 포맷)
const cx = (gmin[0] + gmax[0]) / 2, cy = (gmin[1] + gmax[1]) / 2, cz = 0;
const hx = (gmax[0] - gmin[0]) / 2, hy = (gmax[1] - gmin[1]) / 2;
fs.writeFileSync('out/focus.json', JSON.stringify({ center: [cx, cy, cz], half: [hx, hy, Math.max(1, Math.min(hx, hy) * 0.1)] }));
log('focus.json 완료 · bbox(상대) min', gmin.map((v) => v.toFixed(0)), 'max', gmax.map((v) => v.toFixed(0)));
