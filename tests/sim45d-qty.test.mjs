// 수량분개(10-27 사용자 5번): 집계표 위치 읽기 → 내역 대응 → 대상 몫 → 작업 배분. 숫자는 만든 값(실제 현장 자료는 레포에 넣지 않음).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, modules = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', code)(exports, name => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  }, process);
  return exports;
}
const T = compile('src/lib/sim45d/qtyTable.ts');
const L = compile('src/lib/sim45d/autolink.ts');
const W = compile('src/lib/sim45d/wbsScope.ts');
const Q = compile('src/lib/sim45d/qtySplit.ts', { './autolink.js': L, './qtyTable.js': T, './wbsScope.js': W });

// 머리: 공·종·규 격·단위(위 줄), 열 제목(아래 줄, 칸 가운데), 숫자는 칸 오른쪽 끝(제목 가운데 + 46)
const head = (cols, y = 660) => [
  [400, 786, 260, '시험교 개 소 별 집 계 표 (1)'], [700, 691, 40, '시 험 교'],
  [132, 706, 10, '공'], [152, 706, 10, '종'], [366, 706, 25, '규 격'], [536, 706, 20, '단위'], [996, 706, 20, '합계'], [1089, 706, 25, '비 고'],
  ...cols.map(([x, name]) => [x - 15, y, 30, name]),
];
const num = (x, y, s) => [x + 46 - s.length * 5, y, s.length * 5, s];
const SUB = [[624, '교대공'], [719, '교각공 (하선)'], [815, '교각공 (상선)'], [911, '계']];

test('sheet table: values go to their column by position (empty cells), headings become the path, stacked headers merge', () => {
  const p1 = { page: 5, cells: [
    ...head(SUB),
    [67, 635, 80, '2-1-1 토공및기초공'], [67, 615, 70, '3) 말뚝두부보강'],
    [72, 594, 60, '말뚝두부보강'], [341, 594, 75, '강관말뚝,D609mm'], [541, 594, 10, '본'], num(624, 594, '30.000'), num(911, 594, '30.000'), num(1006, 594, '30'),
    [72, 574, 60, '말뚝두부보강'], [343, 574, 70, 'PHC말뚝,D600mm'], [541, 574, 10, '본'], num(719, 574, '20.000'), num(815, 574, '12.000'), num(911, 574, '32.000'), num(1006, 574, '32'),
    [72, 554, 60, '사토운반'], [300, 554, 160, 'D/T=24ton,토사(표준시장)'], [541, 554, 10, 'm3'], num(624, 554, '10.5'), num(815, 554, '4.5'), num(911, 554, '15'), num(1006, 554, '15'),
  ] };
  // 다음 쪽: 상부(사재교/하로교 두 줄 제목) — 경로는 새 제목으로
  const p2 = { page: 6, cells: [
    ...head([[517, '상부공'], [702, '공동구'], [911, '계']]), [595, 666, 30, '사재교'], [595, 654, 30, '하로교'],
    [80, 635, 80, '2-1-4 상부공'], [85, 615, 80, '구체콘크리트타설'], [292, 615, 120, '철근,fck=35MPa(표준시장)'], [541, 615, 10, 'm3'],
    num(702, 615, '1,000'), num(610, 615, '100'), num(911, 615, '1,100'), num(1006, 615, '1,100'),
  ] };
  const rows = T.parseSheetPages([p1, p2]);
  assert.deepEqual(rows.map(r => [r.page, r.path.join('>'), r.name, r.unit, r.cols]), [
    [5, '2-1-1 토공및기초공>3) 말뚝두부보강', '말뚝두부보강', '본', { 교대공: 30, 계: 30, 합계: 30 }],
    [5, '2-1-1 토공및기초공>3) 말뚝두부보강', '말뚝두부보강', '본', { '교각공(하선)': 20, '교각공(상선)': 12, 계: 32, 합계: 32 }],
    [5, '2-1-1 토공및기초공>3) 말뚝두부보강', '사토운반', 'm3', { 교대공: 10.5, '교각공(상선)': 4.5, 계: 15, 합계: 15 }],
    [6, '2-1-4 상부공', '구체콘크리트타설', 'm3', { '사재교·하로교': 100, 공동구: 1000, 계: 1100, 합계: 1100 }],
  ]);
  assert.equal(rows[0].spec, '강관말뚝,D609mm');
  assert.equal(T.rowKey('구체콘크리트타설', '철근,fck=35MPa(표준시장)', '㎥'), T.rowKey('구체 콘크리트타설', '철근,fck=35MPa', 'm3'));
});

const site = { name: '시험교 상선', code: 'T', spans: [], supports: [
  { id: 'A1', kind: 'abutment', pileType: 'driven', pileCount: 30 },
  { id: 'P1', kind: 'pier', pileType: 'driven', pileCount: 12, footing: true },
  { id: 'P2', kind: 'pier', pileType: 'cast', pileCount: 1 },
  { id: 'P3', kind: 'pier', pileType: 'cast', pileCount: 1 },
] };
const acts = [
  { code: 'A1F', name: '말뚝·가시설·토공', path: ['하부공', 'A1'], days: 52 }, { code: 'A1F2', name: '기초', path: ['하부공', 'A1'], days: 22 },
  { code: 'A1W', name: '벽체', path: ['하부공', 'A1'], days: 43 },
  ...['P1', 'P2', 'P3'].flatMap(p => [
    { code: `${p}F`, name: '기초', path: ['하부공', p], days: 11 }, { code: `${p}C`, name: '교각시공', path: ['하부공', p], days: p === 'P1' ? 20 : 10 },
    { code: `${p}K`, name: '코핑시공', path: ['하부공', p], days: 27 }]),
  { code: 'G01', name: 'WPC거더 거치 S1~S2', path: ['상부공'], days: 4 }, { code: 'G02', name: 'WPC거더 거치 S3', path: ['상부공'], days: 2 },
  { code: 'D01', name: '공동구(Leveling 콘크리트 포함) S1~S2', path: ['상부공'], days: 8 }, { code: 'D02', name: '공동구(Leveling 콘크리트 포함) S3', path: ['상부공'], days: 4 },
];

test('quantity split: matched rows, this line\'s share per column, allocation to activities, cost per activity', () => {
  const boq = [
    { id: '1', name: '말뚝두부보강', spec: '강관말뚝,D609mm', unit: '본', qty: 30, amount: 3_000_000 },
    { id: '2', name: '말뚝두부보강', spec: 'PHC말뚝,D600mm', unit: '본', qty: 32, amount: 3_200_000 },
    { id: '3', name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', qty: 1000, amount: 100_000_000 },
    { id: '4', name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', qty: 900, amount: 90_000_000 },
    { id: '5', name: 'WPC 제작 및 가설', spec: 'L=40.0m', unit: '본', qty: 30, amount: 300_000_000 },
    { id: '6', name: '공통가설', spec: '', unit: 'm', qty: 1, amount: 50_000 },
  ];
  const rows = [
    { page: 5, path: ['2-1-1 토공및기초공'], name: '말뚝두부보강', spec: '강관말뚝,D609mm', unit: '본', cols: { 교대공: 30, 계: 30, 합계: 30 } },
    { page: 5, path: ['2-1-1 토공및기초공'], name: '말뚝두부보강', spec: 'PHC말뚝,D600mm', unit: '본', cols: { '교각공(하선)': 20, '교각공(상선)': 12, 계: 32, 합계: 32 } },
    { page: 7, path: ['2-1-3 교각공'], name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', cols: { '교각공(하선)': 450, '교각공(상선)': 450, 계: 900, 합계: 900 } },
    { page: 9, path: ['2-1-4 상부공'], name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', cols: { 공동구: 1000, 계: 1000, 합계: 1000 } },
    { page: 9, path: ['2-1-4 상부공'], name: 'WPC 제작 및 가설', spec: 'L=40.0m', unit: '본', cols: { 상부공: 30, 합계: 30 } },
  ];
  // 같은 이름·규격이 두 절에 — 수량으로 가른다(1000 은 상부, 900 은 교각)
  const m = Q.matchSheet(boq, rows);
  assert.deepEqual([...m].map(([id, r]) => [id, r.row.page]).sort(), [['1', 5], ['2', 5], ['3', 9], ['4', 7], ['5', 9]]);
  const data = Q.buildSplitData('2-1. 시험교', '수량산출서 5~9쪽', boq, rows);
  assert.equal(data.lines.filter(l => l.cols).length, 5);
  // 교대공 몫은 근거와 함께 1/3, 상부공·공동구는 저장 안 함 → 교각공 상선 비율(m3 기준 0.5) 가정
  data.shares = { 교대공: { share: 1 / 3, source: '집계표 토압분리형 접속부: 상선 A1·하선 A1·A2' } };
  const r = Q.splitQuantities(data, '시험교 상선', acts, site);
  const line = id => r.lines.find(l => l.id === id);
  assert.ok(Math.abs(line('1').targetQty - 10) < 1e-9, '교대 30 × 1/3');
  assert.deepEqual(line('1').alloc.map(a => a.code), ['A1F'], '강관말뚝 → 교대 말뚝·가시설·토공');
  assert.deepEqual(line('2').alloc.map(a => [a.code, a.qty]), [['P1F', 12]], 'PHC → 기성말뚝 개소만');
  const pier = line('4');
  assert.equal(pier.targetQty, 450);
  const c1 = pier.alloc.find(a => a.code === 'P1C').qty, k1 = pier.alloc.find(a => a.code === 'P1K').qty;
  assert.ok(Math.abs(c1 / k1 - 20 / 27) < 1e-9, '교각·코핑은 작업 일수 비례');
  assert.equal(r.shares['공동구'].assumed, true);
  assert.equal(r.shares['공동구'].share, 0.5);
  assert.deepEqual(line('3').alloc.map(a => [a.code, a.qty]), [['D01', 1000 * 0.5 * 2 / 3], ['D02', 1000 * 0.5 / 3]], '공동구 → 경간 수 비례');
  assert.deepEqual(line('5').alloc.map(a => a.code), ['G01', 'G02']);
  assert.equal(line('6').status, 'unmatched');
  // 작업별 공사비 = 배분 수량 × 단가, 합 = 배분 합
  const sum = [...r.byCode.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - r.totals.allocated) < 1e-6);
  assert.ok(Math.abs(r.byCode.get('P1F') - 12 * 100_000) < 1e-6);
  assert.equal(r.totals.unmatched, 50_000);
  // 항목 고침: 부위·몫
  const fixed = Q.splitQuantities({ ...data, overrides: { 3: { share: 1, group: 'deck', source: '상선 전용 공동구' } } }, '시험교 상선', acts, site);
  assert.equal(fixed.lines.find(l => l.id === '3').targetQty, 1000);
  assert.equal(Q.lineOf('연제교(하선)'), '하선');
});

test('quantity split: different wording matched by unit, quantity and similar name (noted); totals-only rows use the section column', () => {
  const boq = [
    { id: 'w', name: 'WPC거더 제작 및 가설', spec: 'L=40.0m', unit: '본', qty: 12, amount: 1_200_000 },
    { id: 's', name: '사토운반', spec: '토  사,덤프24톤,L=12.0km이내(표준시장)', unit: 'm3', qty: 61, amount: 61_000 },
    { id: 'x', name: '강관말뚝', spec: 'D609mm×12T', unit: 'm', qty: 250, amount: 2_500_000 },
    { id: 'n', name: '전혀 다른 항목', spec: '', unit: 'm', qty: 7, amount: 700 },
  ];
  const rows = [
    { page: 3, path: ['2-1-1 토공및기초공'], name: '사토운반', spec: 'D/T=24ton,토사,L=12.0km(표준시장)', unit: 'm3', cols: { 교대공: 20.5, '교각공(상선)': 40.5, 계: 61, 합계: 61 } },
    { page: 3, path: ['2-1-1 토공및기초공', '4) 말뚝'], name: 'PHC 말뚝', spec: 'D600mm×90T(C종)', unit: 'm', cols: { '교각공(하선)': 130, '교각공(상선)': 120.2, 계: 250.2, 합계: 250 } },
    { page: 9, path: ['2-1-4 상부공', '2-1-4-15 WPC 제작 및 설치'], name: 'WPC 제작 및 가설', spec: 'L=40.0m', unit: '본', cols: { 합계: 12 } },
  ];
  const m = Q.matchSheet(boq, rows);
  assert.equal(m.get('w').row.name, 'WPC 제작 및 가설');
  assert.match(m.get('w').note, /WPC 제작 및 가설/);
  assert.equal(m.get('s').row.page, 3);
  assert.match(m.get('x').note, /PHC 말뚝/, '수량이 같은 다른 이름 — 내역서 품명 확인용으로 남김');
  assert.equal(m.has('n'), false);
  const data = Q.buildSplitData('s', 'q', boq, rows);
  const r = Q.splitQuantities({ ...data, shares: { 상부공: { share: 0.5, source: '시험' } } }, '시험교 상선', acts, site);
  const w = r.lines.find(l => l.id === 'w');
  assert.equal(w.targetQty, 6, '합계만 있는 WPC 행은 상부공 열 × 0.5');
  assert.deepEqual(w.alloc.map(a => a.code), ['G01', 'G02']);
  assert.match(w.basis, /집계표 표기/);
});

test('existing vs BIM: structural concrete per part, WPC girders by length, piles by kind; missing volumes are reported, not guessed', () => {
  const C = compile('src/lib/sim45d/qtyCompare.ts', { './qtySplit.js': Q });
  const boq = [
    { id: '2', name: '말뚝두부보강', spec: 'PHC말뚝,D600mm', unit: '본', qty: 32, amount: 3_200_000 },
    { id: '3', name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', qty: 1000, amount: 100_000_000 },
    { id: '4', name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', qty: 900, amount: 90_000_000 },
    { id: '7', name: '버림콘크리트', spec: 'fck=18MPa', unit: 'm3', qty: 50, amount: 500_000 },
    { id: '5', name: 'WPC 제작 및 가설', spec: 'L=40.0m', unit: '본', qty: 30, amount: 300_000_000 },
  ];
  const rows = [
    { page: 5, path: ['2-1-1 토공및기초공'], name: '말뚝두부보강', spec: 'PHC말뚝,D600mm', unit: '본', cols: { '교각공(하선)': 20, '교각공(상선)': 12, 계: 32, 합계: 32 } },
    { page: 7, path: ['2-1-3 교각공'], name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', cols: { '교각공(하선)': 450, '교각공(상선)': 450, 계: 900, 합계: 900 } },
    { page: 7, path: ['2-1-3 교각공'], name: '버림콘크리트', spec: 'fck=18MPa', unit: 'm3', cols: { '교각공(하선)': 25, '교각공(상선)': 25, 계: 50, 합계: 50 } },
    { page: 9, path: ['2-1-4 상부공'], name: '구체콘크리트타설', spec: '철근,fck=35MPa(표준시장)', unit: 'm3', cols: { 공동구: 1000, 계: 1000, 합계: 1000 } },
    { page: 9, path: ['2-1-4 상부공'], name: 'WPC 제작 및 가설', spec: 'L=40.0m', unit: '본', cols: { 상부공: 30, 합계: 30 } },
  ];
  const r = Q.splitQuantities(Q.buildSplitData('s', 'q', boq, rows), '시험교 상선', acts, site);
  const objects = [
    // 교각·코핑: 저장 연결(외부 ID) 2개 + 모델 코드(공정표에 있는 것) 1개
    { id: 1, ext: 'e1', name: '교각', volume: 150 }, { id: 2, ext: 'e2', name: '코핑', volume: 120 }, { id: 3, ext: 'e3', name: '교각', code: 'P2C', volume: 175.5 },
    { id: 4, ext: 'e4', name: '공동구', code: 'D01', volume: null },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 10 + i, ext: `g${i}`, name: 'WPC_40.0m_2.3m', ifcClass: 'IfcBeam', code: 'G01', volume: 30 })),
    { id: 30, ext: 'x1', name: 'WPC 가로보', ifcClass: 'IfcBeam', code: 'G01', volume: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({ id: 40 + i, ext: `p${i}`, name: 'PHC 말뚝 D600', code: 'P1F', volume: 2 })),
    { id: 60, ext: 'z', name: '교각', code: 'ZZZ', volume: 999 }, // 공정표에 없는 코드 — 안 셈
  ];
  const links = [{ ext: 'e1', ifcGuid: '', code: 'P1C' }, { ext: 'e2', ifcGuid: '', code: 'P1K' }];
  const out = C.compareWithModel(r, objects, links, new Set(acts.map(a => a.code)));
  const row = key => out.find(q => q.key === key);
  // 교각 구조 콘크리트: 설계 450(버림 제외) ↔ 모델 150+120+175.5
  assert.equal(row('concrete|pierBody').sheetQty, 450);
  assert.equal(row('concrete|pierBody').modelQty, 445.5);
  // 공동구: 객체는 있지만 체적이 없음 → 값 대신 이유
  assert.equal(row('concrete|deck').modelQty, null);
  assert.match(row('concrete|deck').note, /체적 없는 객체 1\/1/);
  // WPC 40m: 설계 15(상부공 30 × 교각공 상선 비율 0.5 가정) ↔ 보 10(가로보 제외)
  assert.deepEqual([row('wpc|40').sheetQty, row('wpc|40').modelQty], [15, 10]);
  // 말뚝 본수는 부위별(종류는 근거에): PHC 12 ↔ P1F 에 걸린 말뚝 객체 12 — 말뚝 체적은 콘크리트에 안 셈
  assert.deepEqual([row('pile|pierFoundation').sheetQty, row('pile|pierFoundation').modelQty], [12, 12]);
  assert.match(row('pile|pierFoundation').note, /설계 PHC \/ 모델 PHC$/);
  assert.equal(row('concrete|pierFoundation'), undefined);
  // 근거: 설계 항목·모델 객체 유형
  assert.deepEqual(row('concrete|pierBody').designLines.map(l => [l.id, l.qty]), [['4', 450]]);
  assert.deepEqual(row('concrete|pierBody').modelTypes.map(t => [t.name, t.count]), [['교각', 2], ['코핑', 1]]);
});
