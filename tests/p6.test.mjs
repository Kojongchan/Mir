import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, modules = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const require = name => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  };
  new Function('exports', 'require', code)(exports, require);
  return exports;
}
const xer = compile('src/lib/p6/xer.ts');
const cpm = compile('src/lib/p6/cpm.ts');
const p6 = compile('src/lib/p6/schedule.ts', { './xer': xer, './cpm': cpm });

const SAMPLE = [
  'ERMHDR\t19.12\t2026-10-22\tProject\tadmin\tadmin\tdbxDatabaseNoName\tProject Management\tKRW',
  '%T\tRSRC',
  '%F\trsrc_id\trsrc_name\trsrc_short_name',
  '%R\t7\t굴착기 1.0㎥\tEX10',
  '%T\tPROJECT',
  '%F\tproj_id\tproj_short_name\tclndr_id\tlast_recalc_date',
  '%R\t5\tPO-5\t3', // 끝 칸 생략(P6 가 그렇게 쓰기도 함)
  '%E',
].join('\r\n') + '\r\n';

test('unknown tables and short rows survive a parse/serialize round trip', () => {
  const doc = xer.parseXer(SAMPLE);
  assert.deepEqual(doc.tables.map(t => t.name), ['RSRC', 'PROJECT']);
  assert.deepEqual(doc.tables[1].rows[0], ['5', 'PO-5', '3', '']);
  assert.equal(xer.records(doc.tables[0])[0].rsrc_name, '굴착기 1.0㎥');
  const again = xer.parseXer(xer.serializeXer(doc));
  assert.deepEqual(again, doc);
});

test('not an XER file and stray lines are reported', () => {
  assert.throws(() => xer.parseXer('hello'), /XER/);
  assert.throws(() => xer.parseXer('ERMHDR\t19.12\n%R\t1'), /%T 없이 %R/);
});

test('tabs and line breaks inside values do not break the file', () => {
  const doc = { header: ['19.12'], tables: [{ name: 'TASK', fields: ['task_id', 'task_name'], rows: [['1', '교각\t기초\r\n타설']] }] };
  assert.equal(xer.parseXer(xer.serializeXer(doc)).tables[0].rows[0][1], '교각 기초 타설');
});

test('CP949 encoding round trips Korean text; characters outside CP949 become ?', () => {
  const text = 'ERMHDR\t19.12\r\n%T\tTASK\r\n%F\ttask_name\r\n%R\tP3 교각 콘크리트 타설 (25-24-15) ㎥ ￦\r\n%E\r\n';
  const bytes = xer.encodeCp949(text);
  assert.ok(bytes.length < new TextEncoder().encode(text).length, 'CP949 uses 2 bytes per Hangul syllable');
  const { text: back, encoding } = xer.decodeXer(bytes);
  assert.equal(encoding, 'cp949');
  assert.equal(back, text);
  assert.equal(new TextDecoder('euc-kr').decode(xer.encodeCp949('a₩b')), 'a?b');
  assert.equal(xer.decodeXer(new TextEncoder().encode('교량')).encoding, 'utf-8');
});

test('CP949 extras outside WHATWG euc-kr (€ ®) survive a byte round trip', () => {
  // 실제 P6 XER 의 CURRTYPE 행: EUR 기호가 CP949 0xA2E6 으로 저장된다.
  const bytes = Uint8Array.of(0x45, 0x55, 0x52, 0x09, 0xa2, 0xe6, 0x09, 0xc7, 0xd1, 0xa2, 0xe7, 0x0d, 0x0a);
  const { text, encoding } = xer.decodeXer(bytes);
  assert.equal(encoding, 'cp949');
  assert.equal(text, 'EUR\t€\t한®\r\n');
  assert.deepEqual(xer.encodeXer(text, 'cp949'), bytes);
});

test('CPM: forward/backward pass with FS, SS+lag and critical path', () => {
  const r = cpm.computeCpm(
    [{ id: 'A', duration: 3 }, { id: 'B', duration: 2 }, { id: 'C', duration: 5 }, { id: 'D', duration: 1 }],
    [
      { pred: 'A', succ: 'B', type: 'FS', lag: 0 },
      { pred: 'A', succ: 'C', type: 'SS', lag: 1 },
      { pred: 'B', succ: 'D', type: 'FS', lag: 0 },
      { pred: 'C', succ: 'D', type: 'FS', lag: 0 },
    ],
  );
  assert.equal(r.duration, 7);
  assert.deepEqual(Object.fromEntries([...r.times].map(([id, t]) => [id, [t.es, t.ef, t.float]])), {
    A: [0, 3, 0], C: [1, 6, 0], B: [3, 5, 1], D: [6, 7, 0],
  });
  assert.deepEqual(r.critical.sort(), ['A', 'C', 'D']);
});

test('CPM: FF and SF constraints, and cycles are refused', () => {
  const r = cpm.computeCpm([{ id: 'X', duration: 4 }, { id: 'Y', duration: 2 }, { id: 'Z', duration: 3 }], [
    { pred: 'X', succ: 'Y', type: 'FF', lag: 0 }, // Y 는 X 와 같이 끝남 → 2일째 시작
    { pred: 'X', succ: 'Z', type: 'SF', lag: 5 }, // Z 는 X 시작 5일 뒤에 끝남 → 2일째 시작
  ]);
  assert.equal(r.times.get('Y').es, 2);
  assert.equal(r.times.get('Z').es, 2);
  assert.throws(
    () => cpm.computeCpm([{ id: 'P', duration: 1 }, { id: 'Q', duration: 1 }], [
      { pred: 'P', succ: 'Q', type: 'FS', lag: 0 }, { pred: 'Q', succ: 'P', type: 'FS', lag: 0 },
    ]),
    err => err instanceof cpm.CpmCycleError && err.ids.length === 2,
  );
});

const DRAFT = {
  project: { code: 'PO5-BR01', name: '평택오송 5공구 ○○교', start: '2026-11-02' },
  wbs: [
    { code: 'BR01', name: '○○교' },
    { code: 'SUB', name: '하부공', parent: 'BR01' },
    { code: 'SUP', name: '상부공', parent: 'BR01' },
  ],
  activities: [
    { code: 'BR01-M000', name: '착공', wbs: 'BR01', durationDays: 0, milestone: 'start' },
    { code: 'BR01-P03-F', name: 'P3 기초 콘크리트', wbs: 'SUB', durationDays: 7,
      codes: { 구조물: 'BR01', 부위: '기초' }, udfs: { 'STA시작': 12340, 'STA끝': 12352, 'MIR키': 'BR01.P03.FOOT' } },
    { code: 'BR01-P03-C', name: 'P3 교각 콘크리트', wbs: 'SUB', durationDays: 10,
      codes: { 구조물: 'BR01', 부위: '교각' }, udfs: { 'STA시작': 12340, 'STA끝': 12352, 'MIR키': 'BR01.P03.COL' } },
    { code: 'BR01-G03', name: 'S3 거더 거치', wbs: 'SUP', durationDays: 3,
      codes: { 구조물: 'BR01', 부위: '거더' }, udfs: { 'STA시작': 12352, 'STA끝': 12392, 'MIR키': 'BR01.S03.GIRDER' } },
  ],
  relations: [
    { pred: 'BR01-M000', succ: 'BR01-P03-F' },
    { pred: 'BR01-P03-F', succ: 'BR01-P03-C', lagDays: 2 }, // 양생 2일
    { pred: 'BR01-P03-C', succ: 'BR01-G03', type: 'FS', lagDays: 7 },
  ],
};

test('draft → XER → read back keeps activities, WBS, relations, codes, UDFs and CPM dates', () => {
  const doc = xer.parseXer(xer.serializeXer(p6.buildXer(DRAFT)));
  const names = doc.tables.map(t => t.name);
  for (const t of ['PROJECT', 'CALENDAR', 'PROJWBS', 'ACTVTYPE', 'ACTVCODE', 'UDFTYPE', 'TASK', 'TASKACTV', 'TASKPRED', 'UDFVALUE']) assert.ok(names.includes(t), t);
  const s = p6.readSchedule(doc);
  assert.equal(s.projectCode, 'PO5-BR01');
  assert.equal(s.projectName, '평택오송 5공구 ○○교');
  assert.equal(s.hoursPerDay, 8);
  const byCode = Object.fromEntries(s.activities.map(a => [a.code, a]));
  const col = byCode['BR01-P03-C'];
  assert.equal(col.wbsPath, 'BR01.SUB');
  assert.equal(col.durationDays, 10);
  assert.deepEqual(col.codes, { 구조물: 'BR01', 부위: '교각' });
  assert.deepEqual(col.udfs, { 'STA시작': 12340, 'STA끝': 12352, 'MIR키': 'BR01.P03.COL' });
  // 착공 11/2 → 기초 11/2~11/8 → 양생 2일 → 교각 11/11~11/20 → 7일 → 거더 11/28~11/30
  assert.equal(byCode['BR01-P03-F'].start, '2026-11-02 08:00');
  assert.equal(byCode['BR01-P03-F'].finish, '2026-11-08 17:00');
  assert.equal(col.start, '2026-11-11 08:00');
  assert.equal(col.finish, '2026-11-20 17:00');
  assert.equal(byCode['BR01-G03'].start, '2026-11-28 08:00');
  assert.equal(byCode['BR01-M000'].taskType, 'TT_Mile');
  assert.deepEqual(s.relations.find(r => r.succ === 'BR01-P03-C'), { pred: 'BR01-P03-F', succ: 'BR01-P03-C', type: 'FS', lagDays: 2 });

  const tasks = p6.toScheduleTasks(s);
  assert.equal(tasks.length, 4);
  const t = tasks.find(x => x.id === 'BR01-G03');
  assert.equal(t.custom['MIR키'], 'BR01.S03.GIRDER');
  assert.ok(t.end > t.start);
});

test('CP949 export keeps Korean names readable after decoding', () => {
  const bytes = xer.encodeXer(xer.serializeXer(p6.buildXer(DRAFT)));
  const s = p6.readSchedule(xer.parseXer(xer.decodeXer(bytes).text));
  assert.equal(s.activities.find(a => a.code === 'BR01-P03-C').name, 'P3 교각 콘크리트');
});

test('a P6 template supplies the column layout, calendar and hours per day', () => {
  const template = {
    header: ['22.12', '2026-01-01', 'Project', 'kr', 'kr', 'dbxDatabaseNoName', 'Project Management', 'KRW'],
    tables: [
      { name: 'CALENDAR', fields: ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'clndr_type', 'day_hr_cnt', 'clndr_data'],
        rows: [['10', 'Y', '공단 기본', '', '', 'CA_Base', '8', 'x'], ['11', 'N', '현장 10시간', '999', '10', 'CA_Project', '10', 'y'], ['12', 'N', '안 씀', '', '', 'CA_Base', '8', 'z']] },
      { name: 'PROJECT', fields: ['proj_id', 'clndr_id'], rows: [['999', '11']] },
      { name: 'TASK', fields: ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'task_code', 'task_name', 'task_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'early_start_date', 'early_end_date', 'location_id', 'new_field_from_p6_23'], rows: [] },
    ],
  };
  const doc = p6.buildXer(DRAFT, template);
  assert.equal(doc.header[0], '22.12');
  const cal = xer.records(xer.getTable(doc, 'CALENDAR'));
  assert.deepEqual(cal.map(c => [c.clndr_id, c.proj_id]), [['10', ''], ['11', '1']]);
  const task = xer.getTable(doc, 'TASK');
  assert.ok(task.fields.includes('new_field_from_p6_23'));
  assert.equal(xer.records(task).find(t => t.task_code === 'BR01-P03-C').target_drtn_hr_cnt, '100');
  const s = p6.readSchedule(xer.parseXer(xer.serializeXer(doc)));
  assert.equal(s.hoursPerDay, 10);
  assert.equal(s.activities.find(a => a.code === 'BR01-P03-C').durationDays, 10);
});

test('a template UDF with the same label is reused (id and data type), not duplicated', () => {
  // 실제 IPS XER: 계약금액 = FT_MONEY UDF. 같은 라벨을 새로 만들면 P6 에 같은 이름 UDF 가 하나 더 생긴다.
  const template = {
    header: ['23.0', '2025-03-17', 'Project', 'admin', 'admin', 'dbxDatabaseNoName', 'Project Management', 'USD'],
    tables: [
      { name: 'UDFTYPE', fields: ['udf_type_id', 'table_name', 'udf_type_name', 'udf_type_label', 'logical_data_type', 'super_flag', 'indicator_expression', 'summary_indicator_expression'],
        rows: [['299', 'TASK', 'user_field_299', '계약금액', 'FT_MONEY', 'N', '', ''], ['305', 'TASK', 'user_field_305', '공정률', 'FT_FLOAT_2_DECIMALS', 'N', '', '']] },
    ],
  };
  const draft = { ...DRAFT, activities: DRAFT.activities.map((a, i) => ({ ...a, udfs: { ...a.udfs, 계약금액: 1000 * (i + 1) } })) };
  const doc = p6.buildXer(draft, template);
  const types = xer.records(xer.getTable(doc, 'UDFTYPE'));
  const money = types.filter(u => u.udf_type_label === '계약금액');
  assert.equal(money.length, 1);
  assert.deepEqual([money[0].udf_type_id, money[0].logical_data_type], ['299', 'FT_MONEY']);
  assert.ok(types.filter(u => u.udf_type_label !== '계약금액').every(u => Number(u.udf_type_id) > 305), 'new UDF ids do not collide');
  const s = p6.readSchedule(xer.parseXer(xer.serializeXer(doc)));
  assert.equal(s.activities.find(a => a.code === 'BR01-P03-C').udfs['계약금액'], 3000);
  assert.equal(s.activities.find(a => a.code === 'BR01-P03-C').udfs['MIR키'], 'BR01.P03.COL');
});

test('re-upload diff: added, removed and changed activities by Activity ID', () => {
  const before = p6.readSchedule(p6.buildXer(DRAFT));
  const edited = structuredClone(DRAFT);
  edited.activities[2].durationDays = 12;              // 교각 일수 변경
  edited.activities[2].name = 'P3 교각 구체';
  edited.activities.splice(3, 1);                       // 거더 삭제
  edited.relations = edited.relations.filter(r => r.succ !== 'BR01-G03');
  edited.activities.push({ code: 'BR01-P03-C2', name: 'P3 교각 2차 타설', wbs: 'SUB', durationDays: 4,
    codes: { 구조물: 'BR01', 부위: '교각' }, udfs: { 'MIR키': 'BR01.P03.COL' } }); // P6 에서 복사로 쪼갠 작업
  const d = p6.diffSchedules(before, p6.readSchedule(p6.buildXer(edited)));
  assert.deepEqual(d.added.map(a => a.code), ['BR01-P03-C2']);
  assert.deepEqual(d.removed.map(a => a.code), ['BR01-G03']);
  const change = d.changed.find(c => c.code === 'BR01-P03-C');
  assert.ok(change.fields.includes('name') && change.fields.includes('duration') && change.fields.includes('finish'));
  assert.equal(d.added[0].udfs['MIR키'], 'BR01.P03.COL', 'the split keeps the link key');
});

test('relations to unknown activities and unknown WBS are refused', () => {
  assert.throws(() => p6.buildXer({ ...DRAFT, relations: [{ pred: 'NOPE', succ: 'BR01-G03' }] }), /없는 작업/);
  assert.throws(() => p6.buildXer({ ...DRAFT, activities: [{ ...DRAFT.activities[1], wbs: 'ZZZ' }], relations: [] }), /없는 WBS/);
});

const check = compile('src/lib/p6/check.ts');

test('schedule check: out-of-sequence actuals, structure order, leads, stale data date, long tasks', () => {
  const a = (code, name, wbsId, x = {}) => ({
    taskId: code, code, name, wbsId, wbsPath: wbsId, taskType: 'TT_Task', status: 'TK_NotStart', durationDays: 5, remainingDays: 5,
    start: null, finish: null, plannedStart: null, plannedFinish: null, actualStart: null, actualFinish: null,
    totalFloatDays: null, constraint: null, codes: {}, udfs: {}, ...x,
  });
  const s = {
    projectId: '1', projectCode: 'T', projectName: 'T', dataDate: '2024-01-01 00:00', hoursPerDay: 8, wbs: [],
    activities: [
      a('F1', '기초', 'P1', { actualStart: '2024-03-01 08:00', actualFinish: '2024-03-10 17:00', start: '2024-03-01 08:00', finish: '2024-03-10 17:00', plannedFinish: '2024-03-10 17:00' }),
      a('C1', '교각시공', 'P1', { actualStart: '2024-03-05 08:00', start: '2024-03-05 08:00', finish: '2024-03-20 17:00' }),
      a('K1', '코핑시공', 'P1', { start: '2024-04-01 08:00', finish: '2024-04-20 17:00', durationDays: 75 }),
      a('X', '측량', 'G', { start: '2024-05-01 08:00', finish: '2024-05-02 17:00', plannedFinish: '2024-02-01 17:00', constraint: { type: 'CS_MSO', date: '2024-05-01 08:00' } }),
      a('Y', '작업 계획수립', 'G', { actualStart: '2024-01-05 08:00', actualFinish: '2024-01-20 17:00' }),
    ],
    relations: [
      { pred: 'F1', succ: 'C1', type: 'FS', lagDays: 0 }, // 실적 역전 + 구조 순서 역전
      { pred: 'X', succ: 'Y', type: 'FS', lagDays: -10 }, // 리드: 선행 실적 없음 → 역전
      { pred: 'Y', succ: 'K1', type: 'SF', lagDays: 45 },
    ],
  };
  const r = check.checkSchedule(s);
  const has = (rule, codes) => r.findings.some(f => f.rule === rule && (!codes || codes.every(c => f.codes.includes(c))));
  assert.ok(has('stale-data-date'));
  assert.equal(r.dataDate, '2024-03-10');
  assert.ok(has('oos-actual', ['F1', 'C1']));
  assert.ok(has('oos-actual', ['X', 'Y']));
  assert.ok(has('part-order', ['F1', 'C1']));
  assert.ok(has('part-unlinked', ['C1', 'K1']));
  assert.ok(has('neg-lag', ['X', 'Y']) && has('sf', ['Y', 'K1']) && has('long-lag', ['Y', 'K1']));
  assert.ok(has('long-duration', ['K1']) && has('hard-constraint', ['X']));
  assert.ok(has('missing-actual', ['X']));
  assert.equal(r.findings[0].severity, 'error');
  assert.equal(check.partRank('PHC 말뚝 기초'), 1);
  assert.equal(check.partRank('교대 벽체'), 2);
  assert.equal(check.partRank('작업 진입로 개설'), 0);
});
