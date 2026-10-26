// 모델(RVT)에 들어 있는 공정 날짜(A5_계획/실시공정 시작·종료일)와 플랫폼 개략 IPS 안을 비교한다(D36).
// 잇는 키는 Activity ID 가 아니라 '개소 + 부위'(개략 IPS 코드와 실제 IPS 코드가 다르므로) — 모델 객체는 6단계와 같은 규칙
// (autolink 의 placeOf·partOf), 개략 IPS 작업은 코드 꼴(BR01-P12-F 기초 · -C 교각 · -K 코핑 · -W 교대 벽체 · -Gnn 거더 · -Dnn 공동구 · -X 특수 경간).
// 상부(거더·받침·상판)는 객체에 경간이 없어 개소별로 못 잇고 상부 전체 구간으로만 본다. 순수 함수 — 화면·AI 연결 공통.
import { buildBridgePlan, type Levers, type PlanInput, type PlanResult } from '../p6/bridgePlan.js';
import { addDays, daysBetween } from '../p6/schedule.js';
import { partOf, placeOf, type LinkPart } from './autolink.js';

export interface DatedObject {
  name: string;
  label?: string;
  type?: string;
  comment?: string;
  plannedStart?: string;
  plannedFinish?: string;
  actualStart?: string;
  actualFinish?: string;
}

/** planned = 모델 A5 계획공정, actual = 모델 A5 실시공정(실적). */
export type DateKind = 'planned' | 'actual';
export interface Span { start: string; finish: string; n: number }

/** 하부(개소별로 잇는 부위). 상부는 'super' 한 덩어리. */
const SUB: LinkPart[] = ['foundation', 'pier', 'coping', 'abutment'];
const SUPER: LinkPart[] = ['girder', 'deck', 'bearing', 'special'];
export const SUPER_KEY = 'super';

/** '2025-06-26' · '2025.06.26' · '2025/6/26' → 'YYYY-MM-DD'. 아니면 null. */
export function ymd(v: string | undefined): string | null {
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec((v ?? '').trim());
  if (!m) return null;
  const s = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

const widen = (map: Map<string, Span>, key: string, start: string, finish: string) => {
  const cur = map.get(key);
  map.set(key, cur
    ? { start: start < cur.start ? start : cur.start, finish: finish > cur.finish ? finish : cur.finish, n: cur.n + 1 }
    : { start, finish, n: 1 });
};

/** 모델 객체 → '개소|부위' 별 기간(가장 이른 시작 ~ 가장 늦은 종료), 상부는 'super'. 날짜 없는 객체는 뺀다. */
export function modelSpans(objects: DatedObject[], kind: DateKind): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const o of objects) {
    const start = ymd(kind === 'planned' ? o.plannedStart : o.actualStart);
    const finish = ymd(kind === 'planned' ? o.plannedFinish : o.actualFinish);
    if (!start || !finish || finish < start) continue;
    const part = partOf(o.label) ?? partOf(o.name) ?? partOf(o.type) ?? partOf(o.comment);
    if (!part) continue;
    if (SUPER.includes(part)) { widen(out, SUPER_KEY, start, finish); continue; }
    const place = placeOf(o.label) ?? placeOf(o.comment) ?? placeOf(o.type) ?? placeOf(o.name);
    if (place && SUB.includes(part)) widen(out, `${place}|${part}`, start, finish);
  }
  return out;
}

const SUFFIX: Record<string, LinkPart> = { F: 'foundation', C: 'pier', K: 'coping', W: 'abutment' };

/** 개략 IPS 안 → '개소|부위' 별 기간, 상부는 'super'. */
export function planSpans(r: PlanResult): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const a of r.draft.activities) {
    const d = r.dates.get(a.code);
    if (!d) continue;
    const sub = /-([AP]\d+)-([FCKW])$/.exec(a.code);
    if (sub) widen(out, `${sub[1]}|${SUFFIX[sub[2]]}`, d.start, d.finish);
    else if (/-(G|D)\d+$|-X/.test(a.code)) widen(out, SUPER_KEY, d.start, d.finish);
  }
  return out;
}

/** 하부 작업이 처음 시작하는 날(맞춤 기준). */
export function firstSubStart(spans: Map<string, Span>): string | null {
  let first: string | null = null;
  for (const [k, s] of spans) if (k !== SUPER_KEY && (!first || s.start < first)) first = s.start;
  return first;
}

export interface SpanDiff {
  key: string;
  place: string;
  part: LinkPart;
  model: Span;
  plan: Span;
  /** 개략 IPS − 모델(일). + 면 개략 IPS 가 늦음. */
  startDiff: number;
  finishDiff: number;
  modelDays: number;
  planDays: number;
}

export interface DateCompare {
  rows: SpanDiff[];
  /** 모델에만 있는 '개소|부위'(개략 IPS 에 없음), 개략 IPS 에만 있는 것. */
  modelOnly: string[];
  planOnly: string[];
  /** 잇게 된 하부 행의 평균 절대 차이(일). */
  mae: { start: number; finish: number; days: number };
  /** 평균 부호 차이(일) — + 면 개략 IPS 가 대체로 늦음. */
  bias: { finish: number; days: number };
  /** 시공 순서가 얼마나 같은가(시작일 순위 상관, −1~1). */
  order: number | null;
  sub: { model: Span | null; plan: Span | null; finishDiff: number | null };
  superstructure: { model: Span | null; plan: Span | null; finishDiff: number | null };
}

const days = (s: Span) => daysBetween(s.start, s.finish) + 1;
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
const total = (spans: Map<string, Span>, sub: boolean): Span | null => {
  const list = [...spans].filter(([k]) => (k === SUPER_KEY) !== sub).map(([, s]) => s);
  return list.length ? list.reduce((t, s) => ({ start: s.start < t.start ? s.start : t.start, finish: s.finish > t.finish ? s.finish : t.finish, n: t.n + s.n })) : null;
};

/** 순위(같은 값은 평균 순위). */
function ranks(xs: string[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function correlation(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
}

export function compareSpans(model: Map<string, Span>, plan: Map<string, Span>): DateCompare {
  const rows: SpanDiff[] = [];
  for (const [key, m] of model) {
    if (key === SUPER_KEY) continue;
    const p = plan.get(key);
    if (!p) continue;
    const [place, part] = key.split('|') as [string, LinkPart];
    rows.push({ key, place, part, model: m, plan: p, startDiff: daysBetween(m.start, p.start), finishDiff: daysBetween(m.finish, p.finish), modelDays: days(m), planDays: days(p) });
  }
  const ord = (k: string) => { const [pl, pa] = k.split('|'); return `${pl[0] === 'A' ? (pl === 'A1' ? 0 : 2) : 1}${String(Number(pl.slice(1))).padStart(4, '0')}${SUB.indexOf(pa as LinkPart)}`; };
  rows.sort((a, b) => ord(a.key).localeCompare(ord(b.key)));
  const subM = total(model, true), subP = total(plan, true), supM = model.get(SUPER_KEY) ?? null, supP = plan.get(SUPER_KEY) ?? null;
  return {
    rows,
    modelOnly: [...model.keys()].filter(k => k !== SUPER_KEY && !plan.has(k)),
    planOnly: [...plan.keys()].filter(k => k !== SUPER_KEY && !model.has(k)),
    mae: { start: mean(rows.map(r => Math.abs(r.startDiff))), finish: mean(rows.map(r => Math.abs(r.finishDiff))), days: mean(rows.map(r => Math.abs(r.planDays - r.modelDays))) },
    bias: { finish: mean(rows.map(r => r.finishDiff)), days: mean(rows.map(r => r.planDays - r.modelDays)) },
    order: correlation(ranks(rows.map(r => r.model.start)), ranks(rows.map(r => r.plan.start))),
    sub: { model: subM, plan: subP, finishDiff: subM && subP ? daysBetween(subM.finish, subP.finish) : null },
    superstructure: { model: supM, plan: supP, finishDiff: supM && supP ? daysBetween(supM.finish, supP.finish) : null },
  };
}

/** 부위 이름(표시용). */
export const PART_NAME: Record<string, string> = { foundation: '기초', pier: '교각', coping: '코핑', abutment: '교대 벽체' };

/** 부위별 평균 작업 기간(모델 ↔ 안) — 단위공기 보정의 근거. */
export function partDays(rows: SpanDiff[]): { part: LinkPart; n: number; model: number; plan: number }[] {
  const by = new Map<LinkPart, SpanDiff[]>();
  for (const r of rows) by.set(r.part, [...(by.get(r.part) ?? []), r]);
  return SUB.filter(p => by.has(p)).map(p => {
    const rs = by.get(p)!;
    return { part: p, n: rs.length, model: Math.round(mean(rs.map(r => r.modelDays))), plan: Math.round(mean(rs.map(r => r.planDays))) };
  });
}

/** 한 부위의 개소 시공 순서(시작일 순). */
export function startOrder(spans: Map<string, Span>, part: LinkPart = 'foundation'): string[] {
  return [...spans].filter(([k]) => k.endsWith(`|${part}`)).sort((a, b) => (a[1].start < b[1].start ? -1 : a[1].start > b[1].start ? 1 : 0)).map(([k]) => k.split('|')[0]);
}

/** 같은 부위가 동시에 몇 곳 진행됐나(최대·평균) — 현장 투입 규모 추정. */
export function concurrency(spans: Map<string, Span>, part: LinkPart): { max: number; mean: number } | null {
  const list = [...spans].filter(([k]) => k.endsWith(`|${part}`)).map(([, s]) => s);
  if (!list.length) return null;
  const ev: [string, number][] = [];
  for (const s of list) { ev.push([s.start, 1]); ev.push([new Date(Date.parse(`${s.finish}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), -1]); }
  ev.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let cur = 0, max = 0, area = 0, last: string | null = null;
  for (const [d, x] of ev) { if (last && cur > 0) area += cur * daysBetween(last, d); cur += x; max = Math.max(max, cur); last = d; }
  const first = list.reduce((m, s) => (s.start < m ? s.start : m), list[0].start);
  const end = list.reduce((m, s) => (s.finish > m ? s.finish : m), list[0].finish);
  return { max, mean: Math.round((area / (daysBetween(first, end) + 1)) * 10) / 10 };
}

export interface OptionCompare { title: string; levers: Levers; start: string; result: PlanResult; cmp: DateCompare }

/**
 * 안마다 비교: 과업시작일을 '모델의 첫 하부 작업일 − (그 안에서 첫 하부 작업까지 걸리는 준비 기간)'으로 맞춰 다시 계산한 뒤 잇는다
 * — 시작일이 달라 생기는 일괄 차이를 빼고 순서·속도만 본다. 모델에 날짜가 없으면 aligned = null.
 */
export function compareOptions(model: Map<string, Span>, input: PlanInput, options: { title: string; levers: Levers }[]): { aligned: string | null; options: OptionCompare[] } {
  const first = firstSubStart(model);
  if (!first) return { aligned: null, options: [] };
  return {
    aligned: first,
    options: options.map(o => {
      const r0 = buildBridgePlan(input, o.levers);
      const lead = daysBetween(input.start, firstSubStart(planSpans(r0)) ?? input.start);
      const start = addDays(first, -lead);
      const result = buildBridgePlan({ ...input, start }, o.levers);
      return { title: o.title, levers: o.levers, start, result, cmp: compareSpans(model, planSpans(result)) };
    }),
  };
}
