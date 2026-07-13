#!/usr/bin/env node
// =====================================================================
// 4D 공정표 임포트/현황 export 스모크 테스트 — 브라우저 없이 파서 로직을 검증.
// src 의 TS 를 esbuild 로 번들해 node 에서 실행한다(확장자 없는 import 해석).
// 검증: Excel(.xlsx)·MS Project(.xml)·P6(.xer) 파싱 + 현황 행/AOA 생성.
// 실행: node scripts/verify-4d-import.mjs
// =====================================================================
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import assert from 'node:assert';

const dir = mkdtempSync(join(tmpdir(), '4d-'));
// 번들은 프로젝트 안에 둬야 external 'xlsx' 가 node_modules 로 해석된다.
const bdir = mkdtempSync(join(process.cwd(), '.4dtmp-'));
process.on('exit', () => { try { rmSync(bdir, { recursive: true, force: true }); } catch { /* */ } });

// --- 샘플 데이터 만들기 -------------------------------------------------
// (1) Excel: WBS·계획/실제·진척·매칭키 열이 있는 작은 공정표.
const aoa = [
  ['WBS', '작업명', '유형', '계획 시작', '계획 끝', '실제 시작', '실제 끝', '진척률', '매칭키', '선행'],
  ['1', '토공', '시공', '', '', '', '', '', '', ''],
  ['1.1', '터파기', '시공', '2024-01-01', '2024-01-10', '2024-01-03', '2024-01-12', '100%', 'EX-01', ''],
  ['1.2', '되메우기', '시공', '2024-01-11', '2024-01-20', '2024-01-13', '', '40%', 'BF-02', '2'],
  ['2', '구조물', '시공', '2024-01-21', '2024-01-21', '', '', '0%', 'MS-END', ''],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const xlsxBuf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
const xlsxPath = join(dir, 'schedule.xlsx');
writeFileSync(xlsxPath, xlsxBuf);

// (2) MS Project XML.
const mspXml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Tasks>
    <Task><UID>0</UID><Name>프로젝트</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><Name>토공</Name><OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel>
      <Summary>1</Summary><Start>2024-01-01T08:00:00</Start><Finish>2024-01-20T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>터파기</Name><OutlineNumber>1.1</OutlineNumber><OutlineLevel>2</OutlineLevel>
      <Summary>0</Summary><Milestone>0</Milestone>
      <Start>2024-01-01T08:00:00</Start><Finish>2024-01-10T17:00:00</Finish>
      <ActualStart>2024-01-03T08:00:00</ActualStart><PercentComplete>60</PercentComplete>
      <Cost>150000</Cost></Task>
    <Task><UID>3</UID><Name>착공 마일스톤</Name><OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel>
      <Summary>0</Summary><Milestone>1</Milestone>
      <Start>2024-01-01T08:00:00</Start><Finish>2024-01-01T08:00:00</Finish>
      <PredecessorLink><PredecessorUID>2</PredecessorUID></PredecessorLink></Task>
  </Tasks>
</Project>`;

// (3) P6 XER (탭 구분). PROJWBS + TASK + TASKPRED.
const T = '\t';
const xer = [
  'ERMHDR' + T + '19.12',
  '%T' + T + 'PROJWBS',
  '%F' + T + 'wbs_id' + T + 'parent_wbs_id' + T + 'wbs_name',
  '%R' + T + '100' + T + '' + T + '토공',
  '%R' + T + '101' + T + '100' + T + '기초',
  '%T' + T + 'TASK',
  '%F' + T + 'task_id' + T + 'wbs_id' + T + 'task_code' + T + 'task_name' + T + 'task_type' +
    T + 'target_start_date' + T + 'target_end_date' + T + 'act_start_date' + T + 'act_end_date' + T + 'phys_complete_pct',
  '%R' + T + '1000' + T + '101' + T + 'A1000' + T + '터파기' + T + 'TT_Task' +
    T + '2024-01-01 08:00' + T + '2024-01-10 17:00' + T + '2024-01-02 08:00' + T + '' + T + '50',
  '%R' + T + '1001' + T + '101' + T + 'A1001' + T + '완료 마일스톤' + T + 'TT_FinMile' +
    T + '2024-01-11 08:00' + T + '2024-01-11 08:00' + T + '' + T + '' + T + '0',
  '%T' + T + 'TASKPRED',
  '%F' + T + 'task_pred_id' + T + 'task_id' + T + 'pred_task_id',
  '%R' + T + '1' + T + '1001' + T + '1000',
  '%E',
].join('\n');
const xerPath = join(dir, 'schedule.xer');
writeFileSync(xerPath, xer);
const mspPath = join(dir, 'schedule.xml');
writeFileSync(mspPath, mspXml);

// --- src 를 번들해서 로드 ----------------------------------------------
const entry = join(dir, 'entry.mjs');
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(process.cwd(), 'src/lib/scheduleImport.ts'))};
   export { buildStatusRows, statusAoa } from ${JSON.stringify(join(process.cwd(), 'src/lib/scheduleExport.ts'))};
   export { analyzeDelays, computeStates } from ${JSON.stringify(join(process.cwd(), 'src/lib/fourd.ts'))};`,
);
const outFile = join(bdir, 'bundle.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  external: ['xlsx'],
  logLevel: 'silent',
});
const lib = await import('file://' + outFile);
const { importScheduleFile, buildStatusRows, statusAoa, analyzeDelays, computeStates } = lib;
const bytesOf = (p) => new Uint8Array(readFileSync(p));

let pass = 0;
const ok = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`);
  pass++;
  console.log('  ✓ ' + label);
};

// === Excel ===
console.log('[Excel .xlsx]');
const ex = await importScheduleFile('schedule.xlsx', bytesOf(xlsxPath));
ok('kind=tabular', ex.kind === 'tabular' && ex.format === 'excel');
ok('헤더 자동추정: WBS→outline', ex.doc.guess.outline === 0);
ok('진척률 열 추정', ex.doc.guess.progress === 7);
ok('매칭키(externalId) 열 추정', ex.doc.guess.externalId === 8);

// === MS Project ===
console.log('[MS Project .xml]');
const msp = await importScheduleFile('schedule.xml', bytesOf(mspPath));
ok('kind=parsed, msproject', msp.kind === 'parsed' && msp.format === 'msproject');
const mtasks = msp.schedule.tasks;
ok('요약행 제외 후 3작업(토공/터파기/마일스톤)', mtasks.length === 3);
const teopagi = mtasks.find((t) => t.name === '터파기');
ok('터파기 진척 60%', Math.abs((teopagi.progress ?? 0) - 0.6) < 1e-6);
ok('터파기 실제시작 파싱', teopagi.actualStart != null);
ok('터파기 비용=1500(1/100 변환)', teopagi.cost === 1500);
const mile = mtasks.find((t) => t.name === '착공 마일스톤');
ok('마일스톤 플래그', mile.isMilestone === true);
ok('마일스톤 선행=UID 2', mile.predecessors.includes('2'));
const summary = mtasks.find((t) => t.name === '토공');
ok('토공 요약행', summary.isSummary === true);

// === P6 XER ===
console.log('[P6 .xer]');
const p6 = await importScheduleFile('schedule.xer', bytesOf(xerPath));
ok('kind=parsed, p6', p6.kind === 'parsed' && p6.format === 'p6');
const ptasks = p6.schedule.tasks;
const dig = ptasks.find((t) => t.name === '터파기');
ok('터파기 존재', !!dig);
ok('터파기 매칭키=task_code A1000', dig.externalId === 'A1000');
ok('WBS 개요번호 부여(점 포함)', /\d\.\d/.test(dig.outline || ''));
ok('진척 50%', Math.abs((dig.progress ?? 0) - 0.5) < 1e-6);
const pmile = ptasks.find((t) => t.name === '완료 마일스톤');
ok('XER 마일스톤 기간0', pmile.isMilestone === true);
ok('XER 선행(A1000)', pmile.predecessors.length >= 1);
const pSummary = ptasks.filter((t) => t.isSummary);
ok('WBS 요약행 생성', pSummary.length >= 1);

// === 현황 export (계획/실적 대비) ===
console.log('[현황 export]');
const rows = buildStatusRows(mtasks, Date.parse('2024-01-15'));
ok('상태 행 = 말단 작업 수(요약 제외)', rows.length === mtasks.filter((t) => !t.isSummary).length);
const digRow = rows.find((r) => r.name === '터파기');
ok('터파기 진척 60% 문자열', digRow.progress === '60%');
const aoaOut = statusAoa(rows);
ok('AOA 헤더 11열', aoaOut[0].length === 11 && aoaOut[0][0] === 'WBS');

// === 지연 분석 ===
console.log('[지연 분석]');
// 엑셀 tabular 를 buildSchedule 로 태스크화해 지연 검증(실제끝>계획끝).
const schedBundle = join(bdir, 'sbundle.mjs');
writeFileSync(join(dir, 'sentry.mjs'), `export { buildSchedule } from ${JSON.stringify(join(process.cwd(), 'src/lib/schedule.ts'))};`);
await build({ entryPoints: [join(dir, 'sentry.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: schedBundle, external: ['xlsx'], logLevel: 'silent' });
const { buildSchedule: bs } = await import('file://' + schedBundle);
const exParsed = bs(ex.doc, ex.doc.guess);
ok('엑셀 → 작업 생성', exParsed.tasks.length >= 3);
const digg = exParsed.tasks.find((t) => t.name === '터파기');
ok('엑셀 터파기 진척 100%', Math.abs((digg.progress ?? 0) - 1) < 1e-6);
ok('엑셀 매칭키 EX-01', digg.externalId === 'EX-01');
ok('엑셀 마일스톤(구조물, 시작==끝)', exParsed.tasks.find((t) => t.name === '구조물')?.isMilestone === true);
const delays = analyzeDelays(exParsed.tasks, Date.parse('2024-01-15'));
ok('터파기 완료 지연 감지(실제끝>계획끝)', delays.some((d) => d.task.name === '터파기' && d.delayDays > 0 && d.reason === 'late-finish'));

// === computeStates basis ===
console.log('[재생 기준 basis]');
const mapping = { [digg.id]: [{ modelID: 1, expressID: 42 }] };
const planned = computeStates(exParsed.tasks, mapping, Date.parse('2024-01-11'), 'planned');
const actual = computeStates(exParsed.tasks, mapping, Date.parse('2024-01-11'), 'actual');
ok('planned/actual 모두 상태 반환', planned.size === 1 && actual.size === 1);
// 계획상 1/11 은 완료(계획끝 1/10) → normal. 실제끝 1/12 → 아직 진행 → active-*.
ok('planned=완료(normal)', planned.get('1:42').state === 'normal');
ok('actual=진행(active)', actual.get('1:42').state.startsWith('active'));

console.log(`\n✅ 전부 통과 (${pass} assertions)`);
