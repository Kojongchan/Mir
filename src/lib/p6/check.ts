// P6 공정표 검토(단계 5 · 방식 3): 이미 있는 공정표에서 문제를 규칙으로 찾는다. AI 는 찾은 결과를 설명·제안만 한다.
// 규칙은 일정 품질 점검(DCMA 14개 항목 계열)과 공단 IPS 구성 표준(작업 30일 단위, 연속 60일까지)에,
// 교량 개소 안 물리적 순서(기초 → 교각/벽체 → 코핑)를 더했다. 날짜는 'YYYY-MM-DD HH:MM' 문자열 비교.
import type { P6Activity, P6Relation, P6Schedule } from './schedule';

export type CheckSeverity = 'error' | 'warn' | 'info';
export type CheckRule =
  | 'oos-actual' | 'part-order' | 'future-actual' | 'stale-data-date' | 'logic-reversal' | 'missing-actual' | 'part-unlinked'
  | 'long-duration' | 'hard-constraint' | 'neg-lag' | 'open-start' | 'open-end' | 'long-lag' | 'sf' | 'dup-name';

export const CHECK_RULES: Record<CheckRule, { title: string; severity: CheckSeverity; why: string }> = {
  'oos-actual': { title: '선후행 역전(실적)', severity: 'error', why: '후행 작업이 선행 작업보다 먼저 시작·완료된 실적. 관계가 틀렸거나 실적이 잘못 들어감.' },
  'part-order': { title: '구조 순서 역전', severity: 'error', why: '같은 개소에서 기초 → 교각/벽체 → 코핑 순서가 뒤집힌 일정.' },
  'future-actual': { title: '기준일 이후 실적', severity: 'error', why: '데이터 기준일보다 뒤의 실적 날짜.' },
  'stale-data-date': { title: '재계산 안 한 공정표', severity: 'warn', why: '데이터 기준일이 가장 늦은 실적보다 이름 — P6 에서 일정 계산(F9) 없이 날짜만 고친 공정표.' },
  'logic-reversal': { title: '선후행 역전(계획)', severity: 'warn', why: '아직 시작 전인 작업의 날짜가 관계를 어김(제약·수동 날짜·재계산 안 함).' },
  'missing-actual': { title: '실적 누락 의심', severity: 'warn', why: '계획 종료일이 기준일보다 지났는데 실적 완료가 없음.' },
  'part-unlinked': { title: '개소 안 관계 없음', severity: 'warn', why: '같은 개소의 기초·교각·코핑 사이에 직접 관계가 없음 — 일정이 따로 움직임.' },
  'long-duration': { title: '긴 작업', severity: 'warn', why: '공단 IPS 구성 표준: 30일 단위, 연속 공정도 60일까지.' },
  'hard-constraint': { title: '강제 날짜 제약', severity: 'warn', why: '필수 시작·종료 제약은 논리를 무시해 주공정을 가린다.' },
  'neg-lag': { title: '음수 지연(리드)', severity: 'warn', why: '선행이 끝나기 전에 후행이 시작되는 관계 — 근거가 필요.' },
  'open-start': { title: '선행 없음', severity: 'info', why: '시작 마일스톤이 아닌데 선행 관계가 없음.' },
  'open-end': { title: '후행 없음', severity: 'info', why: '종료 마일스톤이 아닌데 후행 관계가 없음.' },
  'long-lag': { title: '긴 지연', severity: 'info', why: '긴 지연(lag)은 숨은 작업일 수 있음 — 작업으로 나누는 편이 명확.' },
  'sf': { title: 'SF 관계', severity: 'info', why: '시작-종료 관계는 드물고 오해가 많음.' },
  'dup-name': { title: '같은 이름 중복', severity: 'info', why: '같은 WBS 안에 같은 이름의 작업 — 복사 후 미수정 의심.' },
};

export interface CheckFinding {
  rule: CheckRule;
  severity: CheckSeverity;
  /** 관련 작업(Activity ID). 관계 문제는 [선행, 후행]. */
  codes: string[];
  message: string;
}

export interface CheckOptions {
  /** 이보다 긴 작업을 표시(일). 기본 60(공단 표준). */
  maxDurationDays?: number;
  /** 이보다 긴 지연을 표시(일). 기본 30. */
  longLagDays?: number;
  /** 데이터 기준일(없으면 공정표의 dataDate, 그것이 실적보다 이르면 가장 늦은 실적일). */
  dataDate?: string | null;
}

export interface CheckResult {
  findings: CheckFinding[];
  counts: Partial<Record<CheckRule, number>>;
  /** 검토한 작업 수(요약 WBS·LOE 제외) · 관계 수. */
  checked: { activities: number; relations: number };
  /** 실제로 쓴 데이터 기준일. */
  dataDate: string | null;
}

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
const DAY_MS = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY_MS);

/** 개소 안 순서: 1 기초(말뚝 포함) → 2 교각·기둥·벽체 → 3 코핑. 해당 없으면 0. */
export function partRank(name: string): number {
  const n = name.replace(/\s/g, '');
  if (/코핑/.test(n)) return 3;
  if (/교각|기둥|벽체/.test(n)) return 2;
  if (/기초|말뚝/.test(n)) return 1;
  return 0;
}

const isWork = (a: P6Activity) => a.taskType !== 'TT_LOE' && a.taskType !== 'TT_WBS';
const HARD = new Set(['CS_MSO', 'CS_MEO', 'CS_MANDSTART', 'CS_MANDFIN']);

export function checkSchedule(s: P6Schedule, opts: CheckOptions = {}): CheckResult {
  const maxDur = opts.maxDurationDays ?? 60;
  const longLag = opts.longLagDays ?? 30;
  const acts = s.activities.filter(isWork);
  let latestActual: string | null = null;
  for (const a of acts) for (const d of [day(a.actualStart), day(a.actualFinish)]) if (d && (!latestActual || d > latestActual)) latestActual = d;
  const fileDate = day(s.dataDate);
  const stale = !!(fileDate && latestActual && latestActual > fileDate);
  const dataDate = day(opts.dataDate) ?? (stale ? latestActual : fileDate);
  const by = new Map(acts.map(a => [a.code, a]));
  const rels = s.relations.filter(r => by.has(r.pred) && by.has(r.succ));
  const findings: CheckFinding[] = [];
  const add = (rule: CheckRule, codes: string[], message: string) => findings.push({ rule, severity: CHECK_RULES[rule].severity, codes, message });
  const label = (a: P6Activity) => `${a.code} ${a.name}`;

  const preds = new Map<string, P6Relation[]>(), succs = new Map<string, P6Relation[]>();
  for (const r of rels) {
    (preds.get(r.succ) ?? preds.set(r.succ, []).get(r.succ)!).push(r);
    (succs.get(r.pred) ?? succs.set(r.pred, []).get(r.pred)!).push(r);
  }

  if (stale && !opts.dataDate) {
    findings.push({ rule: 'stale-data-date', severity: 'warn', codes: [],
      message: `파일 기준일 ${fileDate} < 가장 늦은 실적 ${latestActual} — 기준일을 ${latestActual} 로 보고 검토했습니다(화면에서 바꿀 수 있음).` });
  }

  for (const r of rels) {
    const p = by.get(r.pred)!, q = by.get(r.succ)!;
    // 음수 지연(리드)은 의도한 겹침 — 순서 검사는 선행이 아예 시작도 안 했을 때만.
    const lead = r.lagDays < 0;
    const rel = `${label(p)} → ${label(q)} (${r.type}${r.lagDays ? ` ${r.lagDays > 0 ? '+' : ''}${r.lagDays}일` : ''})`;
    // 실적 역전: 관계가 요구하는 앞 작업의 실적보다 뒤 작업의 실적이 앞섬(지연은 보지 않음 — 순서만)
    const qs = day(q.actualStart), qf = day(q.actualFinish), ps = day(p.actualStart), pf = day(p.actualFinish);
    let oos = false;
    if (lead) oos = !!(qs && !ps);
    else if (r.type === 'FS' && qs) oos = !pf || qs < pf;
    else if (r.type === 'SS' && qs) oos = !ps || qs < ps;
    else if (r.type === 'FF' && qf) oos = !pf || qf < pf;
    if (oos) add('oos-actual', [p.code, q.code], `${rel}: 후행 실적 ${qs ?? '-'}~${qf ?? '-'}, 선행 실적 ${ps ?? '없음'}~${pf ?? '없음'}`);
    // 계획 역전: 둘 다 아직 실적이 없는 작업의 현재 날짜가 관계를 어김(같은 날은 허용)
    if (!oos && !lead && !q.actualStart && !p.actualFinish) {
      const pS = day(p.start), pF = day(p.finish), qS = day(q.start), qF = day(q.finish);
      const bad = r.type === 'FS' ? qS && pF && qS < pF
        : r.type === 'SS' ? qS && pS && qS < pS
          : r.type === 'FF' ? qF && pF && qF < pF : false;
      if (bad) add('logic-reversal', [p.code, q.code], `${rel}: 선행 ${pS}~${pF}, 후행 ${qS}~${qF}`);
    }
    if (r.lagDays < 0) add('neg-lag', [p.code, q.code], `${rel}`);
    else if (r.lagDays > longLag) add('long-lag', [p.code, q.code], `${rel}`);
    if (r.type === 'SF') add('sf', [p.code, q.code], rel);
  }

  for (const a of acts) {
    if (a.taskType !== 'TT_Mile' && !preds.get(a.code)?.length) add('open-start', [a.code], label(a));
    if (a.taskType !== 'TT_FinMile' && !succs.get(a.code)?.length) add('open-end', [a.code], label(a));
    if (a.taskType === 'TT_Task' && a.durationDays > maxDur) add('long-duration', [a.code], `${label(a)}: ${a.durationDays}일`);
    if (a.constraint && HARD.has(a.constraint.type)) add('hard-constraint', [a.code], `${label(a)}: ${a.constraint.type} ${day(a.constraint.date) ?? ''}`);
    if (dataDate) {
      const as = day(a.actualStart), af = day(a.actualFinish);
      if ((as && as > dataDate) || (af && af > dataDate)) add('future-actual', [a.code], `${label(a)}: 실적 ${as ?? '-'}~${af ?? '-'} > 기준일 ${dataDate}`);
      const pf = day(a.plannedFinish);
      if (!af && pf && pf < dataDate) add('missing-actual', [a.code], `${label(a)}: 계획 종료 ${pf}, 실적 ${as ? `시작 ${as}만` : '없음'} (기준일 ${dataDate})`);
    }
  }

  // 개소(같은 WBS) 안 물리적 순서와 직접 관계
  const groups = new Map<string, P6Activity[]>();
  for (const a of acts) if (partRank(a.name)) (groups.get(a.wbsId) ?? groups.set(a.wbsId, []).get(a.wbsId)!).push(a);
  const linked = (x: string, y: string) => rels.some(r => (r.pred === x && r.succ === y) || (r.pred === y && r.succ === x));
  for (const list of groups.values()) {
    const ranks = [...new Set(list.map(a => partRank(a.name)))].sort();
    for (let i = 1; i < ranks.length; i++) {
      for (const lo of list.filter(a => partRank(a.name) === ranks[i - 1])) {
        for (const hi of list.filter(a => partRank(a.name) === ranks[i])) {
          const loF = day(lo.actualFinish ?? lo.finish), hiS = day(hi.actualStart ?? hi.start);
          if (loF && hiS && hiS < loF) add('part-order', [lo.code, hi.code], `${label(lo)} 종료 ${loF} > ${label(hi)} 시작 ${hiS}`);
          if (!linked(lo.code, hi.code)) add('part-unlinked', [lo.code, hi.code], `${label(lo)} ↔ ${label(hi)}`);
        }
      }
    }
  }

  const seen = new Map<string, string[]>();
  for (const a of acts) {
    const k = `${a.wbsId}\u0000${a.name.trim()}`;
    (seen.get(k) ?? seen.set(k, []).get(k)!).push(a.code);
  }
  for (const [k, codes] of seen) if (codes.length > 1) add('dup-name', codes, `${k.split('\u0000')[1]} × ${codes.length}`);

  const order: CheckSeverity[] = ['error', 'warn', 'info'];
  findings.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity));
  const counts: Partial<Record<CheckRule, number>> = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return { findings, counts, checked: { activities: acts.length, relations: rels.length }, dataDate };
}

/** 두 날짜 사이 일수(달력일) — 화면 표시용. */
export const spanDays = (a: string, b: string) => days(a, b);
