// P6 공정표 모델 — XER 표(PROJECT·PROJWBS·TASK·TASKPRED·코드·UDF)를 읽고, 플랫폼이 만든
// 개략공정을 P6 가 불러올 수 있는 XER 로 만든다. docs/IPS_4D5D.md
//
// 왕복의 핵심: 객체 연결 키(구조물·부위·STA 등)를 Activity Code 와 UDF 로 실어 보낸다.
// 사용자가 P6 에서 작업을 고치거나 복사해 쪼개도 코드·UDF 는 따라가므로, 다시 올렸을 때
// 그 키로 BIM 객체와 내역을 자동으로 다시 잇는다(작업 ID 만으로 잇지 않는다).
//
// 날짜: XER 은 'YYYY-MM-DD HH:MM'(현지 시각). 개략공정은 일 단위 'YYYY-MM-DD' 로 다룬다.

import { getTable, records, toRows, type XerDoc, type XerTable } from './xer';
import { computeCpm, type CpmRelation, type RelType } from './cpm';
import type { ScheduleTask } from '../schedule';

// --- 읽기 -------------------------------------------------------------------

export interface P6Wbs {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  /** 프로젝트 노드 아래부터의 코드 경로(예 'BR01.SUB'). 프로젝트 노드는 ''. */
  path: string;
}

export interface P6Activity {
  /** XER 내부 task_id(파일마다 바뀜 — 저장 키로 쓰지 않는다). */
  taskId: string;
  /** Activity ID(task_code) — 사용자가 보는 작업 번호. */
  code: string;
  name: string;
  wbsId: string;
  wbsPath: string;
  /** TT_Task · TT_Mile · TT_FinMile · TT_LOE · TT_WBS · TT_Rsrc */
  taskType: string;
  /** TK_NotStart · TK_Active · TK_Complete */
  status: string;
  durationDays: number;
  remainingDays: number;
  /** 현재 일정(실적 > 조기 > 계획 순) — 'YYYY-MM-DD HH:MM', 없으면 null. */
  start: string | null;
  finish: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  totalFloatDays: number | null;
  /** Activity Code 유형 이름 → 코드 값(short_name). */
  codes: Record<string, string>;
  /** UDF 라벨 → 값(숫자 UDF 는 number). */
  udfs: Record<string, string | number>;
}

export interface P6Relation {
  pred: string; // Activity ID
  succ: string;
  type: RelType;
  lagDays: number;
}

export interface P6Schedule {
  projectId: string;
  projectCode: string;
  projectName: string;
  dataDate: string | null;
  hoursPerDay: number;
  wbs: P6Wbs[];
  activities: P6Activity[];
  relations: P6Relation[];
}

/** XER 문서에서 프로젝트 하나를 읽는다(projectId 생략 시 첫 프로젝트). */
export function readSchedule(doc: XerDoc, projectId?: string): P6Schedule {
  const projects = records(getTable(doc, 'PROJECT'));
  const project = projectId ? projects.find(p => p.proj_id === projectId) : projects[0];
  if (!project) throw new Error('XER 에 프로젝트가 없습니다');
  const pid = project.proj_id;

  const calHours = new Map(records(getTable(doc, 'CALENDAR')).map(c => [c.clndr_id, num(c.day_hr_cnt) || 8]));
  const hoursPerDay = calHours.get(project.clndr_id) ?? 8;

  // WBS 트리 — 코드 경로는 프로젝트 노드 아래부터.
  const wbsRecs = records(getTable(doc, 'PROJWBS')).filter(w => w.proj_id === pid);
  const byId = new Map(wbsRecs.map(w => [w.wbs_id, w]));
  const root = wbsRecs.find(w => w.proj_node_flag === 'Y');
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    // 깊이 상한: 잘못된 파일의 순환 부모에서 멈추게.
    for (let w = byId.get(id); w && w.proj_node_flag !== 'Y' && parts.length < 64; w = byId.get(w.parent_wbs_id)) parts.unshift(w.wbs_short_name);
    return parts.join('.');
  };
  const wbs: P6Wbs[] = wbsRecs.map(w => ({
    id: w.wbs_id,
    parentId: byId.has(w.parent_wbs_id) ? w.parent_wbs_id : null,
    code: w.wbs_short_name,
    name: w.wbs_name,
    path: pathOf(w.wbs_id),
  }));

  // Activity Code: 유형 이름 → (코드 id → short_name)
  const codeTypes = new Map(records(getTable(doc, 'ACTVTYPE')).map(t => [t.actv_code_type_id, t.actv_code_type]));
  const codeValues = new Map(records(getTable(doc, 'ACTVCODE')).map(c => [c.actv_code_id, c.short_name]));
  const taskCodes = new Map<string, Record<string, string>>();
  for (const ta of records(getTable(doc, 'TASKACTV'))) {
    const type = codeTypes.get(ta.actv_code_type_id), value = codeValues.get(ta.actv_code_id);
    if (!type || value === undefined) continue;
    const o = taskCodes.get(ta.task_id) ?? {};
    o[type] = value;
    taskCodes.set(ta.task_id, o);
  }

  // UDF(작업 표 대상만): 라벨 → 값
  const udfTypes = new Map(records(getTable(doc, 'UDFTYPE')).filter(u => u.table_name === 'TASK').map(u => [u.udf_type_id, u]));
  const taskUdfs = new Map<string, Record<string, string | number>>();
  for (const v of records(getTable(doc, 'UDFVALUE'))) {
    const type = udfTypes.get(v.udf_type_id);
    if (!type) continue;
    const o = taskUdfs.get(v.fk_id) ?? {};
    const numeric = /FLOAT|INT|MONEY/.test(type.logical_data_type);
    o[type.udf_type_label || type.udf_type_name] = numeric ? num(v.udf_number) : v.udf_text || v.udf_date;
    taskUdfs.set(v.fk_id, o);
  }

  const tasks = records(getTable(doc, 'TASK')).filter(t => t.proj_id === pid);
  const codeOf = new Map(tasks.map(t => [t.task_id, t.task_code]));
  const activities: P6Activity[] = tasks.map(t => {
    const hpd = calHours.get(t.clndr_id) ?? hoursPerDay;
    return {
      taskId: t.task_id,
      code: t.task_code,
      name: t.task_name,
      wbsId: t.wbs_id,
      wbsPath: pathOf(t.wbs_id),
      taskType: t.task_type,
      status: t.status_code,
      durationDays: round2(num(t.target_drtn_hr_cnt) / hpd),
      remainingDays: round2(num(t.remain_drtn_hr_cnt) / hpd),
      start: t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date || null,
      finish: t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date || null,
      plannedStart: t.target_start_date || null,
      plannedFinish: t.target_end_date || null,
      actualStart: t.act_start_date || null,
      actualFinish: t.act_end_date || null,
      totalFloatDays: t.total_float_hr_cnt === '' ? null : round2(num(t.total_float_hr_cnt) / hpd),
      codes: taskCodes.get(t.task_id) ?? {},
      udfs: taskUdfs.get(t.task_id) ?? {},
    };
  });

  const relations: P6Relation[] = [];
  for (const r of records(getTable(doc, 'TASKPRED'))) {
    const pred = codeOf.get(r.pred_task_id), succ = codeOf.get(r.task_id);
    if (!pred || !succ) continue; // 다른 프로젝트와의 관계는 제외
    relations.push({ pred, succ, type: relType(r.pred_type), lagDays: round2(num(r.lag_hr_cnt) / hoursPerDay) });
  }

  return {
    projectId: pid,
    projectCode: project.proj_short_name,
    projectName: root?.wbs_name ?? project.proj_short_name,
    dataDate: project.last_recalc_date || null,
    hoursPerDay,
    wbs,
    activities,
    relations,
  };
}

/** 기존 4D 타임라인(lib/fourd.ts)이 쓰는 작업 목록으로. id = Activity ID(버전 간 안정). */
export function toScheduleTasks(s: P6Schedule): ScheduleTask[] {
  const out: ScheduleTask[] = [];
  for (const a of s.activities) {
    const start = parseXerDate(a.start), end = parseXerDate(a.finish);
    if (start === null || end === null) continue;
    const custom: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.codes)) custom[k] = v;
    for (const [k, v] of Object.entries(a.udfs)) custom[k] = String(v);
    out.push({
      id: a.code,
      name: a.name,
      type: 'construct',
      rawType: a.taskType,
      start,
      end: Math.max(end, start),
      actualStart: parseXerDate(a.actualStart),
      actualEnd: parseXerDate(a.actualFinish),
      cost: null,
      externalId: a.code,
      custom,
      outline: a.wbsPath || null,
      isSummary: a.taskType === 'TT_LOE' || a.taskType === 'TT_WBS',
    });
  }
  return out;
}

// --- 버전 비교(다시 올렸을 때) ----------------------------------------------

export interface ActivityChange {
  code: string;
  fields: string[];
  before: P6Activity;
  after: P6Activity;
}

export interface ScheduleDiff {
  added: P6Activity[];
  removed: P6Activity[];
  changed: ActivityChange[];
}

/** Activity ID 기준 비교: 추가·삭제·변경(이름·WBS·일정·일수·코드·UDF). */
export function diffSchedules(before: P6Schedule, after: P6Schedule): ScheduleDiff {
  const prev = new Map(before.activities.map(a => [a.code, a]));
  const next = new Map(after.activities.map(a => [a.code, a]));
  const diff: ScheduleDiff = { added: [], removed: [], changed: [] };
  for (const [code, a] of next) {
    const b = prev.get(code);
    if (!b) { diff.added.push(a); continue; }
    const fields: string[] = [];
    if (a.name !== b.name) fields.push('name');
    if (a.wbsPath !== b.wbsPath) fields.push('wbs');
    if (a.start !== b.start) fields.push('start');
    if (a.finish !== b.finish) fields.push('finish');
    if (a.durationDays !== b.durationDays) fields.push('duration');
    if (!sameRecord(a.codes, b.codes)) fields.push('codes');
    if (!sameRecord(a.udfs, b.udfs)) fields.push('udfs');
    if (fields.length) diff.changed.push({ code, fields, before: b, after: a });
  }
  for (const [code, b] of prev) if (!next.has(code)) diff.removed.push(b);
  return diff;
}

// --- 쓰기(개략공정 → XER) -----------------------------------------------------

export interface DraftWbs {
  code: string;
  name: string;
  /** 상위 WBS 코드(없으면 프로젝트 바로 아래). */
  parent?: string;
}

export interface DraftActivity {
  /** Activity ID. */
  code: string;
  name: string;
  /** 소속 WBS 코드(DraftWbs.code). */
  wbs: string;
  durationDays: number;
  milestone?: 'start' | 'finish';
  /** Activity Code 유형 이름 → 값. 유형·값은 자동으로 만든다. */
  codes?: Record<string, string>;
  /** UDF 라벨 → 값(숫자면 숫자 UDF). */
  udfs?: Record<string, string | number>;
}

export interface DraftRelation {
  pred: string;
  succ: string;
  type?: RelType;
  lagDays?: number;
}

export interface DraftSchedule {
  project: { code: string; name: string; start: string /* YYYY-MM-DD */ };
  wbs: DraftWbs[];
  activities: DraftActivity[];
  relations: DraftRelation[];
}

const WORK_START = '08:00';
const WORK_END = '17:00';

/**
 * 개략공정을 XER 문서로. 날짜는 CPM 으로 매긴다(7일 달력 — P6 에서 F9 로 프로젝트 달력에
 * 맞춰 다시 계산). template(P6 에서 내보낸 XER)을 주면 그 파일의 열 구성·달력·통화를
 * 따라 써서, 사용하는 P6 버전과 회사 달력에 맞춘다.
 */
export function buildXer(draft: DraftSchedule, template?: XerDoc): XerDoc {
  const now = formatXerDate(new Date());
  // 열 구성: 템플릿 순서 그대로 + 템플릿에 없는 기본 열(P6 는 열 이름으로 읽는다).
  const fieldsOf = (name: string) => {
    const own = template ? getTable(template, name)?.fields ?? [] : [];
    return [...own, ...DEFAULT_FIELDS[name].filter(f => !own.includes(f))];
  };
  const tables: XerTable[] = [];
  const put = (name: string, recs: Record<string, string | number | null | undefined>[]) => {
    const fields = fieldsOf(name);
    tables.push({ name, fields, rows: toRows(fields, recs) });
  };

  // 달력·통화·OBS: 템플릿이 있으면 그대로, 없으면 기본값.
  const PROJ = '1';
  const cal = pickCalendar(template, PROJ);
  const hpd = cal.hoursPerDay;
  if (template && getTable(template, 'CURRTYPE')) tables.push(cloneTable(getTable(template, 'CURRTYPE')!));
  else put('CURRTYPE', [DEFAULT_CURRENCY]);
  const obs = template ? getTable(template, 'OBS') : undefined;
  if (obs && obs.rows.length) tables.push(cloneTable(obs));
  else put('OBS', [{ obs_id: '1', parent_obs_id: '', seq_num: '0', obs_name: 'Enterprise', obs_descr: '' }]);
  const obsId = records(obs)[0]?.obs_id ?? '1';

  // 날짜(CPM)
  const codesSet = new Set(draft.activities.map(a => a.code));
  for (const r of draft.relations) {
    if (!codesSet.has(r.pred) || !codesSet.has(r.succ)) throw new Error(`관계 ${r.pred}→${r.succ}: 없는 작업`);
  }
  const rels: CpmRelation[] = draft.relations.map(r => ({ pred: r.pred, succ: r.succ, type: r.type ?? 'FS', lag: r.lagDays ?? 0 }));
  const cpm = computeCpm(draft.activities.map(a => ({ id: a.code, duration: a.milestone ? 0 : a.durationDays })), rels);
  const startOf = (offset: number) => `${addDays(draft.project.start, offset)} ${WORK_START}`;
  const endOf = (offset: number, dur: number) => (dur > 0 ? `${addDays(draft.project.start, offset - 1)} ${WORK_END}` : startOf(offset));
  const projectStart = startOf(0);
  const projectEnd = cpm.duration > 0 ? `${addDays(draft.project.start, cpm.duration - 1)} ${WORK_END}` : projectStart;

  put('PROJECT', [{
    ...PROJECT_DEFAULTS,
    proj_id: PROJ, proj_short_name: draft.project.code, clndr_id: cal.id,
    plan_start_date: projectStart, last_recalc_date: projectStart, scd_end_date: projectEnd, add_date: now,
  }]);
  tables.push(...cal.tables);

  // WBS: 프로젝트 노드 + 개략공정 WBS
  const wbsIds = new Map<string, string>();
  draft.wbs.forEach((w, i) => wbsIds.set(w.code, String(101 + i)));
  const ROOT_WBS = '100';
  put('PROJWBS', [
    { ...WBS_DEFAULTS, wbs_id: ROOT_WBS, proj_id: PROJ, obs_id: obsId, seq_num: 0, proj_node_flag: 'Y', wbs_short_name: draft.project.code, wbs_name: draft.project.name, parent_wbs_id: '' },
    ...draft.wbs.map((w, i) => ({
      ...WBS_DEFAULTS, wbs_id: wbsIds.get(w.code), proj_id: PROJ, obs_id: obsId, seq_num: (i + 1) * 10, proj_node_flag: 'N',
      wbs_short_name: w.code, wbs_name: w.name, parent_wbs_id: (w.parent && wbsIds.get(w.parent)) || ROOT_WBS,
    })),
  ]);

  // Activity Code 유형·값(프로젝트 범위)
  const typeIds = new Map<string, string>();
  const valueIds = new Map<string, string>(); // `${type}\u0000${value}` → id
  for (const a of draft.activities) {
    for (const [type, value] of Object.entries(a.codes ?? {})) {
      if (!typeIds.has(type)) typeIds.set(type, String(typeIds.size + 1));
      const key = `${type}\u0000${value}`;
      if (!valueIds.has(key)) valueIds.set(key, String(valueIds.size + 1));
    }
  }
  if (typeIds.size) {
    put('ACTVTYPE', [...typeIds].map(([type, id], i) => ({
      actv_code_type_id: id, actv_short_len: 30, seq_num: (i + 1) * 10, actv_code_type: type, proj_id: PROJ, wbs_id: '', actv_code_type_scope: 'AS_Project',
    })));
    put('ACTVCODE', [...valueIds].map(([key, id], i) => {
      const [type, value] = key.split('\u0000');
      return { actv_code_id: id, parent_actv_code_id: '', actv_code_type_id: typeIds.get(type), actv_code_name: value, short_name: value, seq_num: (i + 1) * 10, color: '', total_assignments: 0 };
    }));
  }

  // UDF 유형(작업 표): 값이 하나라도 숫자가 아니면 문자 UDF.
  // 템플릿에 같은 라벨의 작업 UDF 가 있으면 그 정의(ID·자료형, 예: 계약금액 = FT_MONEY)를 그대로 써서
  // 같은 P6 DB 로 불러올 때 같은 이름의 UDF 가 하나 더 생기지 않게 한다.
  const udfKinds = new Map<string, 'text' | 'number'>();
  for (const a of draft.activities) {
    for (const [label, v] of Object.entries(a.udfs ?? {})) {
      const kind = typeof v === 'number' ? 'number' : 'text';
      udfKinds.set(label, udfKinds.get(label) === 'text' ? 'text' : kind);
    }
  }
  const tplUdfs = new Map(records(template && getTable(template, 'UDFTYPE'))
    .filter(u => u.table_name === 'TASK').map(u => [u.udf_type_label || u.udf_type_name, u]));
  let nextUdfId = Math.max(0, ...[...tplUdfs.values()].map(u => Number(u.udf_type_id) || 0)) + 1;
  const udfTypes = new Map([...udfKinds].map(([label, kind]) => {
    const own = tplUdfs.get(label);
    if (own) {
      udfKinds.set(label, /FLOAT|INT|MONEY/.test(own.logical_data_type) ? 'number' : 'text');
      return [label, own];
    }
    const id = String(nextUdfId++);
    return [label, {
      udf_type_id: id, table_name: 'TASK', udf_type_name: `user_field_${id}`, udf_type_label: label,
      logical_data_type: kind === 'number' ? 'FT_FLOAT_2_DECIMALS' : 'FT_TEXT', super_flag: 'N', export_flag: 'Y',
    }];
  }));
  const udfIds = new Map([...udfTypes].map(([label, u]) => [label, u.udf_type_id]));
  if (udfIds.size) put('UDFTYPE', [...udfTypes.values()]);

  // 작업
  const taskIds = new Map(draft.activities.map((a, i) => [a.code, String(1001 + i)]));
  put('TASK', draft.activities.map(a => {
    const t = cpm.times.get(a.code)!;
    const dur = a.milestone ? 0 : a.durationDays;
    const es = startOf(t.es), ef = endOf(t.ef, dur), ls = startOf(t.ls), lf = endOf(t.lf, dur);
    if (!wbsIds.has(a.wbs)) throw new Error(`작업 ${a.code}: 없는 WBS '${a.wbs}'`);
    return {
      ...TASK_DEFAULTS,
      task_id: taskIds.get(a.code), proj_id: PROJ, wbs_id: wbsIds.get(a.wbs), clndr_id: cal.id,
      task_type: a.milestone === 'start' ? 'TT_Mile' : a.milestone === 'finish' ? 'TT_FinMile' : 'TT_Task',
      task_code: a.code, task_name: a.name,
      total_float_hr_cnt: hours(t.float, hpd), remain_drtn_hr_cnt: hours(dur, hpd), target_drtn_hr_cnt: hours(dur, hpd),
      early_start_date: es, early_end_date: ef, late_start_date: ls, late_end_date: lf,
      restart_date: es, reend_date: ef, target_start_date: es, target_end_date: ef, rem_late_start_date: ls, rem_late_end_date: lf,
      create_date: now, update_date: now,
    };
  }));

  if (typeIds.size) {
    const rows: Record<string, string | undefined>[] = [];
    for (const a of draft.activities) {
      for (const [type, value] of Object.entries(a.codes ?? {})) {
        rows.push({ task_id: taskIds.get(a.code), actv_code_type_id: typeIds.get(type), actv_code_id: valueIds.get(`${type}\u0000${value}`), proj_id: PROJ });
      }
    }
    put('TASKACTV', rows);
  }

  put('TASKPRED', rels.map((r, i) => ({
    task_pred_id: String(i + 1), task_id: taskIds.get(r.succ), pred_task_id: taskIds.get(r.pred), proj_id: PROJ, pred_proj_id: PROJ,
    pred_type: `PR_${r.type}`, lag_hr_cnt: hours(r.lag, hpd), comments: '', float_path: '', aref: '', arls: '',
  })));

  if (udfIds.size) {
    const rows: Record<string, string | number | undefined>[] = [];
    for (const a of draft.activities) {
      for (const [label, v] of Object.entries(a.udfs ?? {})) {
        const numeric = udfKinds.get(label) === 'number';
        rows.push({ udf_type_id: udfIds.get(label), fk_id: taskIds.get(a.code), proj_id: PROJ, udf_date: '', udf_number: numeric ? v : '', udf_text: numeric ? '' : String(v), udf_code_id: '' });
      }
    }
    put('UDFVALUE', rows);
  }

  const header = template?.header.length
    ? template.header.map((v, i) => (i === 1 ? now.slice(0, 10) : v))
    : ['19.12', now.slice(0, 10), 'Project', 'admin', 'admin', 'dbxDatabaseNoName', 'Project Management', 'KRW'];
  return { header, tables };
}

// --- 날짜·숫자 도우미 ---------------------------------------------------------

/** 'YYYY-MM-DD HH:MM' 또는 'YYYY-MM-DD' → epoch ms(현지 시각). */
export function parseXerDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0).getTime();
}

export function formatXerDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' + n일(달력일). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hours(days: number, hpd: number): string {
  return String(round2(days * hpd));
}

function relType(s: string): RelType {
  const t = s.replace(/^PR_/, '');
  return t === 'SS' || t === 'FF' || t === 'SF' ? t : 'FS';
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
}

function cloneTable(t: XerTable): XerTable {
  return { name: t.name, fields: [...t.fields], rows: t.rows.map(r => [...r]) };
}

/**
 * 템플릿의 달력 고르기: 첫 프로젝트의 달력 → 기본(default_flag) → 첫 달력. 프로젝트 달력이면
 * 새 프로젝트 id 로 바꾸고, 기준 달력(base_clndr_id)도 함께 싣는다. 템플릿이 없으면 7일·8시간.
 */
function pickCalendar(template: XerDoc | undefined, projId: string): { id: string; hoursPerDay: number; tables: XerTable[] } {
  const table = template && getTable(template, 'CALENDAR');
  if (!table || !table.rows.length) {
    const fields = DEFAULT_FIELDS.CALENDAR;
    return { id: '1', hoursPerDay: 8, tables: [{ name: 'CALENDAR', fields, rows: toRows(fields, [DEFAULT_CALENDAR]) }] };
  }
  const cals = records(table);
  const projCal = records(getTable(template, 'PROJECT'))[0]?.clndr_id;
  const chosen = cals.find(c => c.clndr_id === projCal) ?? cals.find(c => c.default_flag === 'Y') ?? cals[0];
  const keep = new Set<string>();
  for (let c: Record<string, string> | undefined = chosen; c && !keep.has(c.clndr_id);) {
    keep.add(c.clndr_id);
    const base: string = c.base_clndr_id;
    c = cals.find(x => x.clndr_id === base);
  }
  const rows = cals.filter(c => keep.has(c.clndr_id)).map(c => (c.clndr_type === 'CA_Project' ? { ...c, proj_id: projId } : c));
  return { id: chosen.clndr_id, hoursPerDay: num(chosen.day_hr_cnt) || 8, tables: [{ name: 'CALENDAR', fields: table.fields, rows: toRows(table.fields, rows) }] };
}

// --- 기본 열 구성·값(템플릿이 없을 때) — P6 Professional 19~23 내보내기 기준 ----------

const DEFAULT_FIELDS: Record<string, string[]> = {
  CURRTYPE: ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'],
  OBS: ['obs_id', 'parent_obs_id', 'guid', 'seq_num', 'obs_name', 'obs_descr'],
  PROJECT: ['proj_id', 'fy_start_month_num', 'rsrc_self_add_flag', 'allow_complete_flag', 'rsrc_multi_assign_flag', 'checkout_flag', 'project_flag', 'step_complete_flag', 'cost_qty_recalc_flag', 'batch_sum_flag', 'name_sep_char', 'def_complete_pct_type', 'proj_short_name', 'acct_id', 'orig_proj_id', 'source_proj_id', 'base_type_id', 'clndr_id', 'sum_base_proj_id', 'task_code_base', 'task_code_step', 'priority_num', 'wbs_max_sum_level', 'strgy_priority_num', 'last_checksum', 'critical_drtn_hr_cnt', 'def_cost_per_qty', 'last_recalc_date', 'plan_start_date', 'plan_end_date', 'scd_end_date', 'add_date', 'last_tasksum_date', 'fcst_start_date', 'def_duration_type', 'task_code_prefix', 'guid', 'def_qty_type', 'add_by_name', 'web_local_root_path', 'proj_url', 'def_rate_type', 'add_act_remain_flag', 'act_this_per_link_flag', 'def_task_type', 'act_pct_link_flag', 'critical_path_type', 'task_code_prefix_flag', 'def_rollup_dates_flag', 'use_project_baseline_flag', 'rem_target_link_flag', 'reset_planned_flag', 'allow_neg_act_flag', 'sum_assign_level', 'last_fin_dates_id', 'last_baseline_update_date', 'cr_external_key', 'apply_actuals_date', 'location_id', 'loaded_scope_level', 'export_flag', 'new_fin_dates_id', 'baselines_to_export', 'baseline_names_to_export', 'next_data_date', 'close_period_flag', 'sum_refresh_date', 'trsrcsum_loaded'],
  CALENDAR: ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data'],
  PROJWBS: ['wbs_id', 'proj_id', 'obs_id', 'seq_num', 'est_wt', 'proj_node_flag', 'sum_data_flag', 'status_code', 'wbs_short_name', 'wbs_name', 'phase_id', 'parent_wbs_id', 'ev_user_pct', 'ev_etc_user_value', 'orig_cost', 'indep_remain_total_cost', 'ann_dscnt_rate_pct', 'dscnt_period_type', 'indep_remain_work_qty', 'anticip_start_date', 'anticip_end_date', 'ev_compute_type', 'ev_etc_compute_type', 'guid', 'tmpl_guid', 'plan_open_state'],
  ACTVTYPE: ['actv_code_type_id', 'actv_short_len', 'seq_num', 'actv_code_type', 'proj_id', 'wbs_id', 'actv_code_type_scope'],
  ACTVCODE: ['actv_code_id', 'parent_actv_code_id', 'actv_code_type_id', 'actv_code_name', 'short_name', 'seq_num', 'color', 'total_assignments'],
  UDFTYPE: ['udf_type_id', 'table_name', 'udf_type_name', 'udf_type_label', 'logical_data_type', 'super_flag', 'indicator_expression', 'summary_indicator_expression', 'export_flag'],
  TASK: ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'phys_complete_pct', 'rev_fdbk_flag', 'est_wt', 'lock_plan_flag', 'auto_compute_act_flag', 'complete_pct_type', 'task_type', 'duration_type', 'status_code', 'task_code', 'task_name', 'rsrc_id', 'total_float_hr_cnt', 'free_float_hr_cnt', 'remain_drtn_hr_cnt', 'act_work_qty', 'remain_work_qty', 'target_work_qty', 'target_drtn_hr_cnt', 'target_equip_qty', 'act_equip_qty', 'remain_equip_qty', 'cstr_date', 'act_start_date', 'act_end_date', 'late_start_date', 'late_end_date', 'expect_end_date', 'early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_type', 'priority_type', 'suspend_date', 'resume_date', 'float_path', 'float_path_order', 'guid', 'tmpl_guid', 'cstr_date2', 'cstr_type2', 'driving_path_flag', 'act_this_per_work_qty', 'act_this_per_equip_qty', 'external_early_start_date', 'external_late_end_date', 'create_date', 'update_date', 'create_user', 'update_user', 'location_id'],
  TASKACTV: ['task_id', 'actv_code_type_id', 'actv_code_id', 'proj_id'],
  TASKPRED: ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt', 'comments', 'float_path', 'aref', 'arls'],
  UDFVALUE: ['udf_type_id', 'fk_id', 'proj_id', 'udf_date', 'udf_number', 'udf_text', 'udf_code_id'],
};

const DEFAULT_CURRENCY = {
  curr_id: '1', decimal_digit_cnt: '0', curr_symbol: '\uFFE6', decimal_symbol: '.', digit_group_symbol: ',',
  pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)', curr_type: 'Korean Won', curr_short_name: 'KRW', group_digit_cnt: '3', base_exch_rate: '1',
};

/** P6 달력 데이터 — 매일 08–12·13–17(8시간). XER 은 줄바꿈 자리에 DEL(0x7F) 두 개를 쓴다. */
const NL = '\x7f\x7f';
const WORKDAY = `(0||0(s|08:00|f|12:00)())${NL}      (0||1(s|13:00|f|17:00)())`;
const CALENDAR_DATA =
  `(0||CalendarData()(${NL}  (0||DaysOfWeek()(${NL}` +
  [1, 2, 3, 4, 5, 6, 7].map(d => `    (0||${d}()(${NL}      ${WORKDAY}))`).join(NL) +
  `))${NL}  (0||VIEW(ShowTotal|Y)())${NL}  (0||Exceptions()())))`;

const DEFAULT_CALENDAR = {
  clndr_id: '1', default_flag: 'N', clndr_name: 'MIR 7일 8시간', proj_id: '', base_clndr_id: '', last_chng_date: '',
  clndr_type: 'CA_Base', day_hr_cnt: '8', week_hr_cnt: '56', month_hr_cnt: '243', year_hr_cnt: '2920', rsrc_private: 'N', clndr_data: CALENDAR_DATA,
};

const PROJECT_DEFAULTS = {
  fy_start_month_num: '1', rsrc_self_add_flag: 'Y', allow_complete_flag: 'Y', rsrc_multi_assign_flag: 'Y', checkout_flag: 'N', project_flag: 'Y',
  step_complete_flag: 'N', cost_qty_recalc_flag: 'Y', batch_sum_flag: 'Y', name_sep_char: '.', def_complete_pct_type: 'CP_Drtn',
  task_code_base: '1000', task_code_step: '10', priority_num: '10', wbs_max_sum_level: '0', strgy_priority_num: '100', critical_drtn_hr_cnt: '0',
  def_cost_per_qty: '0', def_duration_type: 'DT_FixedDrtn', def_qty_type: 'QT_Hour', add_by_name: 'admin', def_rate_type: 'COST_PER_QTY',
  add_act_remain_flag: 'N', act_this_per_link_flag: 'Y', def_task_type: 'TT_Task', act_pct_link_flag: 'N', critical_path_type: 'CT_TotFloat',
  task_code_prefix_flag: 'Y', def_rollup_dates_flag: 'Y', use_project_baseline_flag: 'Y', rem_target_link_flag: 'Y', reset_planned_flag: 'N',
  allow_neg_act_flag: 'N', sum_assign_level: 'SL_Taskrsrc', export_flag: 'Y', close_period_flag: 'N', trsrcsum_loaded: 'N',
};

const WBS_DEFAULTS = {
  est_wt: '1', sum_data_flag: 'Y', status_code: 'WS_Open', ev_user_pct: '6', ev_etc_user_value: '0.88', orig_cost: '0', indep_remain_total_cost: '0',
  ann_dscnt_rate_pct: '', dscnt_period_type: '', indep_remain_work_qty: '0', ev_compute_type: 'EC_Cmp_pct', ev_etc_compute_type: 'EE_Rem_hr', plan_open_state: '',
};

const TASK_DEFAULTS = {
  phys_complete_pct: '0', rev_fdbk_flag: 'N', est_wt: '1', lock_plan_flag: 'N', auto_compute_act_flag: 'Y', complete_pct_type: 'CP_Drtn',
  duration_type: 'DT_FixedDrtn', status_code: 'TK_NotStart', rsrc_id: '', free_float_hr_cnt: '', act_work_qty: '0', remain_work_qty: '0',
  target_work_qty: '0', target_equip_qty: '0', act_equip_qty: '0', remain_equip_qty: '0', priority_type: 'PT_Normal', float_path: '',
  float_path_order: '', driving_path_flag: 'N', act_this_per_work_qty: '0', act_this_per_equip_qty: '0', create_user: 'admin', update_user: 'admin',
};
