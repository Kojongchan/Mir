// 공정·공사비(4D/5D) 시점 계산 — 기준일 하나로 공정표·차트·3D 상태·지표를 함께 맞춘다. docs/IPS_4D5D.md
//
// 순수 계산 모듈(화면·뷰어 비의존). 입력은 P6 공정표(lib/p6/schedule.ts)와 작업별 공사비·연결 객체.
// 진행률은 기간 안에서 선형으로 본다(P6 의 기간 기준 진척률과 같은 가정).

import { parseXerDate, type P6Activity, type P6Schedule } from '../p6/schedule';

export type ActivityPhase = 'future' | 'active' | 'done';

export interface TimedActivity {
  code: string;
  start: number;
  end: number;
  /** 실적 시작이 계획보다 늦음/이름(진행 중 색 구분). */
  variance: 'late' | 'early' | null;
  milestone: boolean;
  summary: boolean;
}

const DAY = 86_400_000;

/** 일정이 있는 작업만 epoch ms 로. 요약(LOE·WBS 요약) 작업은 표시만 하고 진척에서 뺀다. */
export function timedActivities(s: P6Schedule): TimedActivity[] {
  const out: TimedActivity[] = [];
  for (const a of s.activities) {
    const start = parseXerDate(a.start), end = parseXerDate(a.finish);
    if (start === null || end === null) continue;
    const planned = parseXerDate(a.plannedStart), actual = parseXerDate(a.actualStart);
    out.push({
      code: a.code,
      start,
      end: Math.max(start, end),
      variance: actual !== null && planned !== null && actual !== planned ? (actual > planned ? 'late' : 'early') : null,
      milestone: isMilestone(a),
      summary: a.taskType === 'TT_LOE' || a.taskType === 'TT_WBS',
    });
  }
  return out;
}

export function isMilestone(a: P6Activity): boolean {
  return a.taskType === 'TT_Mile' || a.taskType === 'TT_FinMile';
}

/** 공정표 전체 기간(일 단위로 맞춤). 작업이 없으면 null. */
export function scheduleRange(acts: TimedActivity[]): { start: number; end: number } | null {
  if (!acts.length) return null;
  let start = Infinity, end = -Infinity;
  for (const a of acts) { start = Math.min(start, a.start); end = Math.max(end, a.end); }
  const d0 = new Date(start); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(end); d1.setHours(23, 59, 59, 999);
  return { start: d0.getTime(), end: d1.getTime() };
}

export function phaseAt(a: TimedActivity, t: number): ActivityPhase {
  if (t < a.start) return 'future';
  if (t >= a.end) return 'done';
  return 'active';
}

/** 기준일의 작업 진척(0~1): 기간 안에서 선형. */
export function fractionAt(a: TimedActivity, t: number): number {
  if (t <= a.start) return 0;
  if (t >= a.end) return 1;
  return (t - a.start) / (a.end - a.start);
}

/**
 * 기준일의 진척 요약. weight 를 주면(작업별 공사비) 공사비 가중 공정률과 누적 공사비,
 * 없으면 기간 가중 공정률.
 */
export function progressAt(acts: TimedActivity[], t: number, weight?: ReadonlyMap<string, number>) {
  let done = 0, total = 0, active = 0, finished = 0, cost = 0, costTotal = 0;
  for (const a of acts) {
    if (a.summary) continue;
    const f = fractionAt(a, t);
    const w = weight ? weight.get(a.code) ?? 0 : Math.max(a.end - a.start, 0) / DAY;
    done += w * f;
    total += w;
    if (weight) { cost += w * f; costTotal += w; }
    const p = phaseAt(a, t);
    if (p === 'active') active++;
    else if (p === 'done') finished++;
  }
  return {
    progress: total > 0 ? done / total : 0,
    activeCount: active,
    doneCount: finished,
    cost: weight ? cost : null,
    costTotal: weight ? costTotal : null,
  };
}

/** S-curve: 기간을 steps 개로 나눈 누적 진척(과 공사비). */
export function sCurve(acts: TimedActivity[], range: { start: number; end: number }, weight?: ReadonlyMap<string, number>, steps = 80) {
  const out: { t: number; progress: number; cost: number | null }[] = [];
  const span = Math.max(range.end - range.start, DAY);
  for (let i = 0; i <= steps; i++) {
    const t = range.start + (span * i) / steps;
    const p = progressAt(acts, t, weight);
    out.push({ t, progress: p.progress, cost: p.cost });
  }
  return out;
}

export interface FourDColors {
  active: [number, number, number];
  late: [number, number, number];
  early: [number, number, number];
  /** 미시공을 숨기지 않을 때의 색. */
  future: [number, number, number];
}

export const FOUR_D_COLORS: FourDColors = {
  active: [34, 197, 94],
  late: [239, 68, 68],
  early: [59, 130, 246],
  future: [205, 205, 210],
};

/**
 * 기준일의 3D 상태: 객체(dbId)별 색(rgba, a=255 칠함)과 숨길 객체. 한 객체가 여러 작업에 걸리면
 * 가장 늦게 끝나는 상태가 이긴다(진행 중 > 미시공 > 완료 — 아직 끝나지 않은 작업이 있으면 완료가 아님).
 * 연결 안 된 객체는 손대지 않는다(모델 그대로 보임).
 */
export function fourDState(
  acts: TimedActivity[],
  links: ReadonlyMap<string, readonly number[]>,
  t: number,
  capacity: number,
  opts: { hideFuture: boolean; colors?: FourDColors },
): { paint: Uint8Array; hidden: number[]; painted: number } {
  const colors = opts.colors ?? FOUR_D_COLORS;
  // 0 = 연결 없음, 1 = 완료, 2 = 미시공, 3 = 진행(빠름), 4 = 진행(늦음), 5 = 진행
  const rank = new Uint8Array(capacity);
  for (const a of acts) {
    const ids = links.get(a.code);
    if (!ids || a.summary) continue;
    const p = phaseAt(a, t);
    const r = p === 'done' ? 1 : p === 'future' ? 2 : a.variance === 'early' ? 3 : a.variance === 'late' ? 4 : 5;
    for (const id of ids) if (id > 0 && id < capacity && rank[id] < r) rank[id] = r;
  }
  const paint = new Uint8Array(capacity * 4);
  const hidden: number[] = [];
  let painted = 0;
  for (let id = 1; id < capacity; id++) {
    const r = rank[id];
    if (r <= 1) continue;
    if (r === 2 && opts.hideFuture) { hidden.push(id); continue; }
    const rgb = r === 2 ? colors.future : r === 3 ? colors.early : r === 4 ? colors.late : colors.active;
    paint.set([rgb[0], rgb[1], rgb[2], 255], id * 4);
    painted++;
  }
  return { paint, hidden, painted };
}

/** 하루 단위로 내림(기준일 슬라이더 눈금). */
export function startOfDay(t: number): number {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export { DAY };
