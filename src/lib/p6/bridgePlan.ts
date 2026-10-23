// 교량 개략 IPS 생성(단계 4 · 방식 1·2). 공기는 코드가 정한다: 일수 = 수량 × 단위공기(출처 표), 선후행 = 공단 IPS 구성 표준
// (준비 및 조사 → 하부공(개소별 기초 → 교각 → 코핑) → 상부공(거치 → 공동구)) + 장비·작업조 수(투입안)에 따른 연속 작업.
// 크리티컬 포인트(야간 구간·작업 금지 기간·착수 가능일·우선 구간·인계 기한)는 제약으로 넣는다.
// AI 는 이 엔진의 입력(설계현황·단위공기 근거·크리티컬 포인트 해석)과 결과 설명만 맡는다(D28).
import { addDays, daysBetween, draftCpm, type DraftActivity, type DraftRelation, type DraftSchedule, type DraftWbs } from './schedule.js';

export interface Support {
  /** 'A1'·'P12' 처럼 공정표·모델과 같은 이름. */
  id: string;
  kind: 'abutment' | 'pier';
  /** 현장타설(1본씩) 또는 기성말뚝(PHC·강관 항타). */
  pileType: 'cast' | 'driven';
  pileCount: number;
  /** 말뚝 위 확대기초가 있는가(현장타설 단일 말뚝 교각은 보통 없음). */
  footing?: boolean;
  /** 교각 높이(m) — LOT 수 계산. */
  heightM?: number;
  /** 값의 근거(예: '수량산출서 12쪽: P12 현장타설말뚝 1본') — AI·사람이 채운 출처. */
  source?: string;
}

export interface Span {
  id: string;
  /** 양 끝 받침(Support.id). */
  from: string;
  to: string;
  kind: 'girder' | 'special';
  /** 특수 경간(하로교·강사재교 등)의 작업 이름과 일수. */
  specialName?: string;
  specialDays?: number;
}

export interface BridgeSite {
  /** WBS 이름(예 '연제교(상선)'). */
  name: string;
  /** Activity ID 앞머리(영문·숫자). */
  code: string;
  /** 노선 순서(시점 → 종점). */
  supports: Support[];
  spans: Span[];
}

export type RateKey =
  | 'castPile' | 'drivenPile' | 'pierFooting' | 'pierLot' | 'pierLotNext' | 'pierLotHeightM' | 'coping' | 'copingNight'
  | 'abutFoundation' | 'abutBody' | 'girderSpan' | 'girderNightFactor' | 'deckSpan' | 'prepRoad' | 'prepSurvey';

export interface Rate {
  key: RateKey;
  label: string;
  value: number;
  unit: string;
  source: string;
  /** 문서에 수치가 없어 가정한 값(사용자 확인 필요). */
  assumed?: boolean;
}

const PLAN = '실시설계 보고서 제3편 11장 11.6.4(2) 구조물공 공기분석';
/** 단위공기 기본값. 일수는 가동율을 반영한 달력일(출처가 그렇게 제시). */
export const DEFAULT_RATES: Rate[] = [
  { key: 'castPile', label: '현장타설말뚝 1본', value: 11, unit: '일/본(장비 1대)', source: `${PLAN}: 단위공정 7일, 가동율 66% → 11일` },
  { key: 'drivenPile', label: '기성말뚝(PHC·강관) 항타', value: 6, unit: '본/일(장비 1대)', source: '가정 — 시공계획에 수치 없음', assumed: true },
  { key: 'pierFooting', label: '교각 확대기초', value: 22, unit: '일', source: `${PLAN}: U-TYPE 구조물 기초 순 15일 → 22일 준용`, assumed: true },
  { key: 'pierLot', label: '교각 1 LOT', value: 10, unit: '일', source: `${PLAN}: 교각 단위공정 7일, 가동율 55.3% → 10일` },
  { key: 'pierLotNext', label: '교각 추가 LOT', value: 7, unit: '일/LOT', source: `${PLAN}: 2LOT 17일·3LOT 24일·4LOT 31일(철근조립 병행)` },
  { key: 'pierLotHeightM', label: '교각 LOT 높이', value: 3, unit: 'm', source: `${PLAN}: 1LOT = 3.0m` },
  { key: 'coping', label: '코핑(주간)', value: 27, unit: '일', source: `${PLAN}: 순 18일, 주간 가동율 55.3% → 27일` },
  { key: 'copingNight', label: '코핑(야간)', value: 25, unit: '일', source: `${PLAN}: 야간 가동율 30.3%, 거푸집 추가 투입 병행 → 25일` },
  { key: 'abutFoundation', label: '교대 말뚝·가시설·토공·기초', value: 74, unit: '일', source: `${PLAN}: 순 29+12일, 가동율 55.3% → 74일` },
  { key: 'abutBody', label: '교대 벽체·상부', value: 43, unit: '일', source: `${PLAN}: 순 16+8일, 가동율 55.3% → 43일(교대 계 119일)` },
  { key: 'girderSpan', label: 'WPC 거더 거치(런처)', value: 2, unit: '일/경간(런처 1대)', source: '가정 — 시공계획에 런처 사이클 수치 없음', assumed: true },
  { key: 'girderNightFactor', label: '야간 구간 거치 배율', value: 1.8, unit: '배', source: '가정 — 11.6.2 주간 Cal.6 70% / 야간 Cal.5 30.3% 참고', assumed: true },
  { key: 'deckSpan', label: '공동구·레벨링 콘크리트', value: 4, unit: '일/경간(작업조 1)', source: '가정 — 사용자 확인', assumed: true },
  { key: 'prepRoad', label: '작업 진입로 개설', value: 20, unit: '일', source: '가정 — 공단 표준 준비작업', assumed: true },
  { key: 'prepSurvey', label: '작업 계획수립·측량', value: 30, unit: '일', source: '가정 — 공단 표준 현장조사', assumed: true },
];

export type RateTable = Record<RateKey, number>;
export const rateTable = (rates: Rate[] = DEFAULT_RATES): RateTable =>
  Object.fromEntries(rates.map(r => [r.key, r.value])) as RateTable;

/** 투입안: 장비·작업조 수. 같은 공종 작업조는 맡은 구간을 시점 쪽부터 차례로 시공한다. */
export interface Levers {
  rigs: number;
  pierCrews: number;
  copingSets: number;
  launchers: number;
  deckCrews: number;
  /** 거치 작업 하나에 묶는 경간 수(공단 표준 30일 단위에 맞춤). */
  girderBatch: number;
}

export type CriticalPoint =
  | { kind: 'night'; supports: string[]; note?: string }
  | { kind: 'blocked'; supports: string[]; from: string; to: string; note?: string }
  | { kind: 'notBefore'; supports: string[]; date: string; note?: string }
  | { kind: 'priority'; supports: string[]; note?: string }
  | { kind: 'deadline'; name: string; date: string; scope: 'all' | 'substructure' | 'superstructure'; note?: string };

export interface PlanInput {
  site: BridgeSite;
  start: string;
  rates?: Rate[];
  criticalPoints?: CriticalPoint[];
}

export interface BasisRow {
  code: string;
  name: string;
  qty: string;
  days: number;
  source: string;
}

export interface PlanResult {
  levers: Levers;
  draft: DraftSchedule;
  basis: BasisRow[];
  finish: string;
  durationDays: number;
  critical: string[];
  deadlines: { name: string; date: string; planned: string; slackDays: number }[];
  dates: Map<string, { start: string; finish: string; float: number }>;
}

const ord = (s: string) => Number(/\d+/.exec(s)?.[0] ?? 0);

/** 길이 n 을 k 개 연속 구간으로(앞쪽이 하나씩 더). */
function chunks<T>(list: T[], k: number): T[][] {
  const n = Math.max(1, Math.min(k, list.length));
  const out: T[][] = [];
  let i = 0;
  for (let c = 0; c < n; c++) {
    const size = Math.floor(list.length / n) + (c < list.length % n ? 1 : 0);
    out.push(list.slice(i, i + size));
    i += size;
  }
  return out.filter(x => x.length);
}

export function buildBridgePlan(input: PlanInput, levers: Levers): PlanResult {
  const { site, start } = input;
  const rates = input.rates ?? DEFAULT_RATES;
  const R = rateTable(rates);
  const rateText = (k: string) => {
    const r = rates.find(x => x.key === k);
    return r ? `${r.label} ${r.value}${r.unit}${r.assumed ? '·가정' : ''}` : k;
  };
  const cps = input.criticalPoints ?? [];
  const night = new Set(cps.flatMap(c => (c.kind === 'night' ? c.supports : [])));
  const blockedOf = (id: string) => cps.flatMap(c => (c.kind === 'blocked' && c.supports.includes(id) ? [{ from: c.from, to: c.to }] : []));
  const notBeforeOf = (id: string) => cps.reduce<string | undefined>((m, c) => (c.kind === 'notBefore' && c.supports.includes(id) && (!m || c.date > m) ? c.date : m), undefined);
  const priority = new Set(cps.flatMap(c => (c.kind === 'priority' ? c.supports : [])));

  const P = site.code;
  const wbs: DraftWbs[] = [
    { code: P, name: site.name },
    { code: `${P}.1`, name: '준비 및 조사', parent: P },
    { code: `${P}.2`, name: '하부공', parent: P },
    { code: `${P}.3`, name: '상부공', parent: P },
  ];
  const acts: DraftActivity[] = [];
  const rels: DraftRelation[] = [];
  const basis: BasisRow[] = [];
  /** basis: 단위공기 키(RateKey)를 + 로 이은 것, 또는 그대로 쓸 글. */
  const add = (a: DraftActivity, qty: string, basisKeys: string) => {
    const source = basisKeys.split(/\s*[+×]\s*/).map(rateText).join(' + ');
    acts.push({ ...a, udfs: { ...(a.udfs ?? {}), 산정근거: `${qty} → ${a.durationDays}일 (${source})` } });
    basis.push({ code: a.code, name: a.name, qty, days: a.durationDays, source });
  };
  const fs = (pred: string, succ: string, lagDays = 0) => rels.push({ pred, succ, type: 'FS', lagDays });

  add({ code: `${P}-M000`, name: '착공', wbs: P, durationDays: 0, milestone: 'start' }, '마일스톤', '사용자 입력 과업시작일');
  add({ code: `${P}-PR01`, name: '작업 진입로 개설', wbs: `${P}.1`, durationDays: R.prepRoad }, '1식', 'prepRoad');
  add({ code: `${P}-PR02`, name: '작업 계획수립·측량', wbs: `${P}.1`, durationDays: R.prepSurvey }, '1식', 'prepSurvey');
  fs(`${P}-M000`, `${P}-PR01`);
  fs(`${P}-M000`, `${P}-PR02`);

  // 하부공: 개소별 WBS 와 작업
  const parts = new Map<string, { F: string; C?: string; K?: string; W?: string }>();
  for (const s of site.supports) {
    const w = `${P}.2.${s.id}`;
    wbs.push({ code: w, name: s.id, parent: `${P}.2` });
    const extra = { notBefore: notBeforeOf(s.id), blocked: blockedOf(s.id) };
    const F = `${P}-${s.id}-F`;
    if (s.kind === 'abutment') {
      add({ code: F, name: '기초', wbs: w, durationDays: R.abutFoundation, ...extra }, `교대 ${s.id}(말뚝 ${s.pileCount}본 포함)`, 'abutFoundation');
      const W = `${P}-${s.id}-W`;
      add({ code: W, name: '벽체', wbs: w, durationDays: R.abutBody, ...extra }, `교대 ${s.id}`, 'abutBody');
      fs(F, W);
      parts.set(s.id, { F, W });
    } else {
      const pileDays = s.pileType === 'cast' ? s.pileCount * R.castPile : Math.ceil(s.pileCount / Math.max(1, R.drivenPile));
      const footDays = s.footing ? R.pierFooting : 0;
      add({ code: F, name: '기초', wbs: w, durationDays: pileDays + footDays, ...extra },
        `${s.pileType === 'cast' ? '현장타설' : '기성'}말뚝 ${s.pileCount}본${s.footing ? ' + 확대기초' : ''}`,
        `${s.pileType === 'cast' ? 'castPile' : 'drivenPile'}${s.footing ? ' + pierFooting' : ''}`);
      const lots = Math.max(1, Math.ceil((s.heightM ?? R.pierLotHeightM) / R.pierLotHeightM));
      const C = `${P}-${s.id}-C`;
      add({ code: C, name: '교각시공', wbs: w, durationDays: R.pierLot + R.pierLotNext * (lots - 1), ...extra }, `높이 ${s.heightM ?? '?'}m → ${lots} LOT`, lots > 1 ? 'pierLot + pierLotNext' : 'pierLot');
      const K = `${P}-${s.id}-K`;
      const nightK = night.has(s.id);
      add({ code: K, name: '코핑시공', wbs: w, durationDays: nightK ? R.copingNight : R.coping, ...extra }, nightK ? '야간 구간' : '주간', nightK ? 'copingNight' : 'coping');
      fs(F, C);
      fs(C, K);
      parts.set(s.id, { F, C, K });
    }
    fs(`${P}-PR01`, F);
  }

  // 같은 공종 작업조: 우선 구간 먼저, 그다음 노선 순서로 연속 구간을 나눠 맡아 차례로
  const piers = site.supports.filter(s => s.kind === 'pier');
  const ordered = [...piers.filter(s => priority.has(s.id)), ...piers.filter(s => !priority.has(s.id))];
  const chain = (ids: string[]) => { for (let i = 1; i < ids.length; i++) fs(ids[i - 1], ids[i]); };
  for (const seg of chunks(ordered, levers.rigs)) chain(seg.map(s => parts.get(s.id)!.F));
  for (const seg of chunks(ordered, levers.pierCrews)) chain(seg.map(s => parts.get(s.id)!.C!));
  for (const seg of chunks(ordered, levers.copingSets)) chain(seg.map(s => parts.get(s.id)!.K!));

  // 상부공: 거치(경간 묶음) → 공동구, 특수 경간은 따로
  const doneOf = (id: string) => { const p = parts.get(id); return p ? (p.K ?? p.W ?? p.F) : null; };
  const girderSpans = site.spans.filter(s => s.kind === 'girder');
  const batches: Span[][] = [];
  for (let i = 0; i < girderSpans.length; i += Math.max(1, levers.girderBatch)) batches.push(girderSpans.slice(i, i + Math.max(1, levers.girderBatch)));
  const batchCode = (i: number) => `${P}-G${String(i + 1).padStart(2, '0')}`;
  const deckCode = (i: number) => `${P}-D${String(i + 1).padStart(2, '0')}`;
  batches.forEach((b, i) => {
    const nightSpans = b.filter(s => night.has(s.from) || night.has(s.to)).length;
    const days = Math.ceil((b.length - nightSpans) * R.girderSpan + nightSpans * R.girderSpan * R.girderNightFactor);
    const label = b.length > 1 ? `${b[0].id}~${b[b.length - 1].id}` : b[0].id;
    add({ code: batchCode(i), name: `WPC거더 거치 ${label}`, wbs: `${P}.3`, durationDays: Math.max(1, days) },
      `${b.length}경간${nightSpans ? `(야간 ${nightSpans})` : ''}`, nightSpans ? 'girderSpan × girderNightFactor' : 'girderSpan');
    for (const id of new Set(b.flatMap(s => [s.from, s.to]))) { const d = doneOf(id); if (d) fs(d, batchCode(i)); }
    add({ code: deckCode(i), name: `공동구(Leveling 콘크리트 포함) ${label}`, wbs: `${P}.3`, durationDays: Math.max(1, Math.ceil(b.length * R.deckSpan)) },
      `${b.length}경간`, 'deckSpan');
    fs(batchCode(i), deckCode(i));
  });
  for (const seg of chunks(batches.map((_, i) => i), levers.launchers)) chain(seg.map(batchCode));
  for (const seg of chunks(batches.map((_, i) => i), levers.deckCrews)) chain(seg.map(deckCode));
  for (const s of site.spans.filter(x => x.kind === 'special')) {
    const code = `${P}-X${s.id}`;
    add({ code, name: s.specialName ?? `특수 경간 ${s.id}`, wbs: `${P}.3`, durationDays: s.specialDays ?? 60 }, `경간 ${s.id}`, s.specialDays ? '사용자 입력' : '가정 60일');
    for (const id of [s.from, s.to]) { const d = doneOf(id); if (d) fs(d, code); }
  }

  // 완료·인계 기한 마일스톤
  const subEnds = [...parts.values()].map(p => p.K ?? p.W ?? p.F);
  const supEnds = [...batches.map((_, i) => deckCode(i)), ...site.spans.filter(x => x.kind === 'special').map(s => `${P}-X${s.id}`)];
  const END = `${P}-M999`;
  add({ code: END, name: `${site.name} 완료`, wbs: P, durationDays: 0, milestone: 'finish' }, '마일스톤', '모든 작업 완료');
  for (const c of [...subEnds, ...supEnds, `${P}-PR02`]) fs(c, END);
  const deadlines = cps.filter((c): c is Extract<CriticalPoint, { kind: 'deadline' }> => c.kind === 'deadline');
  deadlines.forEach((d, i) => {
    const code = `${P}-M9${String(i + 1).padStart(2, '0')}`;
    add({ code, name: d.name, wbs: P, durationDays: 0, milestone: 'finish' }, `기한 ${d.date}`, '크리티컬 포인트');
    for (const c of d.scope === 'substructure' ? subEnds : d.scope === 'superstructure' ? supEnds : [END]) fs(c, code);
  });

  const draft: DraftSchedule = { project: { code: P, name: site.name, start }, wbs, activities: acts, relations: rels };
  const { cpm } = draftCpm(draft);
  const dates = new Map<string, { start: string; finish: string; float: number }>();
  for (const a of acts) {
    const t = cpm.times.get(a.code)!;
    dates.set(a.code, { start: addDays(start, t.es), finish: addDays(start, Math.max(t.es, t.ef - 1)), float: t.float });
  }
  const finish = addDays(start, Math.max(0, cpm.duration - 1));
  return {
    levers, draft, basis, finish, durationDays: cpm.duration, critical: cpm.critical,
    deadlines: deadlines.map((d, i) => {
      const planned = dates.get(`${P}-M9${String(i + 1).padStart(2, '0')}`)!.start;
      return { name: d.name, date: d.date, planned, slackDays: daysBetween(planned, d.date) };
    }),
    dates,
  };
}

export const PRESETS: { key: string; title: string; levers: Levers }[] = [
  { key: 'A', title: 'A안 · 기본 투입', levers: { rigs: 1, pierCrews: 1, copingSets: 1, launchers: 1, deckCrews: 1, girderBatch: 5 } },
  { key: 'B', title: 'B안 · 병행 투입', levers: { rigs: 2, pierCrews: 2, copingSets: 2, launchers: 1, deckCrews: 2, girderBatch: 5 } },
  { key: 'C', title: 'C안 · 집중 투입', levers: { rigs: 3, pierCrews: 3, copingSets: 3, launchers: 2, deckCrews: 3, girderBatch: 5 } },
];

/** 방식 1: 과업시작일 기준 세 가지 안(투입 규모별). */
export function proposePlans(input: PlanInput, presets = PRESETS) {
  return presets.map(p => ({ ...p, result: buildBridgePlan(input, p.levers) }));
}

const leverCost = (l: Levers) => l.rigs + l.pierCrews + l.copingSets + l.launchers * 2 + l.deckCrews;

/**
 * 방식 2: 과업종료예정일 안에 끝나는 투입안을 찾는다. 작업 일수는 줄이지 않는다(단위공기는 그대로) — 장비·작업조를
 * 늘리는 것만 고른다. 맞는 안이 없으면 가장 빠른 안과 부족 일수를 돌려준다.
 */
export function fitToDeadline(input: PlanInput, finishBy: string, maxFronts = 6) {
  const tried: { title: string; result: PlanResult; cost: number }[] = [];
  for (let n = 1; n <= maxFronts; n++) {
    for (const launchers of [1, 2]) {
      const levers: Levers = { rigs: n, pierCrews: n, copingSets: n, launchers, deckCrews: Math.min(n, 3), girderBatch: 5 };
      tried.push({ title: `작업조 ${n}개 · 런처 ${launchers}대`, result: buildBridgePlan(input, levers), cost: leverCost(levers) });
    }
  }
  const ok = tried.filter(t => t.result.finish <= finishBy).sort((a, b) => a.cost - b.cost || a.result.durationDays - b.result.durationDays);
  if (ok.length) return { feasible: true as const, options: ok.slice(0, 3), shortfallDays: 0 };
  const fastest = [...tried].sort((a, b) => a.result.durationDays - b.result.durationDays)[0];
  return { feasible: false as const, options: [fastest], shortfallDays: daysBetween(finishBy, fastest.result.finish) };
}

/** 설계현황(개소 목록)에서 경간을 만든다: 이웃한 받침 사이마다 하나, 이름은 S1… */
export function spansFromSupports(supports: Support[], special: Record<string, { name: string; days?: number }> = {}): Span[] {
  const out: Span[] = [];
  for (let i = 1; i < supports.length; i++) {
    const id = `S${i}`;
    const sp = special[id];
    out.push({ id, from: supports[i - 1].id, to: supports[i].id, kind: sp ? 'special' : 'girder', specialName: sp?.name, specialDays: sp?.days });
  }
  return out;
}

/** 'P38~P46'·'P3, P5'·'A1' 같은 글을 개소 목록으로. */
export function parseSupportList(text: string, all: string[]): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([AP])(\d+)\s*[~-]\s*([AP])?(\d+)$/i.exec(part);
    if (m) {
      const kind = m[1].toUpperCase(), lo = Number(m[2]), hi = Number(m[4]);
      for (const id of all) if (id[0] === kind && ord(id) >= Math.min(lo, hi) && ord(id) <= Math.max(lo, hi)) out.add(id);
    } else {
      const id = part.toUpperCase().replace(/^([AP])0*(\d+)$/, '$1$2');
      if (all.includes(id)) out.add(id);
    }
  }
  return all.filter(id => out.has(id));
}
