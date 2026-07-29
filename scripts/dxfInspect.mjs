// DXF 내용 진단 — DWG→DXF 변환 결과에 '진짜 객체'가 얼마나 살아있는지 확인.
// 호(ARC)·폴리선·원·문자·해치·선종류·선가중치·레이어 + Civil3D TIN(프록시/3DFACE) 여부.
import fs from 'node:fs';
import DxfParser from 'dxf-parser';

const path = process.argv[2] || 'out/original.dxf';
const txt = fs.readFileSync(path, 'utf8');
console.log(`[dxf] 파일 ${path} · ${txt.length.toLocaleString()} 자`);

let dxf;
try { dxf = new DxfParser().parseSync(txt); }
catch (e) { console.log('[dxf] 파싱 실패:', e.message); process.exit(0); }

const counts = {};
for (const e of dxf.entities || []) counts[e.type] = (counts[e.type] || 0) + 1;
console.log('[dxf] 엔티티 종류별:', JSON.stringify(counts));

const c = (t) => counts[t] || 0;
console.log(`[dxf] 핵심: ARC=${c('ARC')} · LWPOLYLINE=${c('LWPOLYLINE')} · POLYLINE=${c('POLYLINE')} · LINE=${c('LINE')} · CIRCLE=${c('CIRCLE')} · SPLINE=${c('SPLINE')}`);
console.log(`[dxf] 주석/면: TEXT=${c('TEXT')} · MTEXT=${c('MTEXT')} · HATCH=${c('HATCH')} · SOLID=${c('SOLID')} · 3DFACE=${c('3DFACE')} · INSERT(블록)=${c('INSERT')}`);
console.log(`[dxf] Civil3D 추정: ${Object.keys(counts).filter((k) => /AECC|PROXY|ACAD_PROXY|TIN/i.test(k)).join(',') || '없음(표준 엔티티로만 옴)'}`);

const layers = dxf.tables?.layer?.layers || {};
console.log(`[dxf] 레이어 ${Object.keys(layers).length}개 — 샘플(이름/색/선종류/선가중치):`);
for (const [n, l] of Object.entries(layers).slice(0, 12)) {
  console.log(`[dxf]   ${n} · color=${l.color} · ltype=${l.lineType ?? '-'} · lw=${l.lineweight ?? '-'}`);
}
// 선종류(대시 패턴) 정의 존재 여부
const ltypes = dxf.tables?.lineType?.lineTypes || dxf.tables?.ltype?.lineTypes || {};
console.log(`[dxf] 선종류 정의 ${Object.keys(ltypes).length}개:`, Object.keys(ltypes).slice(0, 15).join(','));
