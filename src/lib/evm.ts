import { supabase } from './supabase';

// =====================================================================
// R6 — EVM(Earned Value Management) 원가관리 데이터층 (5D).
// cost_rates(공종별 단가×물량 = BAC) + evm_actual(기준일별 PV/EV/AC 스냅샷) 에서
// CPI/SPI/EAC·3선 S-curve·공종별 지표를 계산한다. 기성내역(0011)과 대사한다.
// 계산은 전부 클라이언트(집계). RLS 쓰기 = is_editor.
// =====================================================================

export interface CostRate {
  id: string;
  project_id: string;
  category: string;
  qty_basis: string | null;
  unit_price: number;
  manual_qty: number;
  sort_order: number;
}

export interface EvmActual {
  id: string;
  project_id: string;
  category: string | null;
  as_of_date: string;
  pv_amount: number;
  ev_amount: number;
  ac_amount: number;
  note: string | null;
}

const RATE_COLS = 'id, project_id, category, qty_basis, unit_price, manual_qty, sort_order';
const ACTUAL_COLS = 'id, project_id, category, as_of_date, pv_amount, ev_amount, ac_amount, note';

// ---------- cost_rates -----------------------------------------------

export async function listCostRates(projectId: string): Promise<CostRate[]> {
  const { data, error } = await supabase
    .from('cost_rates')
    .select(RATE_COLS)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ...r,
    unit_price: Number(r.unit_price),
    manual_qty: Number(r.manual_qty),
  })) as CostRate[];
}

export async function upsertCostRate(
  projectId: string,
  row: Partial<CostRate> & { category: string },
): Promise<void> {
  const payload = {
    id: row.id,
    project_id: projectId,
    category: row.category,
    qty_basis: row.qty_basis ?? null,
    unit_price: row.unit_price ?? 0,
    manual_qty: row.manual_qty ?? 0,
    sort_order: row.sort_order ?? 0,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('cost_rates').upsert(payload);
  if (error) throw error;
}

export async function deleteCostRate(id: string): Promise<void> {
  const { error } = await supabase.from('cost_rates').delete().eq('id', id);
  if (error) throw error;
}

/** 공종별 예산금액(BAC 성분) = 단가 × 물량. */
export function rateBudget(r: CostRate): number {
  return r.unit_price * r.manual_qty;
}

// ---------- evm_actual (스냅샷) --------------------------------------

export async function listEvmActuals(projectId: string): Promise<EvmActual[]> {
  const { data, error } = await supabase
    .from('evm_actual')
    .select(ACTUAL_COLS)
    .eq('project_id', projectId)
    .order('as_of_date', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ...r,
    pv_amount: Number(r.pv_amount),
    ev_amount: Number(r.ev_amount),
    ac_amount: Number(r.ac_amount),
  })) as EvmActual[];
}

export interface EvmActualInput {
  category?: string | null;
  as_of_date: string;
  pv_amount: number;
  ev_amount: number;
  ac_amount: number;
  note?: string | null;
}

export async function addEvmActual(projectId: string, input: EvmActualInput): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('evm_actual').insert({
    project_id: projectId,
    category: input.category || null,
    as_of_date: input.as_of_date,
    pv_amount: input.pv_amount,
    ev_amount: input.ev_amount,
    ac_amount: input.ac_amount,
    note: input.note ?? null,
    created_by: userData.user?.id ?? null,
  });
  if (error) throw error;
}

/** CSV 벌크 삽입(실제원가 업로드). 이미 파싱된 행 배열을 받는다. */
export async function bulkAddEvmActuals(projectId: string, rows: EvmActualInput[]): Promise<number> {
  if (!rows.length) return 0;
  const { data: userData } = await supabase.auth.getUser();
  const payload = rows.map((r) => ({
    project_id: projectId,
    category: r.category || null,
    as_of_date: r.as_of_date,
    pv_amount: r.pv_amount,
    ev_amount: r.ev_amount,
    ac_amount: r.ac_amount,
    note: r.note ?? null,
    created_by: userData.user?.id ?? null,
  }));
  const { error } = await supabase.from('evm_actual').insert(payload);
  if (error) throw error;
  return payload.length;
}

export async function deleteEvmActual(id: string): Promise<void> {
  const { error } = await supabase.from('evm_actual').delete().eq('id', id);
  if (error) throw error;
}

// ---------- EVM 지표 계산 --------------------------------------------

export interface EvmMetrics {
  bac: number; // Budget At Completion
  pv: number;
  ev: number;
  ac: number;
  cpi: number | null; // EV/AC
  spi: number | null; // EV/PV
  cv: number; // EV-AC
  sv: number; // EV-PV
  eac: number | null; // BAC/CPI
  etc: number | null; // EAC-AC
  vac: number | null; // BAC-EAC
}

/** 기준일까지 누적된 PV/EV/AC(전체 스냅샷 중 category=null 우선, 없으면 공종 합산). */
export function latestSnapshot(actuals: EvmActual[]): { pv: number; ev: number; ac: number; asOf: string | null } {
  if (!actuals.length) return { pv: 0, ev: 0, ac: 0, asOf: null };
  const dates = Array.from(new Set(actuals.map((a) => a.as_of_date))).sort();
  const asOf = dates[dates.length - 1];
  const onDate = actuals.filter((a) => a.as_of_date === asOf);
  const totals = onDate.filter((a) => a.category == null);
  const use = totals.length ? totals : onDate; // 전체행 있으면 그것, 없으면 공종행 합산
  const pv = use.reduce((s, a) => s + a.pv_amount, 0);
  const ev = use.reduce((s, a) => s + a.ev_amount, 0);
  const ac = use.reduce((s, a) => s + a.ac_amount, 0);
  return { pv, ev, ac, asOf };
}

export function computeMetrics(rates: CostRate[], actuals: EvmActual[]): EvmMetrics {
  const bac = rates.reduce((s, r) => s + rateBudget(r), 0);
  const { pv, ev, ac } = latestSnapshot(actuals);
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const eac = cpi && cpi > 0 ? bac / cpi : null;
  return {
    bac,
    pv,
    ev,
    ac,
    cpi,
    spi,
    cv: ev - ac,
    sv: ev - pv,
    eac,
    etc: eac != null ? eac - ac : null,
    vac: eac != null ? bac - eac : null,
  };
}

/** 3선 S-curve 데이터: 기준일별 누적 PV/EV/AC(전체행 우선, 없으면 공종합). */
export interface CurvePoint {
  date: string;
  PV: number;
  EV: number;
  AC: number;
}
export function buildCurve(actuals: EvmActual[]): CurvePoint[] {
  const dates = Array.from(new Set(actuals.map((a) => a.as_of_date))).sort();
  return dates.map((d) => {
    const onDate = actuals.filter((a) => a.as_of_date === d);
    const totals = onDate.filter((a) => a.category == null);
    const use = totals.length ? totals : onDate;
    return {
      date: d,
      PV: use.reduce((s, a) => s + a.pv_amount, 0),
      EV: use.reduce((s, a) => s + a.ev_amount, 0),
      AC: use.reduce((s, a) => s + a.ac_amount, 0),
    };
  });
}

/** 공종별 지표표: 최신 기준일의 공종행이 있으면 사용, 없으면 예산만. */
export interface CategoryMetric {
  category: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  cpi: number | null;
  spi: number | null;
}
export function categoryMetrics(rates: CostRate[], actuals: EvmActual[]): CategoryMetric[] {
  const dates = Array.from(new Set(actuals.map((a) => a.as_of_date))).sort();
  const asOf = dates[dates.length - 1] ?? null;
  const byCat = new Map<string, CategoryMetric>();
  for (const r of rates) {
    byCat.set(r.category, {
      category: r.category,
      bac: (byCat.get(r.category)?.bac ?? 0) + rateBudget(r),
      pv: 0,
      ev: 0,
      ac: 0,
      cpi: null,
      spi: null,
    });
  }
  if (asOf) {
    for (const a of actuals.filter((x) => x.as_of_date === asOf && x.category)) {
      const m = byCat.get(a.category!) ?? { category: a.category!, bac: 0, pv: 0, ev: 0, ac: 0, cpi: null, spi: null };
      m.pv += a.pv_amount;
      m.ev += a.ev_amount;
      m.ac += a.ac_amount;
      byCat.set(a.category!, m);
    }
  }
  return Array.from(byCat.values()).map((m) => ({
    ...m,
    cpi: m.ac > 0 ? m.ev / m.ac : null,
    spi: m.pv > 0 ? m.ev / m.pv : null,
  }));
}

// ---------- CSV 파서(실제원가 업로드, Papa Parse 경량 대체) ----------
// 헤더 기대: category, as_of_date(YYYY-MM-DD), pv, ev, ac [, note]
// 따옴표로 감싼 필드·쉼표 이스케이프 지원.

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface CsvParseResult {
  rows: EvmActualInput[];
  errors: string[];
}

export function parseEvmCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const errors: string[] = [];
  const rows: EvmActualInput[] = [];
  if (lines.length < 2) {
    errors.push('데이터 행이 없습니다(헤더 + 최소 1행 필요).');
    return { rows, errors };
  }
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iCat = idx(['category', '공종']);
  const iDate = idx(['as_of_date', 'date', '기준일']);
  const iPv = idx(['pv', 'pv_amount', '계획']);
  const iEv = idx(['ev', 'ev_amount', '획득']);
  const iAc = idx(['ac', 'ac_amount', '실제', '실제원가']);
  const iNote = idx(['note', '비고']);
  if (iDate < 0) errors.push('필수 열 as_of_date(기준일)가 없습니다.');

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const date = iDate >= 0 ? cells[iDate] : '';
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${i + 1}행: 기준일 형식 오류(YYYY-MM-DD) — 건너뜀`);
      continue;
    }
    const num = (i2: number) => (i2 >= 0 ? Number((cells[i2] || '0').replace(/[, ]/g, '')) || 0 : 0);
    rows.push({
      category: iCat >= 0 ? cells[iCat] || null : null,
      as_of_date: date,
      pv_amount: num(iPv),
      ev_amount: num(iEv),
      ac_amount: num(iAc),
      note: iNote >= 0 ? cells[iNote] || null : null,
    });
  }
  return { rows, errors };
}

// ---------- 기성내역(billing_items) 대사 -----------------------------

/** billing_items 누적 기성(전월+당월) 합. EVM 의 EV/AC 와 비교용. */
export async function billedToDate(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from('billing_items')
    .select('prev_amount, current_amount')
    .eq('project_id', projectId);
  if (error) throw error;
  return (data ?? []).reduce((s, r) => s + Number(r.prev_amount) + Number(r.current_amount), 0);
}
