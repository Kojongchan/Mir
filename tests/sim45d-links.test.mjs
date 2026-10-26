// 6단계 코드 맞춤 · 모델 실적 · 4D 화면 객체 찾기(10-26 사용자 1·2·3번).
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
const xer = compile('src/lib/p6/xer.ts');
const cpm = compile('src/lib/p6/cpm.ts');
const p6 = compile('src/lib/p6/schedule.ts', { './xer.js': xer, './cpm.js': cpm });
const B = compile('src/lib/p6/bridgePlan.ts', { './schedule.js': p6 });
const L = compile('src/lib/sim45d/autolink.ts');
const D = compile('src/lib/sim45d/modelDates.ts', { '../p6/bridgePlan.js': B, '../p6/schedule.js': p6, './autolink.js': L });
const M = compile('src/lib/sim45d/codeMatch.ts', { './autolink.js': L });
const A = compile('src/lib/sim45d/modelActuals.ts', { './autolink.js': L, './modelDates.js': D });
const V = compile('src/lib/sim45d/viewerLinks.ts');

test('code match: an engine activity takes the model code only when the two correspond one to one', () => {
  // P2 기초: 말뚝 49 + 기초 + 버림, 모델 코드 0047. P12 기초 객체가 P2 코드로 잘못 들어감(현장 모델 실제 오류) → P2 는 51/52 로 받고 P12 는 엔진 코드.
  const links = new Map(), existing = new Map();
  for (let i = 0; i < 51; i++) { links.set(`p2-${i}`, 'BR01-P2-F'); existing.set(`p2-${i}`, '0047'); }
  links.set('p12', 'BR01-P12-F'); existing.set('p12', '0047');
  links.set('p12pile', 'BR01-P12-F'); existing.set('p12pile', '0079');
  // 상부: 실제 IPS 는 거치 한 작업(0184), 개략 IPS 는 경간 5개씩 — 나뉘므로 맞추지 않음
  for (let i = 0; i < 30; i++) { links.set(`g${i}`, i < 15 ? 'BR01-G01' : 'BR01-G02'); existing.set(`g${i}`, '0184'); }
  existing.set('bearing', '0184'); // 연결 안 된 받침도 0184
  links.set('k', 'BR01-P3-K'); existing.set('k', '0052');
  links.set('nocode', 'BR01-P4-K');
  const r = M.matchModelCodes(links, existing, new Set(['BR01-P2-F', 'BR01-P12-F', 'BR01-G01', 'BR01-G02', 'BR01-P3-K', 'BR01-P4-K']));
  assert.deepEqual(r.map, { 'BR01-P2-F': '0047', 'BR01-P3-K': '0052' });
  assert.equal(r.matched, 2);
  assert.ok(r.split.some(x => x.real === '0184' && x.draft.join() === 'BR01-G01,BR01-G02'));
});

test('link with codes: link against engine codes, then report the results in model codes', () => {
  const objects = [
    { id: 'a', label: '기초 P3', code: '311311C5C20040050' },
    { id: 'b', label: '교각 P3', code: '311311C5C20040051' },
    { id: 'c', label: '상선_거더_S03', ifcClass: 'IfcBeam', code: '311311C5C30010184' },
    { id: 'd', label: '상선_거더_S07', ifcClass: 'IfcBeam', code: '311311C5C30010184' },
  ];
  const raw = [
    { code: 'BR01-P3-F', name: '기초', path: ['하부공', 'P3'] },
    { code: 'BR01-P3-C', name: '교각시공', path: ['하부공', 'P3'] },
    { code: 'BR01-G01', name: 'WPC거더 거치 S1~S5', path: ['상부공'] },
    { code: 'BR01-G02', name: 'WPC거더 거치 S6~S10', path: ['상부공'] },
  ];
  const run = M.linkWithCodes(objects, raw, raw);
  assert.deepEqual(Object.fromEntries(run.results.map(x => [x.id, x.code])), { a: '311311C5C20040050', b: '311311C5C20040051', c: 'BR01-G01', d: 'BR01-G02' });
  assert.deepEqual(run.activities.map(x => x.code), ['311311C5C20040050', '311311C5C20040051', 'BR01-G01', 'BR01-G02']);
  // 올린 P6(실제 코드): 맞춤 없이 그대로
  const p6run = M.linkWithCodes(objects, [{ code: '311311C5C20040050', name: '기초', path: ['하부공', 'P3'] }]);
  assert.equal(p6run.match, null);
  assert.equal(p6run.results[0].code, '311311C5C20040050');
});

const sched = acts => ({ projectId: 'p', projectCode: 'T', projectName: 'T', dataDate: '2024-04-20 08:00', hoursPerDay: 8, wbs: [{ id: 'w', name: 'T', parentId: null }], relations: [],
  activities: acts.map(([code, name, start, finish]) => ({ taskId: code, code, name, wbsId: 'w', wbsPath: '', taskType: 'TT_Task', status: 'TK_NotStart', durationDays: 10, remainingDays: 10,
    start, finish, plannedStart: start, plannedFinish: finish, actualStart: null, actualFinish: null, totalFloatDays: 0, constraint: null, codes: {}, udfs: {} })) });

test('model actuals: saved link, then the model code, then the rule; finished only when every object is', () => {
  const s = sched([['F', '기초', '2024-05-01 08:00', '2024-05-11 17:00'], ['C', '교각시공', '2024-05-12 08:00', '2024-05-22 17:00'], ['K', '코핑시공', '2024-05-23 08:00', '2024-06-20 17:00']]);
  const objects = [
    { id: 1, ext: 'e1', ifcGuid: 'g1', label: '기초 P3', actualStart: '2025-06-26', actualFinish: '2025.07.02' },
    { id: 2, ext: 'e2', code: 'C', label: '교각 P3', actualStart: '2025-07-10', actualFinish: '2025-07-30' },
    { id: 3, ext: 'e3', label: '코핑 P3', actualStart: '2025-08-05', actualFinish: '' },
    { id: 4, ext: 'e4', label: '코핑 P3', actualStart: '2025-08-01', actualFinish: '2025-08-20' },
    { id: 5, ext: 'e5', label: '기초 P9' }, // 날짜 없음
  ];
  const rule = [{ code: 'K', name: '코핑시공', path: ['P3'] }];
  const m = A.actualsFromModel(objects, new Set(['F', 'C', 'K']), { links: [{ ext: 'e1', ifcGuid: 'g1', code: 'F', by: 'rule' }], rule });
  assert.deepEqual(Object.fromEntries(m.byCode), {
    F: { start: '2025-06-26', finish: '2025-07-02', objects: 1, done: 1 },
    C: { start: '2025-07-10', finish: '2025-07-30', objects: 1, done: 1 },
    K: { start: '2025-08-01', finish: null, objects: 2, done: 1 },
  });
  assert.deepEqual([m.dated, m.linked, m.latest], [4, 4, '2025-08-20']);
  const r = A.applyActuals(s, m);
  assert.equal(r.filled, 3);
  const k = r.schedule.activities.find(a => a.code === 'K');
  assert.deepEqual([k.actualStart, k.actualFinish, k.status, k.start, k.plannedStart], ['2025-08-01 08:00', null, 'TK_Active', '2025-08-01 08:00', '2024-05-23 08:00']);
  assert.equal(r.schedule.dataDate, '2025-08-20 17:00');
  // P6 에 실적이 이미 있는 작업은 그대로
  const withActual = { ...s, activities: s.activities.map(a => (a.code === 'F' ? { ...a, actualStart: '2025-01-01 08:00' } : a)) };
  assert.equal(A.applyActuals(withActual, m).schedule.activities.find(a => a.code === 'F').actualStart, '2025-01-01 08:00');
  assert.equal(A.applyActuals(s, null).filled, 0);
});

test('viewer links: links made on the structure model found in the site model by IfcGUID / UniqueId; model codes fill the rest', () => {
  const links = [
    { ext: '3PnQ', ifcGuid: '3PnQ', code: 'G01', by: 'rule' }, // IFC 로 연결 — 외부 ID = IfcGUID
    { ext: '62dc-17', ifcGuid: '', code: 'K', by: 'ai' }, // RVT 로 연결 — UniqueId
    { ext: 'gone', ifcGuid: 'gone', code: 'K', by: 'rule' },
    { ext: 'x', ifcGuid: 'x', code: 'OLD', by: 'rule' }, // 공정표에 없는 코드
  ];
  const entries = V.linkEntries(links, ['G01', 'K', 'F']);
  assert.ok(entries.includes('IfcGUID 3PnQ') && entries.includes('UniqueId 62dc-17') && entries.includes('A3_WBS CODE (IPS) F'));
  const found = { 'IfcGUID 3PnQ': [1391], 'UniqueId 62dc-17': [1500], 'A3_WBS CODE (IPS) F': [1412, 1391], 'A3_WBS CODE(IPS) F': [1413] };
  const r = V.resolveLinks(links, ['G01', 'K', 'F'], found);
  assert.deepEqual(Object.fromEntries(r.byCode), { G01: [1391], K: [1500], F: [1412, 1413] });
  assert.deepEqual([r.found, r.missing, r.byModelCode], [2, 1, 2]);
});

test('property index lookup: exact "label value" entries, case-insensitive', () => {
  const { PropSearchIndex } = compile('src/viewer/PropSearchIndex.ts');
  const idx = new PropSearchIndex();
  idx.addShard({ 10: { p: [['요소', 'IfcGUID', '1YtB3Cbg'], ['사용자', 'A3_WBS CODE (IPS)', '311311C5C20040050']] }, 11: { p: [['요소', 'IfcGUID', '1YtB3Cbgx']] } });
  idx.seal();
  assert.deepEqual(idx.lookup(['IfcGUID 1YtB3Cbg', 'A3_WBS CODE (IPS) 311311C5C20040050', 'IfcGUID none']),
    { 'IfcGUID 1YtB3Cbg': [10], 'A3_WBS CODE (IPS) 311311C5C20040050': [10], 'IfcGUID none': [] });
});
