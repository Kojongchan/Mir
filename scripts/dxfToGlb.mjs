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

// ---- 문자 렌더용 아웃라인 폰트(한글 포함 전 유니코드) ----
// opentype.js 로 실제 폰트 글리프 외곽선을 뽑아 선분으로 굽는다 → TEXT/MTEXT 를 한글까지
// 렌더. 폰트는 DXF_FONT 또는 러너에 설치된 나눔/노토 TTF 에서 찾는다. 없으면 라틴 내장폰트.
let OTF = null;
try {
  const opentype = (await import('opentype.js')).default;
  // loadSync 는 폐기(undefined 반환) → parse(buffer). .ttc(컬렉션)는 미지원이라 .ttf/.otf 만.
  const loadFont = (p) => { const b = fs.readFileSync(p); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const cands = [process.env.DXF_FONT,
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].filter(Boolean);
  for (const p of cands) {
    if (fs.existsSync(p)) { try { OTF = loadFont(p); log('문자 폰트 로드:', p, '· unitsPerEm', OTF.unitsPerEm); break; } catch (e) { /* 다음 후보(ttc 등 미지원) */ } }
  }
  if (!OTF) log('문자 폰트 파일 없음 → 내장 라틴 폰트 폴백(한글 미표시)');
} catch (e) { log('opentype.js 미설치 → 내장 라틴 폰트 폴백(한글 미표시)'); }

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
const lineTypes = dxf.tables?.lineType?.lineTypes || {};
const globalLtScale = Number(dxf.header?.$LTSCALE) || 1;
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

// ---- 색상별 선분 누적(로컬 원점 상대좌표, Z 보존) ----
// xeokit line(mode:1) 은 정점 65,535개까지 → 60k 버킷. 폭주 방지 캡. Z(표고)를 살려 3D 로.
let ORIGIN = null; // [x,y,z] 측량 기준(Float32 정밀도 보존)
const MAX_SEG = 15_000_000, BUCKET = 60000;
const bucketOf = new Map();
const allGroups = [];
let segCount = 0;
// 진단: '흰색' 세그먼트 추적 + 그려진 레이어별 세그먼트수/색(도면 구조 파악용).
let curType = '', curLayer = '';
const whiteSeg = {};
const perLayer = {};       // layer -> 그려진 세그먼트 수
const layerColor = {};     // layer -> 대표색(처음 본 색) hex
const perLayerZ = {};      // layer -> [zmin, zmax] (표고 진단: 등고선이 평탄한가?)
function seg(x1, y1, z1, x2, y2, z2, color) {
  if (segCount >= MAX_SEG) return;
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
  z1 = Number.isFinite(z1) ? z1 : 0; z2 = Number.isFinite(z2) ? z2 : 0;
  if (x1 === x2 && y1 === y2 && z1 === z2) return;
  if (!ORIGIN) ORIGIN = [Math.round(x1), Math.round(y1), Math.round(z1)];
  if (Math.abs(x1 - ORIGIN[0]) > 500000 || Math.abs(y1 - ORIGIN[1]) > 500000 ||
      Math.abs(x2 - ORIGIN[0]) > 500000 || Math.abs(y2 - ORIGIN[1]) > 500000) return;
  // Z(표고) 폭주 데이터 방지 — 원점 기준 100km 초과 표고는 불량으로 보고 평면(0)으로.
  if (Math.abs(z1 - ORIGIN[2]) > 100000) z1 = ORIGIN[2];
  if (Math.abs(z2 - ORIGIN[2]) > 100000) z2 = ORIGIN[2];
  const key = color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 8)).join('_');
  let g = bucketOf.get(key);
  if (!g || g.pos.length / 3 + 2 > BUCKET) { g = { color, pos: [] }; bucketOf.set(key, g); allGroups.push(g); }
  g.pos.push(x1 - ORIGIN[0], y1 - ORIGIN[1], z1 - ORIGIN[2], x2 - ORIGIN[0], y2 - ORIGIN[1], z2 - ORIGIN[2]);
  segCount++;
  perLayer[curLayer] = (perLayer[curLayer] || 0) + 1;
  const zl = perLayerZ[curLayer] || (perLayerZ[curLayer] = [Infinity, -Infinity]);
  if (z1 < zl[0]) zl[0] = z1; if (z1 > zl[1]) zl[1] = z1;
  if (z2 < zl[0]) zl[0] = z2; if (z2 > zl[1]) zl[1] = z2;
  if (!layerColor[curLayer]) layerColor[curLayer] = '#' + color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
  if (color[0] >= 0.75 && color[1] >= 0.75 && color[2] >= 0.75) {
    const k = `${curType}|${curLayer}`; whiteSeg[k] = (whiteSeg[k] || 0) + 1;
  }
}

// ---- 선종류(linetype) 대시 표현 ----
// LTYPE 정의(pattern: +길이=펜다운/−길이=펜업/0=점)를 실제 파선으로 방출한다. 엔티티→레이어
// 순으로 선종류를 해석하고, LTSCALE·엔티티 스케일을 곱해 곡선/직선 모두 호길이 따라 끊는다.
let curPattern = null; // [부호있는 길이…] 또는 null(실선)
let curPatLen = 0;     // 패턴 총길이(펜다운+펜업)
let dashPhase = 0;     // 경로 누적거리(패턴 위상)
let dashedEnts = 0;    // 진단: 대시로 그린 엔티티 수
const resetDash = () => { dashPhase = 0; };
function resolvePattern(ent) {
  let name = ent.lineType || ent.linetype;
  const lay = layers[ent.layer];
  if (!name || /byLayer/i.test(name)) name = lay?.lineType;
  if (!name || /byBlock/i.test(name) || /^continuous$/i.test(name)) return null;
  const def = lineTypes[name] || lineTypes[String(name).toUpperCase()];
  if (!def || !Array.isArray(def.pattern) || def.pattern.length < 2) return null;
  const pat = def.pattern.map(Number).filter((n) => Number.isFinite(n));
  if (pat.length < 2) return null;
  const scale = globalLtScale * (ent.lineTypeScale || 1);
  let scaled = pat.map((n) => n * scale);
  let tot = scaled.reduce((s, n) => s + Math.abs(n), 0);
  if (tot < 0.2) return null; // 너무 촘촘 → 실선 취급(세그 폭주 방지)
  // 점(0)·초미세 요소는 최소길이(패턴의 2%)로 바닥 처리 → 무한루프·세그 폭주 방지.
  // (0 = 펜다운 점으로 취급: 부호 없으면 +.)
  const minEl = Math.max(tot * 0.02, 1e-3);
  scaled = scaled.map((n) => (Math.abs(n) >= minEl ? n : (n < 0 ? -minEl : minEl)));
  tot = scaled.reduce((s, n) => s + Math.abs(n), 0);
  return { pat: scaled, len: tot };
}
// 한 직선구간을 현재 패턴대로 끊어 방출(위상 유지 → 곡선도 연속 파선). 실선이면 그대로 1개.
function stroke(x1, y1, z1, x2, y2, z2, color) {
  if (!curPattern) { seg(x1, y1, z1, x2, y2, z2, color); return; }
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return;
  if (L / curPatLen > 5000) { seg(x1, y1, z1, x2, y2, z2, color); return; } // 폭주 가드
  const ux = dx / L, uy = dy / L, uz = dz / L;
  const pat = curPattern;
  let s = 0, guard = 0;
  while (s < L - 1e-9) {
    if (++guard > 100000) { seg(x1 + ux * s, y1 + uy * s, z1 + uz * s, x2, y2, z2, color); break; }
    let ph = dashPhase % curPatLen; if (ph < 0) ph += curPatLen;
    let idx = 0, acc = 0;
    while (idx < pat.length) { const el = Math.max(Math.abs(pat[idx]), 1e-6); if (ph < acc + el) break; acc += el; idx++; }
    if (idx >= pat.length) idx = pat.length - 1;
    const remain = Math.max(Math.abs(pat[idx]), 1e-6) - (ph - acc);
    const step = Math.min(remain, L - s);
    if (pat[idx] >= 0) { // 펜다운(대시·점)
      seg(x1 + ux * s, y1 + uy * s, z1 + uz * s, x1 + ux * (s + step), y1 + uy * (s + step), z1 + uz * (s + step), color);
    }
    s += step; dashPhase += step;
  }
}

// 2D 아핀 변환(블록 인스턴스용): {a,b,c,d,e,f} → x'=a*x+c*y+e, y'=b*x+d*y+f. Z 는 그대로 전달.
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

// 반경 인지 테셀레이션 분할 수(현 오차 0.4% → 곡선 매끄럽게, 작은 원도 자연스럽게).
function segN(r, spanRad) {
  const tol = Math.max(r * 0.004, 1e-4);
  const stepRad = 2 * Math.acos(Math.max(0, 1 - Math.min(1, tol / r)));
  return Math.max(6, Math.min(200, stepRad > 1e-6 ? Math.ceil(spanRad / stepRad) : 6));
}
function arcSegs(cx, cy, z, r, a0, a1, m, color) {
  if (!Number.isFinite(r) || r <= 0 || r > 100000) return; // 100km 초과 반경 = 불량/폭주 → 제외
  let span = a1 - a0; while (span <= 0) span += 360; // 도(degree), 반시계로 a0→a1
  const n = segN(r, span * Math.PI / 180);
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const ang = (a0 + span * i / n) * Math.PI / 180;
    const [x, y] = apply(m, cx + r * Math.cos(ang), cy + r * Math.sin(ang));
    if (prev) stroke(prev[0], prev[1], z, x, y, z, color);
    prev = [x, y];
  }
}
// 타원/타원호(ELLIPSE): 파라메트릭 t 로 매끈하게. major/minor·회전·시작·끝각 반영.
function ellipseSegs(ent, m, color) {
  const c = ent.center; if (!c) return;
  const ax = ent.majorAxisEndPoint?.x ?? 0, ay = ent.majorAxisEndPoint?.y ?? 0;
  const majLen = Math.hypot(ax, ay); if (majLen < 1e-9) return;
  const rot = Math.atan2(ay, ax), cr = Math.cos(rot), sr = Math.sin(rot);
  const minLen = majLen * (ent.axisRatio ?? 1);
  const a0 = ent.startAngle ?? 0, a1 = ent.endAngle ?? Math.PI * 2;
  let span = a1 - a0; if (span <= 1e-9) span += Math.PI * 2;
  const n = segN(Math.max(majLen, minLen), span), z = c.z ?? 0;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = a0 + span * i / n;
    const ex = majLen * Math.cos(t), ey = minLen * Math.sin(t);
    const [x, y] = apply(m, c.x + ex * cr - ey * sr, c.y + ex * sr + ey * cr);
    if (prev) stroke(prev[0], prev[1], z, x, y, z, color);
    prev = [x, y];
  }
}
// B-스플라인 한 점 계산(de Boor). ctrl=제어점, knots=노트벡터, p=차수, u=파라미터.
function bsplineEval(ctrl, knots, p, u) {
  const n = ctrl.length - 1;
  let k = p; while (k < n && knots[k + 1] <= u) k++;
  const d = [];
  for (let j = 0; j <= p; j++) { const c = ctrl[k - p + j]; d[j] = [c.x, c.y, c.z ?? 0]; }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = knots[i + p - r + 1] - knots[i];
      const a = den === 0 ? 0 : (u - knots[i]) / den;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
  }
  return d[p];
}
// 스플라인(SPLINE): 제어점·노트가 있으면 정식 B-스플라인으로 매끈하게(각짐 없음),
// 없으면 fit point(곡선 위 점) 연결로 폴백.
function splineSegs(ent, m, color) {
  const ctrl = ent.controlPoints, knots = ent.knotValues, p = ent.degreeOfSplineCurve || 3;
  if (ctrl && ctrl.length > p && knots && knots.length >= ctrl.length + p + 1) {
    const n = ctrl.length - 1, u0 = knots[p], u1 = knots[n + 1];
    if (Number.isFinite(u0) && Number.isFinite(u1) && u1 > u0) {
      const steps = Math.max(24, Math.min(600, ctrl.length * 12));
      let prev = null;
      for (let i = 0; i <= steps; i++) {
        const u = Math.min(u0 + (u1 - u0) * i / steps, u1 - 1e-9);
        const pt = bsplineEval(ctrl, knots, p, u);
        const [x, y] = apply(m, pt[0], pt[1]);
        if (prev) stroke(prev[0], prev[1], prev[2], x, y, pt[2], color);
        prev = [x, y, pt[2]];
      }
      return;
    }
  }
  const pts = (ent.fitPoints && ent.fitPoints.length >= 2) ? ent.fitPoints
    : (ctrl && ctrl.length >= 2) ? ctrl : null;
  if (!pts) return;
  let prev = null;
  for (const q of pts) {
    const [x, y] = apply(m, q.x, q.y); const z = q.z ?? 0;
    if (prev) stroke(prev[0], prev[1], prev[2], x, y, z, color);
    prev = [x, y, z];
  }
}

// ---- 문자(TEXT/MTEXT): 단선(single-stroke) 벡터 폰트로 실제 글자를 그린다 ----
// 표고·측점·치수 등 숫자/라틴 라벨을 렌더. 글리프는 x0..4·y0..6(베이스라인 0·캡 6) 좌표의
// 폴리라인 묶음. 한글 등 미지원 문자는 건너뛴다(다음 단계에서 확장). 대소문자 공용.
const FONT = {
  '0': [[0,1,0,5,1,6,3,6,4,5,4,1,3,0,1,0,0,1]],
  '1': [[1,5,2,6,2,0],[0,0,4,0]],
  '2': [[0,5,1,6,3,6,4,5,4,4,0,0,4,0]],
  '3': [[0,5,1,6,3,6,4,5,3,3,2,3],[3,3,4,2,4,1,3,0,1,0,0,1]],
  '4': [[3,0,3,6,0,2,4,2]],
  '5': [[4,6,0,6,0,3,3,3,4,2,4,1,3,0,1,0,0,1]],
  '6': [[4,5,3,6,1,6,0,5,0,1,1,0,3,0,4,1,4,2,3,3,0,3]],
  '7': [[0,6,4,6,1,0]],
  '8': [[1,3,0,4,0,5,1,6,3,6,4,5,4,4,3,3,1,3,0,2,0,1,1,0,3,0,4,1,4,2,3,3]],
  '9': [[0,1,1,0,3,0,4,1,4,5,3,6,1,6,0,5,0,4,1,3,4,3]],
  'A': [[0,0,2,6,4,0],[1,2,3,2]],
  'B': [[0,0,0,6,3,6,4,5,4,4,3,3,0,3],[3,3,4,2,4,1,3,0,0,0]],
  'C': [[4,5,3,6,1,6,0,5,0,1,1,0,3,0,4,1]],
  'D': [[0,0,0,6,2,6,4,4,4,2,2,0,0,0]],
  'E': [[4,6,0,6,0,0,4,0],[0,3,3,3]],
  'F': [[4,6,0,6,0,0],[0,3,3,3]],
  'G': [[4,5,3,6,1,6,0,5,0,1,1,0,3,0,4,1,4,3,2,3]],
  'H': [[0,0,0,6],[4,0,4,6],[0,3,4,3]],
  'I': [[2,0,2,6],[1,0,3,0],[1,6,3,6]],
  'J': [[3,6,3,1,2,0,1,0,0,1]],
  'K': [[0,0,0,6],[4,6,0,3,4,0]],
  'L': [[0,6,0,0,4,0]],
  'M': [[0,0,0,6,2,3,4,6,4,0]],
  'N': [[0,0,0,6,4,0,4,6]],
  'O': [[1,0,0,1,0,5,1,6,3,6,4,5,4,1,3,0,1,0]],
  'P': [[0,0,0,6,3,6,4,5,4,4,3,3,0,3]],
  'Q': [[1,0,0,1,0,5,1,6,3,6,4,5,4,1,3,0,1,0],[2,2,4,0]],
  'R': [[0,0,0,6,3,6,4,5,4,4,3,3,0,3],[2,3,4,0]],
  'S': [[4,5,3,6,1,6,0,5,1,3,3,3,4,2,3,0,1,0,0,1]],
  'T': [[0,6,4,6],[2,6,2,0]],
  'U': [[0,6,0,1,1,0,3,0,4,1,4,6]],
  'V': [[0,6,2,0,4,6]],
  'W': [[0,6,1,0,2,3,3,0,4,6]],
  'X': [[0,0,4,6],[0,6,4,0]],
  'Y': [[0,6,2,3,4,6],[2,3,2,0]],
  'Z': [[0,6,4,6,0,0,4,0]],
  '.': [[1,0,2,0,2,1,1,1,1,0]],
  ',': [[2,1,2,0,1,-1]],
  '-': [[1,3,3,3]],
  '_': [[0,0,4,0]],
  '+': [[2,1,2,5],[0,3,4,3]],
  '=': [[0,2,4,2],[0,4,4,4]],
  '/': [[0,0,4,6]],
  '\\': [[0,6,4,0]],
  ':': [[2,1,2,2],[2,4,2,5]],
  '°': [[1,5,2,5,2,6,1,6,1,5]],
  '±': [[2,1,2,4],[0,2,4,2],[0,0,4,0]],
  'Ø': [[1,0,0,1,0,5,1,6,3,6,4,5,4,1,3,0,1,0],[0,0,4,6]],
  '%': [[0,0,4,6],[0,5,1,5,1,6,0,6,0,5],[3,0,4,0,4,1,3,1,3,0]],
  '(': [[3,6,1,4,1,2,3,0]],
  ')': [[1,6,3,4,3,2,1,0]],
  '#': [[1,0,1,6],[3,0,3,6],[0,2,4,2],[0,4,4,4]],
};
const FONT_H = 6, FONT_ADV = 5;
let textGlyphs = 0;
function mtextClean(s) {
  return String(s ?? '')
    .replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '')
    .replace(/\\P/gi, '\n').replace(/\\~/g, ' ')
    .replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, 'Ø').replace(/%%%/g, '%');
}
// opentype 아웃라인 → 선분. 베지어는 잘게 쪼갠다. 한글 등 전 유니코드 렌더.
function drawTextOT(ent, m, color, elev) {
  const raw = mtextClean(ent.text);
  if (!raw) return;
  const h = ent.textHeight ?? ent.height ?? ent.nominalTextHeight;
  if (!(h > 0) || h > 1e6) return;
  const base = ent.startPoint || ent.position || ent.insertionPoint || { x: 0, y: 0 };
  const bz = Number.isFinite(base.z) ? base.z : elev;
  const rot = (ent.rotation || 0) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
  const fontSize = h / 0.7;         // DXF 문자높이=대문자높이 → em 보정
  const lineH = h * 1.6, upm = OTF.unitsPerEm || 1000;
  const lines = String(raw).split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]; if (!line) continue;
    const oy = -li * lineH;
    // put: 폰트 로컬(px,py; y-down) → CAD(y-up) → 회전 → 블록행렬.
    const put = (px, py) => {
      const gx = px, gy = -py + oy;
      const rx = gx * cr - gy * sr, ry = gx * sr + gy * cr;
      return apply(m, base.x + rx, base.y + ry);
    };
    // 글자별 charToGlyph(cmap) 배치 → GSUB(합자·shaping) 경로를 피해 크래시 없이 한글까지.
    let penX = 0;
    for (const ch of line) {
      let glyph, gp;
      try { glyph = OTF.charToGlyph(ch); gp = glyph.getPath(penX, 0, fontSize); }
      catch { penX += fontSize * 0.6; continue; }
      let cx = 0, cy = 0, sx0 = 0, sy0 = 0, prevW = null;
      const lineTo = (x, y) => { const p = put(x, y); if (prevW) seg(prevW[0], prevW[1], bz, p[0], p[1], bz, color); prevW = p; cx = x; cy = y; };
      for (const c of gp.commands) {
        if (c.type === 'M') { const p = put(c.x, c.y); prevW = p; cx = sx0 = c.x; cy = sy0 = c.y; }
        else if (c.type === 'L') lineTo(c.x, c.y);
        else if (c.type === 'Q') { const n = 4, x0 = cx, y0 = cy; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; lineTo(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y); } }
        else if (c.type === 'C') { const n = 6, x0 = cx, y0 = cy; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; lineTo(u*u*u*x0 + 3*u*u*t*c.x1 + 3*u*t*t*c.x2 + t*t*t*c.x, u*u*u*y0 + 3*u*u*t*c.y1 + 3*u*t*t*c.y2 + t*t*t*c.y); } }
        else if (c.type === 'Z') lineTo(sx0, sy0);
      }
      penX += (glyph.advanceWidth / upm) * fontSize;
      textGlyphs++;
    }
  }
}
function drawText(ent, m, color, elev) {
  if (OTF) return drawTextOT(ent, m, color, elev);
  const raw = mtextClean(ent.text);
  if (!raw) return;
  const h = ent.textHeight ?? ent.height ?? ent.nominalTextHeight;
  if (!(h > 0) || h > 1e6) return;
  const base = ent.startPoint || ent.position || ent.insertionPoint || { x: 0, y: 0 };
  const bz = Number.isFinite(base.z) ? base.z : elev;
  const rot = (ent.rotation || 0) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
  const f = h / FONT_H, xs = (ent.xScale && ent.xScale > 0) ? ent.xScale : 1;
  let cursor = 0, lineY = 0;
  for (const ch of raw) {
    if (ch === '\n') { cursor = 0; lineY -= FONT_H + 2; continue; }
    const g = FONT[ch] || FONT[ch.toUpperCase()];
    if (g) {
      for (const poly of g) {
        let prev = null;
        for (let i = 0; i < poly.length; i += 2) {
          const gx = (cursor + poly[i]) * f * xs, gy = (lineY + poly[i + 1]) * f;
          const rx = gx * cr - gy * sr, ry = gx * sr + gy * cr;
          const [X, Y] = apply(m, base.x + rx, base.y + ry);
          if (prev) seg(prev[0], prev[1], bz, X, Y, bz, color);
          prev = [X, Y];
        }
      }
      textGlyphs++;
    }
    cursor += FONT_ADV;
  }
}

// Civil3D 지표면(surface)은 스타일 등고선(초록)을 별도로 표시하면서, 원본 표면 폴리선을
// '지표면' 레이어에 흰색으로 중복 출력한다(LibreDWG explode). → 초록 등고선 옆 흰선(원본
// 스타일 뷰엔 없음)·전체 선분의 절반·거대 용량·렉의 주범. 흰색+지표면 레이어면 숨긴다.
// (진짜 표면을 다시 보고 싶으면 DXF_KEEP_SURFACE=1 로 유지 가능.)
const KEEP_SURFACE = process.env.DXF_KEEP_SURFACE === '1';
// '흰선' 정체: 초록 등고선(F0017111/#009800) 위에 겹쳐 보이던 선의 정체는 순백(≥0.75)이 아니라
// 중간 회색(#808080·#848484)의 표고/지반 레이어(ELEV-6·EZ-BASE)였다 — 어두운 뷰에선 흰선처럼
// 보인다. 순백 기준만으론 안 걸려서, '무채색(회색~흰)' + '표면/표고/지반' 이름을 함께 숨긴다.
// (진짜 지형은 초록 F0017xxx 로 남는다. 되살리려면 DXF_KEEP_SURFACE=1.)
const isWhiteish = (c) => c[0] >= 0.75 && c[1] >= 0.75 && c[2] >= 0.75;
const isGrayish = (c) => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 0.10) && Math.max(c[0], c[1], c[2]) >= 0.45;
// 주의: '등고/contour/tin' 같은 일반어는 진짜 등고선(초록)·식재(PLANTING 에 'tin' 포함!)까지
// 숨겨 '다 안 보임'을 유발 → 확인된 회색 잔재(ELEV-*·EZ-BASE·지표면/surface)만 좁게 숨긴다.
const surfaceLayerRe = /지표면|surface|(^|[-_ ])elev|ez[-_ ]?base/i;
let counts = {};
let hiddenSurf = 0;
const circLayers = {}; // 진단: CIRCLE/ARC 가 어느 레이어에 몰려있나
function emit(ent, m, depth = 0) {
  if (!ent || depth > 8) return;
  const color = colorOf(ent);
  curType = ent.type; curLayer = ent.layer || '';
  if (!KEEP_SURFACE && isGrayish(color) && surfaceLayerRe.test(curLayer)) { hiddenSurf++; return; }
  // 이 엔티티의 선종류 해석(대시). 경로 시작마다 위상 리셋 → 파선이 자연스럽게 이어진다.
  const pat = resolvePattern(ent);
  curPattern = pat ? pat.pat : null; curPatLen = pat ? pat.len : 0; resetDash();
  if (pat) dashedEnts++;
  counts[ent.type] = (counts[ent.type] || 0) + 1;
  if (ent.type === 'CIRCLE' || ent.type === 'ARC') circLayers[ent.layer] = (circLayers[ent.layer] || 0) + 1;
  const elev = ent.elevation ?? 0;
  switch (ent.type) {
    case 'LINE': {
      const s = ent.vertices?.[0] ?? ent.start, e = ent.vertices?.[1] ?? ent.end;
      if (!s || !e) break;
      const [x1, y1] = apply(m, s.x, s.y), [x2, y2] = apply(m, e.x, e.y);
      stroke(x1, y1, s.z ?? 0, x2, y2, e.z ?? 0, color); break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const vs = ent.vertices || [];
      const zf = (v) => (Number.isFinite(v.z) ? v.z : elev); // 3D폴리선=정점 z, 2D=elevation
      for (let i = 0; i < vs.length - 1; i++) polySeg(vs[i], vs[i + 1], m, color, zf(vs[i]), zf(vs[i + 1]));
      if (ent.shape || ent.closed) if (vs.length > 2) polySeg(vs[vs.length - 1], vs[0], m, color, zf(vs[vs.length - 1]), zf(vs[0]));
      break;
    }
    case 'ARC':
      arcSegs(ent.center.x, ent.center.y, ent.center.z ?? elev, ent.radius, ent.startAngle * 180 / Math.PI, ent.endAngle * 180 / Math.PI, m, color);
      break;
    case 'CIRCLE':
      arcSegs(ent.center.x, ent.center.y, ent.center.z ?? elev, ent.radius, 0, 360, m, color);
      break;
    case 'ELLIPSE': ellipseSegs(ent, m, color); break;
    case 'SPLINE': splineSegs(ent, m, color); break;
    case 'TEXT':
    case 'MTEXT': try { drawText(ent, m, color, elev); } catch { /* 폰트 미지원 문자 등 무시 */ } break;
    case 'INSERT': {
      const blk = dxf.blocks?.[ent.name];
      if (!blk?.entities) break;
      const bm = compose(m, insertMatrix(ent));
      const bx = blk.position?.x ?? 0, by = blk.position?.y ?? 0;
      const bm2 = compose(bm, { a: 1, b: 0, c: 0, d: 1, e: -bx, f: -by });
      for (const be of blk.entities) emit(be, bm2, depth + 1);
      break;
    }
    // HATCH/SOLID 채움: 다음 단계.
    default: break;
  }
}
// 폴리선 세그먼트(bulge=호). bulge=tan(θ/4), θ=포함각(부호:+반시계/−시계), 호는 v1→v2. z=세그 평면 표고.
function polySeg(v1, v2, m, color, z1, z2) {
  const b = v1.bulge || 0;
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const chord = Math.hypot(dx, dy); if (chord < 1e-9) return;
  const straight = () => { const [x1, y1] = apply(m, v1.x, v1.y), [x2, y2] = apply(m, v2.x, v2.y); stroke(x1, y1, z1, x2, y2, z2, color); };
  // 아주 작은 bulge=직선. z 가 다르면(3D 폴리선) bulge 무시 직선. 그 외엔 호.
  if (Math.abs(b) < 0.02 || z1 !== z2) { straight(); return; }
  const r = Math.abs(chord / (2 * Math.sin(2 * Math.atan(b)))); // |반경|
  if (!Number.isFinite(r) || r > chord * 400) { straight(); return; }
  const mx = (v1.x + v2.x) / 2, my = (v1.y + v2.y) / 2;
  // 중심 = 중점 + (부호있는 apothem)·(왼쪽 수직단위). apothem=(현/2)·(1−b²)/(2b).
  const apothem = (chord / 2) * (1 - b * b) / (2 * b);
  const nx = -dy / chord, ny = dx / chord;
  const cx = mx + apothem * nx, cy = my + apothem * ny;
  let a0 = Math.atan2(v1.y - cy, v1.x - cx) * 180 / Math.PI;
  let a1 = Math.atan2(v2.y - cy, v2.x - cx) * 180 / Math.PI;
  if (b < 0) [a0, a1] = [a1, a0]; // 시계방향 호 → arcSegs(반시계) 로 뒤집어 그림
  arcSegs(cx, cy, z1, r, a0, a1, m, color);
}

let bad = 0;
for (const ent of dxf.entities || []) { try { emit(ent, ID); } catch { bad++; } }
if (segCount >= MAX_SEG) log('⚠ 선분 캡 도달 — 일부 생략');
log('선분', segCount.toLocaleString(), '· 그룹', allGroups.length, '· 오류엔티티', bad, '· 표면회색선숨김', hiddenSurf, '· 대시엔티티', dashedEnts, '· 문자글리프', textGlyphs, '· 종류', JSON.stringify(counts));
const topCirc = Object.entries(circLayers).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (topCirc.length) log('원/호 상위 레이어:', topCirc.map(([n, c]) => `${n}=${c}`).join(', '));
const topWhite = Object.entries(whiteSeg).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (topWhite.length) log('흰색 세그먼트 상위(엔티티|레이어=수):', topWhite.map(([k, c]) => `${k}=${c}`).join(', '));
const topLayers = Object.entries(perLayer).sort((a, b) => b[1] - a[1]).slice(0, 25);
log('그려진 레이어 상위(레이어=세그먼트수·색·표고범위):');
for (const [n, c] of topLayers) {
  const z = perLayerZ[n] || [0, 0];
  const zr = (Number.isFinite(z[0]) ? z[0] : 0).toFixed(1) + '~' + (Number.isFinite(z[1]) ? z[1] : 0).toFixed(1);
  const flat = (z[1] - z[0]) < 0.05 ? ' [평탄]' : '';
  log(`   ${n} = ${c.toLocaleString()} · ${layerColor[n]} · Z[${zr}]${flat}`);
}

// ---- Z 이상치 정리: 표고 히스토그램으로 1~99% 밴드를 구해 소수 이상치가 3D 를 세로로
//      늘리지 않게 클램프(실제 지형 표고는 보존). ----
let zLo = -Infinity, zHi = Infinity;
{
  let zmin = Infinity, zmax = -Infinity;
  for (const g of allGroups) for (let i = 2; i < g.pos.length; i += 3) { const z = g.pos[i]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  if (Number.isFinite(zmin) && zmax > zmin) {
    const BINS = 1024, hist = new Int32Array(BINS), sc = (BINS - 1) / (zmax - zmin);
    let total = 0;
    for (const g of allGroups) for (let i = 2; i < g.pos.length; i += 3) { hist[Math.floor((g.pos[i] - zmin) * sc)]++; total++; }
    const pct = (frac) => { let acc = 0; const t = total * frac; for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= t) return zmin + b / sc; } return zmax; };
    const lo = pct(0.01), hi = pct(0.99);
    if ((hi - lo) < (zmax - zmin) * 0.7) { // 이상치가 실제로 있을 때만 클램프
      zLo = lo; zHi = hi;
      log(`Z 이상치 클램프: 전체 [${zmin.toFixed(1)}, ${zmax.toFixed(1)}] → 유효 [${zLo.toFixed(1)}, ${zHi.toFixed(1)}]`);
    } else {
      log(`Z 범위 [${zmin.toFixed(1)}, ${zmax.toFixed(1)}] (이상치 없음)`);
    }
  }
}
const clampZ = (z) => (z < zLo ? zLo : z > zHi ? zHi : z);

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
  if (zLo !== -Infinity) for (let i = 2; i < pos.length; i += 3) pos[i] = clampZ(pos[i]);
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

// focus(밀집영역): bbox 중심/반. ORIGIN 상대. Z(표고) 실제 범위 반영. (SVF 경로와 동일 포맷)
const cx = (gmin[0] + gmax[0]) / 2, cy = (gmin[1] + gmax[1]) / 2, cz = (gmin[2] + gmax[2]) / 2;
const hx = (gmax[0] - gmin[0]) / 2, hy = (gmax[1] - gmin[1]) / 2, hz = Math.max(1, (gmax[2] - gmin[2]) / 2);
fs.writeFileSync('out/focus.json', JSON.stringify({ center: [cx, cy, cz], half: [hx, hy, hz] }));
log('focus.json 완료 · bbox(상대) min', gmin.map((v) => v.toFixed(0)), 'max', gmax.map((v) => v.toFixed(0)));
