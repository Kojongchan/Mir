// 수량분개(5번, 10-27 사용자 "당연히 너가 수량분개를 해야지"): 산출내역서(구조물 묶음 — 연제교는 상·하선 합계) 항목마다
//   1) 수량산출서 개소별 집계표의 같은 항목 행을 찾고(qtyTable.ts, 위치로 읽은 열 값)
//   2) 이 대상(예 상선)의 몫 = 대상 열(교각공(상선)) 전부 + 함께 쓰는 열(교대공·상부공·공동구…) × 몫 비율(근거와 함께, 없으면 가정)
//   3) 작업(개소·부위)으로 배분: 열·절(토공및기초공/교대공/교각공/상부공)·항목 이름으로 부위를 정하고, 같은 부위 작업끼리는
//      말뚝 본수(기초)·작업 일수(교각·코핑)·경간 수(거치·공동구)에 비례
//   4) 금액 = 배분 수량 × 내역 단가(코드 계산) → 작업별 공사비(5D, S-curve)
// AI 는 집계표 쪽을 찾고 함께 쓰는 열의 몫(예 교대 3곳 중 상선 1곳)을 근거와 함께 정한다. 숫자는 문서·엔진에서만. 순수 함수.
import { placeOf, spansOfName } from './autolink.js';
import { rowKey, type SheetRow } from './qtyTable.js';
import { wbsScope } from './wbsScope.js';
import type { BridgeSite } from '../p6/bridgePlan';
import type { P6Schedule } from '../p6/schedule';

export interface BoqItem { id: string; name: string; spec: string; unit: string; qty: number; amount: number }

/** 함께 쓰는 열의 이 대상 몫. */
export interface ColumnShare { share: number; source: string; assumed?: boolean }

/** 저장하는 분개 원자료(SetupData.qtySplit): 내역 항목과 맞춘 집계표 행 값, 열 몫, 항목별 고침. 배분은 저장하지 않고 엔진이 다시 한다. */
export interface QtySplitData {
  /** 내역서 구간(예 '2-1. 연제교')과 집계표 위치(파일·쪽). */
  section: string;
  sheet: string;
  at: string;
  /** note: 집계표 표기가 내역서와 다를 때 그 표기(맞춤 근거 · 품명 오기 확인용). */
  lines: (BoqItem & { page?: number; path?: string[]; cols?: Record<string, number>; note?: string })[];
  shares: Record<string, ColumnShare>;
  /** 항목별 고침(사람·AI): 이 대상 몫 비율 또는 부위. */
  overrides?: Record<string, { share?: number; group?: Group; source: string }>;
}

export type Group = 'abut' | 'pierFoundation' | 'pierBody' | 'girder' | 'deck' | 'special';
export const GROUP_LABEL: Record<Group, string> = {
  abut: '교대', pierFoundation: '교각 기초', pierBody: '교각·코핑', girder: '거더 거치·받침', deck: '상판·공동구', special: '특수 경간',
};

const TOTAL = /^(계|합계)$/;
const LINE = /\((상선|하선)\)/;

const nameKey = (s: string) => s.replace(/\s+/g, '').replace(/\((자재비|풀림방지너트|표준시장|대피할증)\)/g, '').replace(/거더|이내/g, '').toLowerCase();
/** 글자 두 개씩 묶은 것의 겹침(0~1). */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const x = grams(a), y = grams(b);
  let common = 0;
  for (const [g, n] of x) common += Math.min(n, y.get(g) ?? 0);
  return (2 * common) / Math.max(1, a.length - 1 + b.length - 1);
}

export interface SheetMatch { row: SheetRow; note?: string }

/**
 * 내역 항목 ↔ 집계표 행. 같은 항목이 여러 절에 나오므로(예 합판거푸집) 내역서와 집계표의 순서가 같다는 점을 쓴다.
 * 1) 이름·규격·단위가 같고 수량이 맞는(반올림 차) 행 — 앞에서부터 차례로, 없으면 전체에서 아직 안 쓴 행
 * 2) 표기가 다른 것(내역서 'WPC거더 제작 및 가설' ↔ 집계표 'WPC 제작 및 가설', 'L=12.0km이내' ↔ 'L=12.0km', '선단' ↔ '선단고정액'):
 *    단위·수량이 맞고 이름이 비슷하면(글자 겹침 0.5 이상, 순서상 가까우면 0.25) — 다른 표기는 note 로 남긴다(내역서 품명 오기 확인용).
 */
export function matchSheet(boq: BoqItem[], rows: SheetRow[]): Map<string, SheetMatch> {
  const out = new Map<string, SheetMatch>();
  const used = new Set<number>();
  const keys = rows.map(r => rowKey(r.name, r.spec, r.unit));
  const total = (r: SheetRow) => r.cols['합계'] ?? r.cols['계'] ?? Object.entries(r.cols).filter(([k]) => !TOTAL.test(k)).reduce((s, [, v]) => s + v, 0);
  const fits = (r: SheetRow, q: number) => Math.abs(total(r) - q) <= Math.max(1, Math.abs(q) * 0.01);
  const unitKey = (u: string) => rowKey('', '', u);
  let at = 0;
  const take = (b: BoqItem, i: number, note?: string) => { used.add(i); at = i + 1; out.set(b.id, note ? { row: rows[i], note } : { row: rows[i] }); };
  const later: BoqItem[] = [];
  for (const b of boq) {
    const key = rowKey(b.name, b.spec, b.unit);
    let hit = -1;
    for (let i = at; i < rows.length; i++) if (!used.has(i) && keys[i] === key && fits(rows[i], b.qty)) { hit = i; break; }
    if (hit < 0) for (let i = 0; i < rows.length; i++) if (!used.has(i) && keys[i] === key && fits(rows[i], b.qty)) { hit = i; break; }
    if (hit < 0) { later.push(b); continue; }
    take(b, hit);
  }
  // 2) 표기 다른 것: 정확히 맞춘 뒤 남은 행에서
  for (const b of later) {
    const pos = boq.indexOf(b);
    let best = -1, bestScore = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (used.has(i) || unitKey(r.unit) !== unitKey(b.unit) || !fits(r, b.qty)) continue;
      const s = Math.max(similarity(nameKey(b.name), nameKey(r.name)), similarity(nameKey(b.name + b.spec), nameKey(r.name + r.spec)) * 0.9);
      // 순서상 위치(내역서 항목 순번 ↔ 집계표 행 순번 비율)가 가까우면 문턱을 낮춘다
      const near = Math.abs(i - pos) <= 2 || Math.abs(i / Math.max(1, rows.length) - pos / Math.max(1, boq.length)) < 0.08;
      if ((s >= 0.5 || (near && s >= 0.25)) && s > bestScore) { best = i; bestScore = s; }
    }
    if (best >= 0) {
      const r = rows[best];
      const diff = rowKey(b.name, b.spec, b.unit) !== rowKey(r.name, r.spec, r.unit);
      take(b, best, diff ? `집계표 표기: ${r.name}${r.spec ? ` ${r.spec}` : ''}` : undefined);
    }
  }
  return out;
}

/** 열 값이 합계뿐인 행(예 'WPC 제작 및 가설 … 138')의 열: 절 이름에서. */
function columnOfSection(path: string[]): string {
  const sec = path.join(' ');
  if (/사재교|하로교/.test(sec)) return '사재교·하로교';
  if (/교대공/.test(sec)) return '교대공';
  if (/상부공|공동구/.test(sec)) return '상부공';
  return '(합계만)';
}

/** 대상 이름의 노선(상선·하선). 없으면 null(한 덩어리 대상). */
export const lineOf = (target: string) => (/상선|상행/.test(target) ? '상선' : /하선|하행/.test(target) ? '하선' : null);

/**
 * 열마다 이 대상 몫: 노선이 붙은 열(교각공(상선))은 같은 노선이면 1·아니면 0, 함께 쓰는 열은 저장된 몫 → 없으면 교각공 상선/하선 비율(가정).
 */
export function columnShares(rows: SheetRow[], target: string, saved: Record<string, ColumnShare> = {}): Record<string, ColumnShare> {
  const line = lineOf(target);
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.cols)) if (!TOTAL.test(k)) cols.add(k);
  let mine = 0, both = 0;
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.cols)) {
      const m = LINE.exec(k);
      if (!m || r.unit !== 'm3') continue;
      both += v;
      if (m[1] === line) mine += v;
    }
  }
  const ratio = line && both > 0 ? mine / both : 1;
  const out: Record<string, ColumnShare> = {};
  for (const c of cols) {
    const m = LINE.exec(c);
    if (m) out[c] = { share: line ? (m[1] === line ? 1 : 0) : 1, source: `열 이름(${m[1]})` };
    else if (saved[c]) out[c] = saved[c];
    else out[c] = { share: Math.round(ratio * 1000) / 1000, source: line ? `가정 — 교각공 콘크리트 ${line} 비율(${(ratio * 100).toFixed(1)}%)` : '대상 전체', assumed: !!line };
  }
  return out;
}

/** 열·절·항목 이름 → 부위. */
export function groupOf(column: string, path: string[], name: string, spec: string): Group | null {
  const sec = path.join(' '), text = `${name} ${spec}`;
  if (/사재교|하로교/.test(column)) return 'special';
  if (/교대/.test(column)) return 'abut';
  if (/교각/.test(column)) {
    if (/교좌|Sole\s*Plate|무수축/i.test(text)) return 'girder';
    return /토공|기초/.test(sec) && !/교각공/.test(sec) ? 'pierFoundation' : 'pierBody';
  }
  if (/상부|공동구|전철주|방음벽/.test(column)) return /WPC|거더|고무받침|교좌/.test(text) ? 'girder' : 'deck';
  return null;
}

export interface SplitActivity { code: string; name: string; path: string[]; days: number }

/**
 * 배분할 작업: 대상 구조물 WBS 아래(6단계 연결에 저장한 WBS 이름, 없으면 공정표 맨 위) — 올린 실제 IPS 처럼 여러 구조물이 든 공정표에서
 * 다른 구조물 작업으로 새지 않게.
 */
export function splitActivities(s: P6Schedule, wbsRoot?: string): SplitActivity[] {
  const { nodes, under } = wbsScope(s);
  const node = wbsRoot ? nodes.find(n => n.name === wbsRoot || n.name.split(' — ')[0] === wbsRoot) : undefined;
  const rootId = node?.id ?? s.wbs.find(w => !w.parentId)?.id;
  if (!rootId) return [];
  const days = new Map(s.activities.map(a => [a.code, a.durationDays]));
  return under(rootId).map(a => ({ ...a, days: days.get(a.code) ?? 0 }));
}

const PILE_ITEM = /말뚝|파일|PHC|강관|천공|두부|이음|재하|그라우팅|고정액|케이싱|R\.?C\.?D|굴착|사토|건전도|연직도|플랫바|오름방지|스페이서제작|섬유거푸집|커플러/i;

/**
 * 부위의 작업들과 비중. 기초는 말뚝 본수(말뚝 종류가 맞는 개소 — PHC·강관 = 기성, D3,000·R.C.D·케이싱 = 현장타설), 교각·코핑은 작업 일수,
 * 거치·공동구는 경간 수. 교대 열은 토공및기초공 절이면 기초, 교대공 절이면 벽체(바닥·기초 콘크리트는 기초).
 */
function targetsOf(group: Group, path: string[], item: string, acts: SplitActivity[], site: BridgeSite | undefined): { code: string; w: number }[] {
  const at = (a: SplitActivity) => a.path.map(p => placeOf(p)).find(Boolean) ?? null;
  const support = (id: string | null) => site?.supports.find(s => s.id === id);
  const pileItem = PILE_ITEM.test(item);
  if (group === 'abut' || group === 'pierFoundation') {
    const kind = group === 'abut' ? 'A' : 'P';
    const sec = path.join(' ');
    const isFoundation = group === 'pierFoundation' || /토공|기초|말뚝/.test(sec) || /바닥콘크리트|기초콘크리트/.test(item);
    let cands = acts.filter(a => at(a)?.startsWith(kind) && (isFoundation ? /기초|말뚝|가시설|토공/.test(a.name) : /벽체|교대/.test(a.name)));
    if (!cands.length) cands = acts.filter(a => at(a)?.startsWith(kind));
    const byPlace = new Map<string, SplitActivity[]>();
    for (const a of cands) { const p = at(a)!; (byPlace.get(p) ?? byPlace.set(p, []).get(p)!).push(a); }
    const want = /PHC|강관|D6\d\d/i.test(item) ? 'driven' : /D3,?000|R\.?C\.?D|현장타설|케이싱|수중|말뚝조성/i.test(item) ? 'cast' : null;
    const pick = (filter: boolean) => {
      const out: { code: string; w: number }[] = [];
      for (const [p, list] of byPlace) {
        const s = support(p);
        if (filter && want && s && s.pileType !== want && group === 'pierFoundation') continue;
        const w = group === 'pierFoundation' ? Math.max(1, s?.pileCount ?? 1) : 1;
        // 나뉜 기초(말뚝 / 확대기초, 교대 말뚝·가시설·토공 / 기초): 말뚝 항목은 앞, 나머지는 뒤
        const split = list.length > 1 ? list.filter(a => /말뚝|가시설|토공/.test(a.name) === pileItem) : list;
        const use = split.length ? split : list;
        for (const a of use) out.push({ code: a.code, w: w / use.length });
      }
      return out;
    };
    const filtered = pick(true);
    return filtered.length ? filtered : pick(false);
  }
  if (group === 'pierBody') {
    const coping = /코핑/.test(item), pier = /교각부|PIER/i.test(item);
    return acts.filter(a => at(a)?.startsWith('P') && (coping ? /코핑/.test(a.name) : pier ? /교각|기둥/.test(a.name) : /코핑|교각|기둥/.test(a.name)))
      .map(a => ({ code: a.code, w: Math.max(1, a.days) }));
  }
  const spanCount = (a: SplitActivity) => { const s = spansOfName(a.name); return s ? s.hi - s.lo + 1 : 1; };
  if (group === 'girder') return acts.filter(a => /거치|거더/.test(a.name)).map(a => ({ code: a.code, w: spanCount(a) }));
  if (group === 'deck') return acts.filter(a => /공동구|슬래브|상판/.test(a.name)).map(a => ({ code: a.code, w: spanCount(a) }));
  return acts.filter(a => /하로교|사재교|특수/.test(a.name)).map(a => ({ code: a.code, w: Math.max(1, a.days) }));
}

export interface SplitLine extends BoqItem {
  unitPrice: number;
  row: { page?: number; path?: string[]; cols?: Record<string, number> } | null;
  /** 이 대상 몫 수량·금액과 그 근거. */
  targetQty: number;
  targetAmount: number;
  basis: string;
  groups: Group[];
  alloc: { code: string; qty: number; amount: number }[];
  status: 'allocated' | 'not-target' | 'no-activity' | 'unmatched';
}

export interface SplitResult {
  lines: SplitLine[];
  /** 작업 → 공사비(계약 기준, 원). */
  byCode: Map<string, number>;
  totals: { boq: number; target: number; allocated: number; unmatched: number; noActivity: number };
  shares: Record<string, ColumnShare>;
}

/** 분개 원자료 + 공정표 작업 + 설계현황 → 항목별 이 대상 몫·작업 배분·작업별 공사비. */
/** 행의 배분 열: 열 값 그대로, 합계만 있는 행(예 WPC 제작 및 가설)은 절 이름의 열로. */
function partsOf(cols: Record<string, number>, path: string[]): [string, number][] {
  const own = Object.entries(cols).filter(([k]) => !TOTAL.test(k));
  const sum = cols['합계'] ?? cols['계'] ?? 0;
  return own.length ? own : sum ? [[columnOfSection(path), sum]] : [];
}

export function splitQuantities(data: QtySplitData, target: string, acts: SplitActivity[], site?: BridgeSite): SplitResult {
  const rows = data.lines.filter(l => l.cols).map(l => ({ page: l.page ?? 0, path: l.path ?? [], name: l.name, spec: l.spec, unit: l.unit,
    cols: { ...l.cols!, ...Object.fromEntries(partsOf(l.cols!, l.path ?? [])) } }));
  const shares = columnShares(rows, target, data.shares);
  const byCode = new Map<string, number>();
  const totals = { boq: 0, target: 0, allocated: 0, unmatched: 0, noActivity: 0 };
  const lines: SplitLine[] = data.lines.map(l => {
    const unitPrice = l.qty ? l.amount / l.qty : 0;
    totals.boq += l.amount;
    const base = { ...l, unitPrice, row: l.cols ? { page: l.page, path: l.path, cols: l.cols } : null };
    if (!l.cols) { totals.unmatched += l.amount; return { ...base, targetQty: 0, targetAmount: 0, basis: '집계표에서 같은 항목을 못 찾음', groups: [], alloc: [], status: 'unmatched' as const }; }
    const over = data.overrides?.[l.id];
    const parts = partsOf(l.cols, l.path ?? []);
    const sheetSum = parts.reduce((s, [, v]) => s + v, 0);
    const scale = sheetSum > 0 ? l.qty / sheetSum : 0; // 집계표 소수 → 내역 반올림 수량
    const alloc = new Map<string, number>();
    const groups = new Set<Group>();
    const basis: string[] = [];
    let targetQty = 0, missing = 0;
    for (const [col, v] of parts) {
      const share = over?.share ?? shares[col]?.share ?? 0;
      const q = v * scale * share;
      if (q <= 0) continue;
      targetQty += q;
      basis.push(`${col} ${v.toLocaleString('ko-KR')} × ${share === 1 ? '1' : share.toFixed(3)}${over?.share != null ? '(고침)' : shares[col]?.assumed ? '(가정)' : ''}`);
      const g = over?.group ?? groupOf(col, l.path ?? [], l.name, l.spec);
      if (!g) { missing += q; continue; }
      groups.add(g);
      const t = targetsOf(g, l.path ?? [], `${l.name} ${l.spec}`, acts, site);
      const w = t.reduce((s, x) => s + x.w, 0);
      if (!w) { missing += q; continue; }
      for (const x of t) alloc.set(x.code, (alloc.get(x.code) ?? 0) + q * x.w / w);
    }
    const targetAmount = targetQty * unitPrice;
    totals.target += targetAmount;
    totals.noActivity += missing * unitPrice;
    const list = [...alloc].map(([code, qty]) => ({ code, qty, amount: qty * unitPrice }));
    for (const a of list) { byCode.set(a.code, (byCode.get(a.code) ?? 0) + a.amount); totals.allocated += a.amount; }
    const status = targetQty <= 0 ? 'not-target' : list.length ? 'allocated' : 'no-activity';
    const where = `${l.path?.slice(-1)[0] ?? ''} ${l.page ? `${l.page}쪽` : ''}`.trim();
    return { ...base, targetQty, targetAmount, basis: `${where}: ${basis.join(' + ') || '이 대상 열 없음'}${l.note ? ` · ${l.note}` : ''}`, groups: [...groups], alloc: list, status };
  });
  return { lines, byCode, totals, shares };
}

/** 분개 원자료 만들기: 내역 항목 + 집계표 행(맞춘 것만 값, 표기가 다르면 note). */
export function buildSplitData(section: string, sheet: string, boq: BoqItem[], rows: SheetRow[], prev?: QtySplitData | null): QtySplitData {
  const m = matchSheet(boq, rows);
  return {
    section, sheet, at: new Date().toISOString(),
    lines: boq.map(b => {
      const r = m.get(b.id);
      return r ? { ...b, page: r.row.page, path: r.row.path, cols: r.row.cols, ...(r.note ? { note: r.note } : {}) } : { ...b };
    }),
    shares: prev?.shares ?? {},
    ...(prev?.overrides ? { overrides: prev.overrides } : {}),
  };
}
