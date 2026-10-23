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
