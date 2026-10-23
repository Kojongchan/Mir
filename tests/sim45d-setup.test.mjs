import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', code)(exports, name => { throw new Error(`unexpected import ${name}`); });
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
  st = s.stepStatus(d, 'link', '연제교');
  assert.equal(st.state, 'planned');
  assert.deepEqual(st.missing.map(x => x.key), ['p6']);
  assert.equal(s.stepStatus(d, 'p6', '연제교').state, 'todo');
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
