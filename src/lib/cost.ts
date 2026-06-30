// =====================================================================
// 5D 원가·단가 데이터층 — S54. 공종(QTO 카테고리)별 {산출기준·단가·수동물량}을
// cost_rates(0032)에 저장/로드하고, QTO 결과(공종별/객체별 물량)와 병합해 금액을
// 산출한다. 금액은 저장하지 않고 런타임 계산(물량×단가) — 초안 단순화.
//
// 물량 소스 우선순위(설계 §0-H):
//   manual_qty(수동 입력) > 모델 산출 물량(산출기준에 해당하는 길이/면적/체적).
// 중량(ton)·개수(ea)는 모델 속성에서 자동으로 안 잡히므로 보통 수동 물량으로 채운다
// (개수는 모델 count 폴백 가능).
// =====================================================================

import { supabase } from './supabase';
import type { CategoryQty, ElementQty } from './quantities';

/** 금액 산출 기준 물량. */
export type QtyBasis = 'length' | 'area' | 'volume' | 'weight' | 'count';

/** 공종별 산출기준·단가·수동물량(cost_rates 한 행). */
export interface CostRate {
  category: string;
  qty_basis: QtyBasis;
  unit_price: number;
  /** 수동 물량(없으면 null → 모델 산출값 사용). */
  manual_qty: number | null;
  note: string | null;
}

export const QTY_BASES: QtyBasis[] = ['length', 'area', 'volume', 'weight', 'count'];

export const BASIS_LABEL: Record<QtyBasis, string> = {
  length: '길이',
  area: '면적',
  volume: '체적',
  weight: '중량',
  count: '개수',
};

export const BASIS_UNIT: Record<QtyBasis, string> = {
  length: 'm',
  area: 'm²',
  volume: 'm³',
  weight: 'ton',
  count: 'ea',
};

// ---------------------------------------------------------------------
// 산출기준 자동 추정 — 공종(카테고리) 이름의 키워드로 기본 산출기준을 고른다.
// 사용자가 드롭다운에서 언제든 바꿀 수 있으며(저장됨), 추정 실패 시 체적 기본.
// ---------------------------------------------------------------------
const BASIS_HINTS: { basis: QtyBasis; keys: string[] }[] = [
  // 길이 — 말뚝·파일·보·거더·배관·전선·레일 등 선형 부재.
  { basis: 'length', keys: ['pile', '말뚝', 'beam', '보', 'girder', '거더', 'pipe', '배관', 'duct', 'cable', '전선', 'rail', '레일', 'rebar', '철근'] },
  // 면적 — 거푸집·슬래브·벽·바닥·마감·도장·방수 등 면 부재.
  { basis: 'area', keys: ['formwork', '거푸집', 'slab', '슬래브', 'wall', '벽', 'floor', '바닥', 'roof', '지붕', 'finish', '마감', 'paint', '도장', 'waterproof', '방수', 'pavement', '포장', 'plate', '판'] },
  // 체적 — 기초·기둥·콘크리트·토공·되메우기 등 부피 부재.
  { basis: 'volume', keys: ['foundation', '기초', 'footing', 'column', '기둥', 'concrete', '콘크리트', 'earthwork', '토공', '터파기', 'excavat', 'backfill', '되메우기', 'fill', '성토', 'pier', '교각'] },
  // 개수 — 창호·문·설비·조명·장비 등 셀 수 있는 부재.
  { basis: 'count', keys: ['door', '문', 'window', '창', 'fixture', '설비', 'light', '조명', 'equipment', '장비', 'fitting', 'furniture', '가구'] },
];

/** 공종 이름에서 산출기준을 추정(없으면 체적). */
export function defaultQtyBasis(category: string): QtyBasis {
  const c = (category ?? '').toLowerCase();
  for (const { basis, keys } of BASIS_HINTS) {
    if (keys.some((k) => c.includes(k))) return basis;
  }
  return 'volume';
}

/** 모델 산출 물량에서 산출기준에 해당하는 값을 고른다. 중량은 모델에 없어 0(수동). */
export function modelQtyForBasis(cat: CategoryQty | undefined, basis: QtyBasis): number {
  if (!cat) return 0;
  switch (basis) {
    case 'length':
      return cat.length;
    case 'area':
      return cat.area;
    case 'volume':
      return cat.volume;
    case 'count':
      return cat.count;
    case 'weight':
      return 0; // 모델 속성엔 중량이 없음 → 수동 물량으로 채운다.
  }
}

/** 한 객체(ElementQty)에서 산출기준에 해당하는 물량. 가중분배용. */
export function objectQtyForBasis(row: ElementQty, basis: QtyBasis): number {
  switch (basis) {
    case 'length':
      return row.length;
    case 'area':
      return row.area;
    case 'volume':
      return row.volume;
    case 'count':
      return 1; // 객체 1개
    case 'weight':
      return 0;
  }
}

/** 적용 물량(수동 우선) + 출처. manual_qty 가 있으면 그것을, 없으면 모델 산출값. */
export function effectiveQty(
  rate: Pick<CostRate, 'qty_basis' | 'manual_qty'>,
  cat: CategoryQty | undefined,
): { qty: number; source: 'manual' | 'model' | 'none' } {
  if (rate.manual_qty != null && Number.isFinite(rate.manual_qty)) {
    return { qty: rate.manual_qty, source: 'manual' };
  }
  const m = modelQtyForBasis(cat, rate.qty_basis);
  if (m > 0) return { qty: m, source: 'model' };
  return { qty: 0, source: 'none' };
}

/** 공종 금액 = 적용 물량 × 단가. */
export function categoryAmount(qty: number, unitPrice: number): number {
  return qty * (Number.isFinite(unitPrice) ? unitPrice : 0);
}

// ---------------------------------------------------------------------
// 객체별 금액 분배 — 공종 금액을 그 공종의 객체들에 나눠준다(4D 기성 결합용).
//   · 모델 물량이 잡히는 공종: 객체 산출기준 물량 비율로 가중 분배.
//   · 수동 물량(토공 등) 또는 산출기준 물량이 0인 공종: 객체 수로 균등 분배.
// 합은 공종 금액과 같다(부동소수 오차 제외). 객체가 없으면 빈 맵.
// ---------------------------------------------------------------------
export function distributeAmount(
  rows: ElementQty[],
  basis: QtyBasis,
  amount: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (rows.length === 0 || amount === 0) {
    for (const r of rows) out.set(r.expressID, 0);
    return out;
  }
  const weights = rows.map((r) => objectQtyForBasis(r, basis));
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW > 0) {
    rows.forEach((r, i) => out.set(r.expressID, amount * (weights[i] / totalW)));
  } else {
    const each = amount / rows.length; // 균등 분배(수동 물량·산출기준 0)
    for (const r of rows) out.set(r.expressID, each);
  }
  return out;
}

// ---------------------------------------------------------------------
// Supabase 영속화 (cost_rates, 0032). 프로젝트 단위.
// ---------------------------------------------------------------------

/** 프로젝트의 공종별 단가/산출기준/수동물량을 모두 불러온다. */
export async function loadCostRates(projectId: string): Promise<CostRate[]> {
  const { data, error } = await supabase
    .from('cost_rates')
    .select('category, qty_basis, unit_price, manual_qty, note')
    .eq('project_id', projectId);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    category: r.category as string,
    qty_basis: (r.qty_basis as QtyBasis) ?? 'volume',
    unit_price: Number(r.unit_price) || 0,
    manual_qty: r.manual_qty == null ? null : Number(r.manual_qty),
    note: (r.note as string) ?? null,
  }));
}

/** 공종 단가/산출기준/수동물량을 일괄 upsert(PK = project_id+category). */
export async function saveCostRates(projectId: string, rates: CostRate[]): Promise<void> {
  if (rates.length === 0) return;
  const { data: userData } = await supabase.auth.getUser();
  const now = new Date().toISOString();
  const rows = rates.map((r) => ({
    project_id: projectId,
    category: r.category,
    qty_basis: r.qty_basis,
    unit_price: r.unit_price,
    manual_qty: r.manual_qty,
    note: r.note,
    updated_by: userData.user?.id ?? null,
    updated_at: now,
  }));
  const { error } = await supabase
    .from('cost_rates')
    .upsert(rows, { onConflict: 'project_id,category' });
  if (error) throw error;
}
