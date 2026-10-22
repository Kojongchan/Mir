import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, modules = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', code)(exports, name => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  });
  return exports;
}
const xer = compile('src/lib/p6/xer.ts');
const cpm = compile('src/lib/p6/cpm.ts');
const p6 = compile('src/lib/p6/schedule.ts', { './xer': xer, './cpm': cpm });
const tl = compile('src/lib/sim45d/timeline.ts', { '../p6/schedule': p6 });

const schedule = p6.readSchedule(p6.buildXer({
  project: { code: 'T', name: '시험', start: '2026-11-02' },
  wbs: [{ code: 'W', name: '교량' }],
  activities: [
    { code: 'M0', name: '착공', wbs: 'W', durationDays: 0, milestone: 'start' },
    { code: 'A', name: '기초', wbs: 'W', durationDays: 10 },
    { code: 'B', name: '교각', wbs: 'W', durationDays: 10 },
  ],
  relations: [{ pred: 'M0', succ: 'A' }, { pred: 'A', succ: 'B' }],
}));
const acts = tl.timedActivities(schedule);
const at = s => p6.parseXerDate(s);

test('activities become timed spans; milestones are flagged and the range covers whole days', () => {
  assert.equal(acts.length, 3);
  assert.ok(acts.find(a => a.code === 'M0').milestone);
  const r = tl.scheduleRange(acts);
  assert.equal(new Date(r.start).getHours(), 0);
  assert.equal(new Date(r.end).getDate(), 21); // B: 11/12 ~ 11/21
});

test('progress is duration weighted, or cost weighted when costs are given', () => {
  const p = tl.progressAt(acts, at('2026-11-07 00:00')); // A 진행 중, B 예정
  assert.ok(p.progress > 0.2 && p.progress < 0.3, String(p.progress));
  assert.equal(p.activeCount, 1);
  const c = tl.progressAt(acts, at('2026-11-15 00:00'), new Map([['A', 300], ['B', 100]]));
  assert.equal(c.costTotal, 400);
  assert.ok(c.cost > 300 && c.cost < 350, String(c.cost));
});

test('4D state: active painted, future hidden (or grey), done and unlinked untouched', () => {
  const links = new Map([['A', [1, 2]], ['B', [2, 3]]]);
  const t = at('2026-11-07 00:00');
  const hide = tl.fourDState(acts, links, t, 8, { hideFuture: true });
  // 1: A 진행 → 초록 · 2: A 진행 + B 예정 → 진행이 이김 · 3: B 예정 → 숨김 · 4: 연결 없음
  assert.deepEqual([...hide.paint.subarray(4, 8)], [...tl.FOUR_D_COLORS.active, 255]);
  assert.deepEqual([...hide.paint.subarray(8, 12)], [...tl.FOUR_D_COLORS.active, 255]);
  assert.deepEqual(hide.hidden, [3]);
  assert.equal(hide.paint[4 * 4 + 3], 0);
  const grey = tl.fourDState(acts, links, t, 8, { hideFuture: false });
  assert.deepEqual(grey.hidden, []);
  assert.deepEqual([...grey.paint.subarray(12, 16)], [...tl.FOUR_D_COLORS.future, 255]);
  const done = tl.fourDState(acts, links, at('2026-12-01 00:00'), 8, { hideFuture: true });
  assert.equal(done.painted, 0);
  assert.deepEqual(done.hidden, []);
});

test('S-curve rises from 0 to 1 across the range', () => {
  const curve = tl.sCurve(acts, tl.scheduleRange(acts), undefined, 10);
  assert.equal(curve.length, 11);
  assert.equal(curve[0].progress, 0);
  assert.equal(curve[10].progress, 1);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].progress >= curve[i - 1].progress);
});
