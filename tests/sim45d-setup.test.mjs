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
const s = compile('src/lib/sim45d/setup.ts');

const file = (id, name) => ({ accProjectId: 'b.p', accItemId: id, name, folderNames: ['Project Files', '공정'], size: 10, pickedAt: '2026-10-23T00:00:00Z' });

test('steps follow the work order and every needed slot exists', () => {
  assert.deepEqual(s.STEPS.map(x => x.key), ['target', 'files', 'design', 'draft', 'p6', 'link', 'export', 'sim', 'report']);
  for (const step of s.STEPS) for (const k of step.needs) assert.ok(s.SLOTS.some(x => x.key === k), `${step.key} → ${k}`);
});

test('single slots replace, multiple slots add without duplicates; remove clears empty slots', () => {
  let d = s.emptySetup();
  d = s.addFile(d, 'plan', file('a', '시공계획.pdf'));
  d = s.addFile(d, 'plan', file('b', '시공계획(최종).pdf'));
  assert.deepEqual(d.files.plan.map(f => f.accItemId), ['b']);
  d = s.addFile(d, 'model', file('m1', 'BR01.rvt'));
  d = s.addFile(d, 'model', file('m2', 'BR02.rvt'));
  d = s.addFile(d, 'model', file('m1', 'BR01.rvt'));
  assert.deepEqual(d.files.model.map(f => f.accItemId), ['m2', 'm1']);
  d = s.removeFile(d, 'plan', 'b');
  assert.equal('plan' in d.files, false);
});

test('accepted extensions per slot', () => {
  assert.equal(s.acceptsFile('model', 'PO05_F_AB_BR01_R24.rvt'), true);
  assert.equal(s.acceptsFile('model', '시공계획.pdf'), false);
  assert.equal(s.acceptsFile('p6', '311.XER'), true);
  assert.equal(s.acceptsFile('boq', '산출내역서.xls'), true);
});

test('step status: required files decide done; unbuilt steps report what they will need', () => {
  let d = s.emptySetup();
  assert.equal(s.stepStatus(d, 'target', '').state, 'todo');
  assert.equal(s.stepStatus(d, 'target', '연제교').state, 'done');
  let st = s.stepStatus(d, 'files', '연제교');
  assert.equal(st.state, 'todo');
  assert.deepEqual(st.missing.map(x => x.key).sort(), ['model', 'plan', 'qto']);
  d = s.addFile(s.addFile(s.addFile(d, 'plan', file('a', 'p.pdf')), 'qto', file('b', 'q.pdf')), 'model', file('c', 'm.rvt'));
  assert.equal(s.stepStatus(d, 'files', '연제교').state, 'done');
  st = s.stepStatus(d, 'export', '연제교');
  assert.equal(st.state, 'todo', '7단계: 확정 공정표·반영 확인 전');
  assert.deepEqual(st.missing.map(x => x.key), ['p6']);
  assert.equal(s.stepStatus({ ...d, modelSync: { at: 'x', modelItemId: 'c', modelName: 'm.rvt', rows: 10, same: 9, missing: 1, withDates: false } }, 'export', '연제교').state, 'todo');
  assert.equal(s.stepStatus({ ...d, modelSync: { at: 'x', modelItemId: 'c', modelName: 'm.rvt', rows: 10, same: 10, missing: 0, withDates: false } }, 'export', '연제교').state, 'done', '모두 반영되면 완료');
  assert.equal(s.stepStatus(d, 'p6', '연제교').state, 'todo');
  assert.equal(s.stepStatus(d, 'design', '연제교').state, 'todo');
  d = { ...d, site: { name: '연제교', code: 'BR01', supports: [{ id: 'P1', kind: 'pier', pileType: 'cast', pileCount: 1 }], spans: [] } };
  assert.equal(s.stepStatus(d, 'design', '연제교').state, 'done');
  assert.equal(s.stepStatus(d, 'link', '연제교').state, 'todo');
  d = { ...d, links: [{ modelItemId: 'c', wbsRoot: 'x', at: '', links: [] }] };
  assert.equal(s.stepStatus(d, 'link', '연제교').state, 'todo', '빈 연결 저장은 완료가 아님');
  d = { ...d, links: [{ modelItemId: 'c', wbsRoot: 'x', at: '', links: [{ ext: 'e', ifcGuid: 'g', code: 'P2F', by: 'rule' }] }] };
  assert.equal(s.stepStatus(d, 'link', '연제교').state, 'done');
  assert.equal(s.normalizeSetup(d).site.supports.length, 1);
  assert.equal(s.normalizeSetup({ site: { name: 'x', code: 'y', supports: [{ id: 'P1' }], spans: [] } }).site, undefined);
});

test('normalize drops broken entries, unknown slots and keeps one file in single slots', () => {
  const d = s.normalizeSetup({
    kind: 'tunnel',
    files: {
      plan: [file('a', 'a.pdf'), file('b', 'b.pdf')],
      model: [file('m', 'm.rvt'), { accItemId: 'x' }, file('m', 'm.rvt')],
      bogus: [file('z', 'z.pdf')],
    },
  });
  assert.equal(d.kind, 'tunnel');
  assert.deepEqual(d.files.plan.map(f => f.accItemId), ['b']);
  assert.deepEqual(d.files.model.map(f => f.accItemId), ['m']);
  assert.equal('bogus' in d.files, false);
  assert.deepEqual(s.normalizeSetup(null), s.emptySetup());
  assert.equal(s.normalizeSetup({ kind: 'nope' }).kind, 'bridge');
});

const L = compile('src/lib/sim45d/autolink.ts');

test('auto link: part and place from object text → activity under the matching WBS place', () => {
  const acts = [
    { code: 'A1F', name: '기초', path: ['하부공', 'A1'] },
    { code: 'A1W', name: '벽체', path: ['하부공', 'A1'] },
    { code: 'P2F', name: '기초', path: ['하부공', 'P2'] },
    { code: 'P2C', name: '교각시공', path: ['하부공', 'P2'] },
    { code: 'P2K', name: '코핑시공', path: ['하부공', 'P2'] },
    { code: 'P12F', name: '기초', path: ['하부공', 'P12'] },
    { code: 'GF', name: 'WPC거더 제작(182/8/8)', path: ['상부공', '상부공'] },
    { code: 'GE', name: 'WPC거더 거치', path: ['상부공', '상부공'] },
    { code: 'DK', name: '공동구(Leveling 콘크리트 포함)', path: ['상부공', '상부공'] },
    { code: 'HR', name: '연제교 상선 S1,S2(하로교)', path: ['상부공', '상부공'] },
  ];
  const objs = [
    { id: '1', label: '교각 P2 말뚝', name: '강관말뚝 [1279059]', type: '22700 P2' },
    { id: '2', label: '코핑 P2', name: '코핑_상선_P03,P05~P42 [1]', comment: '상선 교각 P2' },
    { id: '3', label: '기초 P12', name: '기초_상선_P01,P03_P46 [2]' },
    { id: '4', name: '교대 [3]', label: '교대 A1' },
    { id: '5', label: '교대 A1 버림콘크리트', name: '버림콘크리트 [4]' },
    { id: '6', label: '상선_거더_S39', name: 'WPC_40m_우_1' },
    { id: '7', label: '상선_상부슬래브_S30', name: 'WPC_40m' },
    { id: '8', label: '교량받침', name: '받침', comment: '상선 교좌 P01' },
    { id: '9', label: '하교로_U거더_바닥판', name: '하로교_U거더_1' },
    { id: '10', label: '하교로_U거더_공동구 및 방호벽', name: '하로교_U거더_2' },
    { id: '11', name: '기초_상선_P01,P03_P46 [5]' },
    { id: '12', label: '난간' },
  ];
  const got = Object.fromEntries(L.autoLink(objs, acts).map(r => [r.id, r.code]));
  assert.deepEqual(got, { 1: 'P2F', 2: 'P2K', 3: 'P12F', 4: 'A1W', 5: 'A1F', 6: 'GE', 7: 'DK', 8: 'GE', 9: 'HR', 10: 'DK', 11: null, 12: null });
  assert.equal(L.placeOf('기초_상선_P01,P03_P46'), null);
  assert.equal(L.placeOf('기초 P06'), 'P6');
  const s = L.scoreLinks(L.autoLink(objs, acts), new Map([['1', 'P2F'], ['3', 'P2F'], ['11', 'P12F']]));
  assert.deepEqual([s.correct, s.wrong, s.open], [1, 1, 1]);
});

test('auto link: IFC class separates girders (IfcBeam) from deck pieces drawn with the same WPC family', () => {
  const acts = [
    { code: 'GE', name: 'WPC거더 거치', path: ['상부공', '상부공'] },
    { code: 'DK', name: '공동구(Leveling 콘크리트 포함)', path: ['상부공', '상부공'] },
  ];
  const objs = [
    { id: 'b', name: 'WPC_40m', type: 'WPC_40m', ifcClass: 'IfcBeam' },
    { id: 'x', name: 'WPC_40m', type: 'WPC_40m', ifcClass: 'IfcBuildingElementProxy' },
    { id: 'r', name: 'WPC_40m', type: 'WPC_40m' },
    { id: 'l', label: '상선_거더_S3', name: 'WPC_40m', ifcClass: 'IfcBuildingElementProxy' },
  ];
  const got = Object.fromEntries(L.autoLink(objs, acts).map(r => [r.id, r.code]));
  assert.deepEqual(got, { b: 'GE', x: 'DK', r: 'GE', l: 'GE' });
});

test('auto link: superstructure by the span in the object label, split foundations by pile or not', () => {
  const acts = [
    { code: 'G01', name: 'WPC거더 거치 S1~S5', path: ['상부공'] },
    { code: 'G02', name: 'WPC거더 거치 S6~S10', path: ['상부공'] },
    { code: 'G10', name: 'WPC거더 거치 S46', path: ['상부공'] },
    { code: 'D01', name: '공동구(Leveling 콘크리트 포함) S1~S5', path: ['상부공'] },
    { code: 'D02', name: '공동구(Leveling 콘크리트 포함) S6~S10', path: ['상부공'] },
    { code: 'A1F', name: '말뚝·가시설·토공', path: ['하부공', 'A1'] },
    { code: 'A1F2', name: '기초', path: ['하부공', 'A1'] },
    { code: 'A1W', name: '벽체', path: ['하부공', 'A1'] },
  ];
  const objs = [
    { id: 'g3', label: '상선_거더_S03', name: 'WPC_27.5m_2.3m_1', ifcClass: 'IfcBeam' },
    { id: 'g6', label: '상선_거더_S06', name: 'WPC_35m_우_1', ifcClass: 'IfcBeam' },
    { id: 'g46', label: '상선_거더_S46', name: 'WPC_40m_1', ifcClass: 'IfcBeam' },
    { id: 's7', label: '상선_상부슬래브_S07', name: 'Structural Framing 1' },
    { id: 'b', label: '교량받침', name: '받침' },
    { id: 'p', label: '교대 A1 말뚝', name: '강관말뚝' },
    { id: 'lean', label: '교대 A1 버림콘크리트', name: '버림콘크리트' },
    { id: 'w', label: '교대 A1', name: '교대' },
  ];
  const got = Object.fromEntries(L.autoLink(objs, acts).map(r => [r.id, r.code]));
  assert.deepEqual(got, { g3: 'G01', g6: 'G02', g46: 'G10', s7: 'D02', b: null, p: 'A1F', lean: 'A1F2', w: 'A1W' });
  assert.deepEqual([L.spanOf('상선_거더_S03'), L.spanOf('SHEET PILE'), L.spanOf('S1,S2')], [3, null, null]);
  assert.deepEqual(L.spansOfName('WPC거더 거치 S11~S15'), { lo: 11, hi: 15 });
});

test('model properties: an IFC model keeps its elements only (type nodes have no IfcClass); Revit models unchanged', () => {
  const P = compile('api/aps-props.ts', { '@supabase/supabase-js': {}, 'aws4fetch': { AwsClient: class {} } });
  const el = { id: 1, ifcClass: 'IfcBeam' }, typeNode = { id: 2, ifcClass: '' }, rvt = { id: 3, ifcClass: '' };
  assert.deepEqual(P.elementsOnly([el, typeNode]).map(o => o.id), [1]);
  assert.deepEqual(P.elementsOnly([rvt, typeNode]).map(o => o.id), [3, 2]);
});

test('model properties: Revit objects and IFC elements (Family:Type:Tag, no user properties) both summarize', () => {
  const P = compile('api/aps-props.ts', { '@supabase/supabase-js': {}, 'aws4fetch': { AwsClient: class {} } });
  const rvt = P.summarize({ objectid: 1, name: '기초_상선_P01,P03_P46 [123]', externalId: 'u1', properties: { 기타: { '유형 이름': 'P12', 'A1_객체명칭': '기초 P12', 'A3_WBS CODE (IPS)': 'X1', IfcGUID: 'g1' }, 치수: { 체적: '12.5 m^3' } } });
  assert.deepEqual([rvt.name, rvt.type, rvt.label, rvt.code, rvt.volume, rvt.ifcClass], ['기초_상선_P01,P03_P46', 'P12', '기초 P12', 'X1', 12.5, '']);
  const ifc = P.summarize({ objectid: 2, name: '교각_상선_P01,P03_P46:P12:1128979', externalId: 'g2', properties: {
    Item: { Name: '교각_상선_P01,P03_P46:P12:1128979', Type: 'IfcBuildingElementProxy: 교각_상선_P01,P03_P46:P12' },
    Element: { IfcClass: 'IfcBuildingElementProxy', IfcGUID: 'g2', IfcName: '교각_상선_P01,P03_P46:P12:1128979' } } });
  assert.deepEqual([ifc.name, ifc.type, ifc.ifcClass, ifc.ifcGuid], ['교각_상선_P01,P03_P46', 'P12', 'IfcBuildingElementProxy', 'g2']);
  assert.equal(P.summarize({ objectid: 3, name: 'WPC:WPC', properties: { Item: { Type: 'Family' }, 'IFC Type': { 'IfcName [Type]': 'WPC:WPC' } } }), null, '유형 노드');
  assert.equal(P.summarize({ objectid: 4, name: '레벨 1', properties: { Element: { IfcClass: 'IfcBuildingStorey' } } }), null, '공간 요소');
  // 자동 연결까지: IFC 유형 칸의 개소(P12)와 이름의 부위(교각)
  const r = L.autoLink([{ id: '2', name: ifc.name, type: ifc.type, ifcClass: ifc.ifcClass }], [{ code: 'P12C', name: '교각시공', path: ['하부공', 'P12'] }]);
  assert.equal(r[0].code, 'P12C');
});

test('BOQ: numbered sections with item counts, structure-name guess across 상·하선, items of a section', () => {
  const B = compile('src/lib/sim45d/boq.ts');
  const rows = [
    ['2. 구조물공'],
    ['2-1. 연제교'], ['(요약표)'],
    ['2-1. 연제교'], ['콘크리트', '25-24-15', 120, 'M3', 0, 0, 0, 0, 0, 0, 0, 1200000], ['거푸집', '합판', 300, 'M2', 0, 0, 0, 0, 0, 0, 0, 900000], ['공통가설', '', 1, '식', 0, 0, 0, 0, 0, 0, 0, 50],
    ['2-2. 연제천교'], ['철근', 'D25', 3, 'TON', 0, 0, 0, 0, 0, 0, 0, 3000000],
  ];
  const secs = B.boqSections(rows);
  assert.deepEqual(secs.find(x => x.title === '2-1. 연제교'), { title: '2-1. 연제교', lines: 2 });
  assert.equal(B.guessBoqSection(secs, '연제교 상선'), '2-1. 연제교');
  assert.equal(B.guessBoqSection(secs, '연제교(하선)'), '2-1. 연제교');
  assert.equal(B.guessBoqSection(secs, '오송터널'), null);
  assert.deepEqual(B.boqLines(rows, '2-1. 연제교').map(l => [l.name, l.unit, l.amount]), [['콘크리트', 'M3', 1200000], ['거푸집', 'M2', 900000]]);
});

test('confirmed schedule: adopted draft IPS counts without a P6 upload; an uploaded P6 revision wins', () => {
  const xer = compile('src/lib/p6/xer.ts');
  const cpm = compile('src/lib/p6/cpm.ts');
  const p6 = compile('src/lib/p6/schedule.ts', { './xer.js': xer, './cpm.js': cpm });
  const B = compile('src/lib/p6/bridgePlan.ts', { './schedule.js': p6 });
  const C = compile('src/lib/sim45d/confirmed.ts', { '../p6/bridgePlan.js': B, '../p6/schedule.js': p6, '../p6/xer.js': xer, './setup.js': s });
  const supports = ['A1', 'P1', 'P2', 'P3', 'A2'].map((id, i) => ({ id, kind: id[0] === 'A' ? 'abutment' : 'pier', pileType: 'cast', pileCount: 1, ...(i === 2 ? { heightM: 10.1 } : {}) }));
  let d = s.emptySetup();
  d = s.addFile(d, 'model', file('m', 'BR01.ifc'));
  d = { ...d, site: { name: '연제교 상선', code: 'BR01', supports, spans: B.spansFromSupports(supports) }, plan: { ...s.emptyPlan(), start: '2024-01-05' } };
  // 처음에는 P6 가 없다 — 업로드가 아니라 '안 채택'이 빠진 것
  assert.equal(C.confirmedSource(d), null);
  assert.equal(s.hasConfirmedSchedule(d), false);
  assert.equal(s.stepStatus(d, 'draft', 'x').state, 'todo', '시작일만 있고 채택 전');
  assert.deepEqual(s.stepStatus(d, 'link', 'x').missing.map(m => m.key), ['p6']);
  assert.equal(s.stepStatus(d, 'p6', 'x').state, 'todo');
  assert.equal(C.adoptedSchedule(d), null);

  const plans = B.proposePlans({ site: d.site, start: '2024-01-05', rates: C.planRates(d.plan) });
  const b = plans.find(p => p.key === 'B');
  d = { ...d, plan: { ...d.plan, adopted: { title: b.title, levers: b.result.levers, at: '2026-10-26T00:00:00Z' } } };
  assert.equal(s.hasConfirmedSchedule(d), true);
  assert.deepEqual(C.confirmedSource(d), { kind: 'draft', title: b.title, at: '2026-10-26T00:00:00Z', label: `채택한 개략 IPS(${b.title})` });
  assert.equal(s.stepStatus(d, 'draft', 'x').state, 'done');
  assert.equal(s.stepStatus(d, 'p6', 'x').state, 'done', 'P6 수정본은 선택');
  assert.deepEqual(s.stepStatus(d, 'link', 'x').missing, []);
  const sch = C.adoptedSchedule(d);
  assert.equal(sch.activities.length, b.result.draft.activities.length, '화면에서 본 안과 같은 공정표');
  assert.ok(sch.activities.every(a => a.code.startsWith('BR01')));
  const reread = p6.readSchedule(xer.parseXer(xer.decodeXer(C.planXerBytes(C.adoptedPlan(d))).text));
  assert.equal(reread.activities.length, sch.activities.length, 'XER 로 내보내 다시 읽어도 같음');
  assert.equal(C.planXerName('BR01', b.title), 'BR01_개략IPS_B안.xer');
  // 6단계에서 맞춘 모델 코드: 채택안은 그 코드로, raw 는 엔진 코드 그대로(다시 맞출 때), 저장·불러오기에 남음
  const withMap = { ...d, codeMaps: [{ modelItemId: 'm', at: 'x', map: { 'BR01-P1-F': '311311C5C20020045', 'BR01-P1-C': 'BAD' } }, { modelItemId: 'n', at: 'y', map: { 'BR01-P1-F': 'LATER' } }] };
  assert.deepEqual(s.codeMapOf(withMap), { 'BR01-P1-F': '311311C5C20020045', 'BR01-P1-C': 'BAD' }, '먼저 저장한 모델이 우선');
  assert.ok(C.adoptedSchedule(withMap).activities.some(a => a.code === '311311C5C20020045'));
  assert.ok(C.adoptedSchedule(withMap, { raw: true }).activities.some(a => a.code === 'BR01-P1-F'));
  assert.deepEqual(s.normalizeSetup({ ...withMap, codeMaps: [...withMap.codeMaps, { modelItemId: 3 }, { modelItemId: 'z', map: { a: 1, b: 'ok' } }] }).codeMaps.map(c => c.map),
    [withMap.codeMaps[0].map, withMap.codeMaps[1].map, { b: 'ok' }]);
  // 저장·불러오기: 채택안은 남고, 망가진 값은 버린다
  assert.deepEqual(s.normalizeSetup(d).plan.adopted, d.plan.adopted);
  assert.equal(s.normalizeSetup({ ...d, plan: { ...d.plan, adopted: { title: 'x', at: 'y', levers: { rigs: 0 } } } }).plan.adopted, undefined);
  // 단위공기를 바꾸면 같은 투입안이라도 날짜가 따라 바뀐다(투입안만 고정)
  const slower = { ...d, plan: { ...d.plan, rates: { castPile: 30 }, rateNotes: { castPile: '시험' } } };
  assert.ok(C.adoptedPlan(slower).durationDays > C.adoptedPlan(d).durationDays);

  // P6 에서 고쳐 올리면 그것이 확정
  const up = s.addFile(d, 'p6', file('x', '311.xer'));
  assert.equal(C.confirmedSource(up).kind, 'p6');
  assert.equal(C.confirmedSource(up).label, '올린 P6 공정표 311.xer');
});

test('skip: an already-made schedule skips design and draft; done wins over skipped; unknown keys dropped', () => {
  let d = s.addFile(s.emptySetup(), 'model', file('m', 'BR01.ifc'));
  d = s.setSkipped(d, ['design', 'draft'], true);
  assert.deepEqual(d.skipped, ['design', 'draft']);
  assert.equal(s.stepStatus(d, 'design', 'x').state, 'skipped');
  assert.equal(s.stepStatus(d, 'draft', 'x').state, 'skipped');
  assert.equal(s.stepStatus(d, 'p6', 'x').state, 'todo', '공정표를 올리기 전');
  d = s.addFile(d, 'p6', file('x', '사람이 짠 공정표.xer'));
  assert.equal(s.stepStatus(d, 'p6', 'x').state, 'done');
  assert.deepEqual(s.stepStatus(d, 'link', 'x').missing, [], '올린 공정표로 BIM 연결 가능');
  d = { ...d, site: { name: 'x', code: 'BR01', supports: [{ id: 'P1', kind: 'pier', pileType: 'cast', pileCount: 1 }], spans: [] } };
  assert.equal(s.stepStatus(d, 'design', 'x').state, 'done', '나중에 해도 완료가 우선');
  assert.deepEqual(s.normalizeSetup({ ...d, skipped: ['draft', 'sim', 'nope'] }).skipped, ['draft'], '건너뛸 수 없는 단계는 버림');
  d = s.setSkipped(d, ['design', 'draft'], false);
  assert.equal('skipped' in d, false);
  for (const st of s.STEPS) assert.ok(st.guide.length > 10, `${st.key} 안내`);
});

test('model dates: RVT A5 dates join the draft by place+part; start aligned; order and part durations', () => {
  const xer = compile('src/lib/p6/xer.ts');
  const cpm = compile('src/lib/p6/cpm.ts');
  const p6 = compile('src/lib/p6/schedule.ts', { './xer.js': xer, './cpm.js': cpm });
  const B = compile('src/lib/p6/bridgePlan.ts', { './schedule.js': p6 });
  const L = compile('src/lib/sim45d/autolink.ts');
  const M = compile('src/lib/sim45d/modelDates.ts', { '../p6/bridgePlan.js': B, '../p6/schedule.js': p6, './autolink.js': L });
  assert.equal(M.ymd('2025.6.3'), '2025-06-03');
  assert.equal(M.ymd(''), null);
  // 현장: P2 를 먼저, P1 을 나중에(엔진은 시점부터)
  const o = (name, label, s, f) => ({ name, label, actualStart: s, actualFinish: f, plannedStart: s, plannedFinish: f });
  const objs = [
    o('기초_상선', '기초 P2', '2024-05-01', '2024-05-08'), o('기초_상선', '기초 P1', '2024-07-01', '2024-07-08'),
    o('교각_상선', '교각 P2', '2024-05-20', '2024-06-10'), o('교각_상선', '교각 P1', '2024-07-20', '2024-08-10'),
    o('코핑_상선', '코핑 P2', '2024-06-15', '2024-07-05'), o('코핑_상선', '코핑 P1', '2024-08-15', '2024-09-05'),
    o('WPC_40m', '', '2024-10-01', '2024-11-30'), o('잡것', '', '2024-01-01', '2024-01-02'),
    { name: '교각_상선', label: '교각 P3' }, // 날짜 없음 → 뺌
  ];
  const model = M.modelSpans(objs, 'actual');
  assert.deepEqual([...model.keys()].sort(), ['P1|coping', 'P1|foundation', 'P1|pier', 'P2|coping', 'P2|foundation', 'P2|pier', 'super']);
  assert.equal(M.firstSubStart(model), '2024-05-01');
  assert.deepEqual(M.startOrder(model, 'pier'), ['P2', 'P1']);
  assert.deepEqual(M.concurrency(model, 'pier'), { max: 1, mean: 0.5 }); // 22일 × 2 / 5/20~8/10(83일)
  const supports = ['A1', 'P1', 'P2', 'A2'].map(id => ({ id, kind: id[0] === 'A' ? 'abutment' : 'pier', pileType: 'cast', pileCount: 1 }));
  const site = { name: '시험교', code: 'T1', supports, spans: B.spansFromSupports(supports) };
  const r = M.compareOptions(model, { site, start: '2023-01-01' }, B.PRESETS.map(p => ({ title: p.title, levers: p.levers })));
  assert.equal(r.aligned, '2024-05-01');
  for (const x of r.options) {
    assert.equal(M.firstSubStart(M.planSpans(x.result)), '2024-05-01', `${x.title}: 첫 하부 작업일을 모델에 맞춤`);
    assert.equal(x.cmp.rows.length, 6);
    assert.deepEqual(x.cmp.planOnly.sort(), ['A1|abutment', 'A1|foundation', 'A2|abutment', 'A2|foundation']);
    assert.ok(x.cmp.superstructure.model && x.cmp.superstructure.plan);
  }
  const a = r.options[0];
  assert.ok(a.cmp.order < 1, '현장 순서(P2 먼저)와 엔진 순서(P1 먼저)가 다르면 상관이 낮다');
  const days = M.partDays(a.cmp.rows);
  assert.deepEqual(days.map(d => [d.part, d.n, d.model]), [['foundation', 2, 8], ['pier', 2, 22], ['coping', 2, 22]]);
});

test('model sync: rows from confirmed schedule + links, compare with model, CSV, dates guard, stale codes excluded', () => {
  const S = compile('src/lib/sim45d/modelSync.ts');
  const models = [{ accProjectId: 'p', accItemId: 'rvt', name: 'BR01.rvt', folderNames: [], size: 1, pickedAt: '' }, { accProjectId: 'p', accItemId: 'ifc', name: 'BR01.ifc', folderNames: [], size: 1, pickedAt: '' }];
  const links = [
    { modelItemId: 'rvt', wbsRoot: 'x', at: '', links: [{ ext: 'u1', ifcGuid: 'g1', code: 'T1-P1-F', by: 'rule' }, { ext: 'u2', ifcGuid: 'g2', code: 'T1-P1-C', by: 'ai' }, { ext: 'u9', ifcGuid: 'g9', code: 'OLD-CODE', by: 'rule' }] },
    { modelItemId: 'ifc', wbsRoot: 'x', at: '', links: [{ ext: 'i3', ifcGuid: 'g3', code: 'T1-P2-F', by: 'rule' }, { ext: 'i1', ifcGuid: 'g1', code: 'T1-P1-F', by: 'rule' }] },
  ];
  const acts = [
    { code: 'T1-P1-F', name: '기초', start: '2024-05-01 08:00', finish: '2024-05-08 17:00' },
    { code: 'T1-P1-C', name: '교각시공', start: '2024-05-09', finish: '2024-05-20' },
    { code: 'T1-P2-F', name: '기초', start: '2024-06-01', finish: '2024-06-08' },
  ];
  let r = S.buildSync(links, models, acts, { withDates: true });
  assert.equal(r.counts.total, 3, '같은 객체(g1)는 한 번');
  assert.deepEqual(r.noActivity, [{ key: 'g9', code: 'OLD-CODE' }]);
  assert.deepEqual(r.rows.map(x => [x.uniqueId, x.ifcGuid, x.status]), [['u1', 'g1', 'unknown'], ['u2', 'g2', 'unknown'], ['', 'g3', 'unknown']], 'IFC 외부 ID 는 UniqueId 로 내보내지 않음');
  const objects = [
    { ext: 'u1', ifcGuid: 'g1', name: '기초', code: 'T1-P1-F', plannedStart: '2024-05-01', plannedFinish: '2024-05-08' },
    { ext: 'u2', ifcGuid: 'g2', name: '교각', code: 'WRONG', plannedStart: '2025-01-01', plannedFinish: '2025-01-10' },
  ];
  r = S.buildSync(links, models, acts, { withDates: true, objects });
  assert.deepEqual(r.rows.map(x => [x.status, x.changes.join('+')]), [['same', ''], ['change', 'code+start+finish'], ['missing', '']]);
  assert.equal(r.counts.overwriteDates, 1, '현장 일정이 있는 객체 날짜를 바꿈');
  assert.equal(r.counts.overwriteCodes, 1, '다른 코드가 있는 객체(WRONG)');
  const codeOnly = S.buildSync(links, models, acts, { withDates: false, objects });
  assert.deepEqual(codeOnly.rows.map(x => x.changes.join('+')), ['', 'code', '']);
  const csv = S.syncCsv(r.rows, true);
  assert.ok(csv.startsWith('﻿Revit UniqueId,IfcGUID,객체 이름,A3_WBS CODE (IPS),A5_계획공정시작일,A5_계획공정종료일,'));
  assert.match(csv, /\r\nu2,g2,교각,T1-P1-C,2024-05-09,2024-05-20,교각시공,WRONG,2025-01-01,2025-01-10,code\+start\+finish,ai\r\n/);
  assert.ok(!S.syncCsv(r.rows, false).includes('A5_계획공정시작일'), '날짜 끄면 A5 칸 없음(스크립트가 안 넣음)');
  assert.ok(!S.DYNAMO_SCRIPT.includes('A5_실시공정시작일') && S.DYNAMO_SCRIPT.includes('IfcGUID'));
});
