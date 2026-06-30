// =====================================================================
// 4D 기성(Earned Value) 계산 — S54. 객체별 (금액, 계획 start/end, 실적
// actualStart/End) 레코드를 모아 특정 날짜 d 에서:
//   · 계획 기성누계(d) = Σ 금액 × 계획진행률(d)
//   · 실적 기성누계(d) = Σ 금액 × 실적진행률(d)
//   · 잔여(d)         = 총액 − 실적 기성누계(d)
// 를 산출하고, 월/주 버킷으로 비용 S-curve 시계열을 만든다.
//
// 진행률(초안 정책): **선형 보간**(경과 비율). 미착수=0, 진행중=경과/기간, 완료=1.
// (이진(완료 전 0)이 아니라 선형을 택함 — S-curve 가 매끄럽게 그려지고 부분
//  진행이 드러난다. 부분 타설 등 정밀 진행률은 범위 밖.)
// 실적 진행률은 actualStart 가 있을 때만 진행으로 본다(실적 미입력=0). 실적 종료가
// 없으면(진행 중) 계획 종료를 추정 종료로 사용한다.
// =====================================================================

/** 기성 계산의 최소 단위(보통 객체 1개, 또는 공종 묶음). */
export interface EvItem {
  /** 식별/디버그용 키(GlobalId 등). */
  key: string;
  /** 공종(카테고리) — 공종별 집계용. */
  category: string;
  /** 금액(원). */
  amount: number;
  /** 계획 시작/종료(epoch ms). */
  planStart: number;
  planEnd: number;
  /** 실적 시작/종료(epoch ms, 없으면 null). */
  actualStart: number | null;
  actualEnd: number | null;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 구간 [start,end] 에서 d 의 선형 경과 비율. 기간 0 이면 d>=start 일 때 1(계단). */
function spanProgress(start: number, end: number, d: number): number {
  if (!Number.isFinite(start)) return 0;
  if (!(end > start)) return d >= start ? 1 : 0;
  return clamp01((d - start) / (end - start));
}

/** 날짜 d 에서의 계획 진행률(0~1). */
export function plannedProgress(item: EvItem, d: number): number {
  return spanProgress(item.planStart, item.planEnd, d);
}

/** 날짜 d 에서의 실적 진행률(0~1). 실적 시작이 없으면 0(미착수로 간주). */
export function actualProgress(item: EvItem, d: number): number {
  if (item.actualStart == null) return 0;
  // 실적 종료가 없으면(진행 중) 계획 종료를 추정 종료로 사용.
  const end = item.actualEnd ?? item.planEnd;
  return spanProgress(item.actualStart, end, d);
}

/** 전체 총액(금액 합). */
export function totalAmount(items: EvItem[]): number {
  return items.reduce((s, it) => s + it.amount, 0);
}

/** 날짜 d 에서 계획 기성누계. */
export function plannedEarned(items: EvItem[], d: number): number {
  return items.reduce((s, it) => s + it.amount * plannedProgress(it, d), 0);
}

/** 날짜 d 에서 실적 기성누계. */
export function actualEarned(items: EvItem[], d: number): number {
  return items.reduce((s, it) => s + it.amount * actualProgress(it, d), 0);
}

/** 기준일 d 요약: 총액·계획누계·실적누계·잔여(총액−실적). */
export interface EvSummary {
  total: number;
  planned: number;
  actual: number;
  remaining: number;
}

export function summarizeAt(items: EvItem[], d: number): EvSummary {
  const total = totalAmount(items);
  const planned = plannedEarned(items, d);
  const actual = actualEarned(items, d);
  return { total, planned, actual, remaining: total - actual };
}

/** 공종(카테고리)별 기준일 행: 도급액·계획기성·실적기성·진행률·잔여. */
export interface EvCategoryRow {
  category: string;
  amount: number;
  planned: number;
  actual: number;
  /** 진행률 = 실적/도급액(0~1). 도급액 0 이면 0. */
  progress: number;
  remaining: number;
}

export function summarizeByCategory(items: EvItem[], d: number): EvCategoryRow[] {
  const byCat = new Map<string, EvItem[]>();
  for (const it of items) {
    let list = byCat.get(it.category);
    if (!list) {
      list = [];
      byCat.set(it.category, list);
    }
    list.push(it);
  }
  const rows: EvCategoryRow[] = [];
  for (const [category, list] of byCat) {
    const amount = totalAmount(list);
    const planned = plannedEarned(list, d);
    const actual = actualEarned(list, d);
    rows.push({
      category,
      amount,
      planned,
      actual,
      progress: amount > 0 ? actual / amount : 0,
      remaining: amount - actual,
    });
  }
  // 금액 큰 공종부터.
  return rows.sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------
// S-curve 시계열 — 전체 일정 범위를 주/월 버킷으로 끊어 각 시점의 계획/실적 누계.
// ---------------------------------------------------------------------

export type Bucket = 'week' | 'month';

export interface SCurvePoint {
  /** 버킷 끝 시각(epoch ms) — 그 시점까지의 누계를 담는다. */
  t: number;
  label: string;
  planned: number;
  actual: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** 일정 전체 범위(계획+실적 시작/종료의 최소~최대). 비면 null. */
export function evRange(items: EvItem[]): { start: number; end: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    for (const v of [it.planStart, it.planEnd, it.actualStart, it.actualEnd]) {
      if (v != null && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return { start: lo, end: hi };
}

function bucketLabel(t: number, bucket: Bucket): string {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  if (bucket === 'month') return `${y}-${m}`;
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/**
 * 비용 S-curve 시계열을 만든다. 전체 범위를 bucket(주=7일, 월=달 경계) 간격의
 * 시점들로 끊고, 각 시점까지의 계획/실적 누계를 계산한다(계획선 vs 실적선).
 * 점이 너무 많아지지 않게 최대 60개로 제한(주 버킷이 과하면 자동으로 듬성).
 */
export function buildSCurve(items: EvItem[], bucket: Bucket = 'month'): SCurvePoint[] {
  const range = evRange(items);
  if (!range) return [];
  const ticks: number[] = [];
  if (bucket === 'month') {
    const d = new Date(range.start);
    let cur = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    // 첫 시점은 시작일, 이후 매월 1일, 마지막은 종료일.
    ticks.push(range.start);
    cur = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    while (cur < range.end) {
      ticks.push(cur);
      const dc = new Date(cur);
      cur = new Date(dc.getFullYear(), dc.getMonth() + 1, 1).getTime();
    }
    ticks.push(range.end);
  } else {
    let cur = range.start;
    const span = range.end - range.start;
    // 주 버킷이 60개를 넘으면 간격을 키워 점 수를 제한.
    const step = Math.max(7 * DAY, Math.ceil(span / (60 * DAY)) * DAY);
    while (cur < range.end) {
      ticks.push(cur);
      cur += step;
    }
    ticks.push(range.end);
  }
  // 중복 제거 + 정렬.
  const uniq = [...new Set(ticks)].sort((a, b) => a - b);
  return uniq.map((t) => ({
    t,
    label: bucketLabel(t, bucket),
    planned: plannedEarned(items, t),
    actual: actualEarned(items, t),
  }));
}
