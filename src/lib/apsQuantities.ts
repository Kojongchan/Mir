// =====================================================================
// APS(ACC) 물량 산출(QTO) 데이터층 — S51. 옛 web-ifc 경로(quantities.ts)는
// 뷰어에 로드된 IFC 요소에서 IfcElementQuantity/메시를 읽었다. APS Viewer 에는
// web-ifc 가 없으므로 **APS 속성 DB**(getBulkProperties2)에서 수량을 추출한다.
//
//   · IFC 유래 모델(ACC 변환): BaseQuantities/Qto_* 의 Net/Gross Volume·Area·Length
//   · Revit 유래 모델: Volume/Area/Length(또는 면적/체적 파라미터)
//
// 각 속성의 displayValue + units 를 읽어 m³/m²/m 로 정규화한다(mm/cm/ft 혼재 주의).
// 단위 미상이면 폴백 정책(§0-F): 개수는 항상, 체적/면적/길이는 "미산출"로 둔다.
//
// 집계/CSV/포맷은 quantities.ts 의 공통 로직(aggregateByCategory·sumCategories·
// quantitiesToCsv·fmtQty)을 그대로 재사용한다 — 데이터 소스(요소→수량) 추출부만
// APS 용으로 교체. ElementQty 의 expressID 슬롯에 APS dbId 를 담는다(S49 관례).
// =====================================================================

import type { ApsElement } from './apsElements';
import {
  aggregateByCategory,
  sumCategories,
  type CategoryQty,
  type ElementQty,
  type QtyUnitMode,
} from './quantities';

type ApsModel = any;

/** 한 요소에서 추출한 원시 수량(정규화 전, 단위 문자열 보존). 단위 토글 시 재질의 없이
 *  재정규화하기 위해 raw 값+단위를 그대로 들고 있는다. */
export interface ApsRawQty {
  dbId: number;
  category: string;
  name: string;
  /** 값 + 속성에 표기된 단위(예: 'm^3', 'mm^3', 'cubicFeet'). 없으면 null. */
  volume: { value: number; units: string } | null;
  area: { value: number; units: string } | null;
  length: { value: number; units: string } | null;
}

export interface ApsQtyResult {
  rows: ElementQty[];
  categories: CategoryQty[];
  total: CategoryQty;
  /** 수량(체적/면적/길이) 중 하나라도 정규화에 성공한 요소 수. */
  measured: number;
  /** 값은 있으나 단위 미상으로 "미산출" 처리된 요소 수. */
  unitUnknown: number;
}

// 속성명 후보(우선순위). Net(실측 물량) > Gross > 기본. IFC BaseQuantities/Qto_* 와
// Revit 파라미터 양쪽 명명을 함께 둔다. getBulkProperties2 propFilter 로 이 이름들만
// 받아 페이로드를 줄인다.
const VOLUME_NAMES = ['NetVolume', 'Net Volume', 'GrossVolume', 'Gross Volume', 'Volume'];
const AREA_NAMES = [
  'NetArea', 'Net Area', 'NetSideArea', 'NetFloorArea', 'NetSurfaceArea',
  'GrossArea', 'Gross Area', 'GrossSideArea', 'GrossFloorArea', 'GrossSurfaceArea',
  'Area', 'CrossSectionArea',
];
const LENGTH_NAMES = ['Length', 'NetLength', 'GrossLength', 'Perimeter'];
const QTY_PROP_NAMES = [...VOLUME_NAMES, ...AREA_NAMES, ...LENGTH_NAMES];

type ApsProp = { displayName?: string; displayValue?: unknown; units?: string | null };

/** 우선순위 이름 목록을 따라 첫 번째 유효(양수) 수량 속성을 찾는다. */
function pickQty(props: ApsProp[], names: string[]): { value: number; units: string } | null {
  for (const name of names) {
    const p = props.find((q) => q.displayName === name);
    if (!p) continue;
    const v = typeof p.displayValue === 'number' ? p.displayValue : Number(p.displayValue);
    if (Number.isFinite(v) && v > 0) return { value: v, units: (p.units ?? '').trim() };
  }
  return null;
}

/**
 * 단위 문자열 → 미터 환산 선형 계수(예: mm→0.001, ft→0.3048, m→1). 면적/체적은
 * 같은 선형 계수를 제곱/세제곱해 적용한다. 인식 불가/빈 문자열이면 null(→ 미산출).
 */
export function linearMeterScale(units: string): number | null {
  const u = (units ?? '').trim().toLowerCase();
  if (!u) return null;
  // square/cubic 단어와 지수 표기(^2, ^3, ², ³, 끝의 2/3)를 떼어 선형 단위만 남긴다.
  const base = u
    .replace(/square|sq\.?|cubic|cu\.?/g, '')
    .replace(/\^?[23]\b/g, '')
    .replace(/[²³]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (/^(mm|millimet(er|re)s?)$/.test(base)) return 0.001;
  if (/^(cm|centimet(er|re)s?)$/.test(base)) return 0.01;
  if (/^(m|met(er|re)s?)$/.test(base)) return 1;
  if (/^(ft|foot|feet|')$/.test(base)) return 0.3048;
  if (/^(in|inch|inches|")$/.test(base)) return 0.0254;
  if (/^(yd|yards?)$/.test(base)) return 0.9144;
  return null;
}

/** dbId 묶음의 수량 속성을 일괄 조회(getBulkProperties2). 결과 없으면 빈 배열. */
function bulkQtyProps(
  model: ApsModel,
  dbIds: number[],
): Promise<Array<{ dbId: number; properties?: ApsProp[] }>> {
  return new Promise((resolve) => {
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve([]);
      return;
    }
    model.getBulkProperties2(
      dbIds,
      { propFilter: QTY_PROP_NAMES },
      (results: Array<{ dbId: number; properties?: ApsProp[] }>) => resolve(results ?? []),
      () => resolve([]),
    );
  });
}

/** 진행 콜백(대형 모델 청크 단위). */
export type QtyProgress = (ratio: number) => void;

/**
 * 모델의 요소(elements)에서 원시 수량을 추출한다. 단위 정규화/집계는 하지 않고
 * raw 값+단위만 모은다(단위 토글 시 재질의 없이 재정규화하기 위함).
 */
export async function computeApsQuantities(
  model: ApsModel,
  elements: ApsElement[],
  onProgress?: QtyProgress,
): Promise<ApsRawQty[]> {
  const metaById = new Map(elements.map((e) => [e.dbId, e] as const));
  const dbIds = elements.map((e) => e.dbId);
  const out: ApsRawQty[] = [];
  const CHUNK = 2000;
  for (let i = 0; i < dbIds.length; i += CHUNK) {
    const slice = dbIds.slice(i, i + CHUNK);
    const results = await bulkQtyProps(model, slice);
    const propsById = new Map(results.map((r) => [r.dbId, r.properties ?? []] as const));
    for (const dbId of slice) {
      const meta = metaById.get(dbId);
      if (!meta) continue;
      const props = propsById.get(dbId) ?? [];
      out.push({
        dbId,
        category: meta.category,
        name: meta.name,
        volume: pickQty(props, VOLUME_NAMES),
        area: pickQty(props, AREA_NAMES),
        length: pickQty(props, LENGTH_NAMES),
      });
    }
    onProgress?.(Math.min(1, (i + CHUNK) / Math.max(1, dbIds.length)));
  }
  onProgress?.(1);
  return out;
}

/**
 * 원시 수량을 단위 정규화해 카테고리별로 집계한다. unitMode='auto' 면 속성 단위를
 * 따르고(미상 시 미산출), 'm'/'mm' 면 단위를 무시하고 선형 계수를 강제한다(단위가
 * 비거나 틀린 모델용 폴백). 집계는 quantities.ts 의 공통 로직을 그대로 태운다.
 */
export function normalizeApsQuantities(raw: ApsRawQty[], unitMode: QtyUnitMode): ApsQtyResult {
  const forced = unitMode === 'm' ? 1 : unitMode === 'mm' ? 0.001 : null;
  const rows: ElementQty[] = [];
  let measured = 0;
  let unitUnknown = 0;

  for (const r of raw) {
    let length = 0;
    let area = 0;
    let volume = 0;
    let ok = false;
    let unknown = false;
    const conv = (q: { value: number; units: string } | null, exp: number): number => {
      if (!q) return 0;
      const s = forced != null ? forced : linearMeterScale(q.units);
      if (s == null) {
        unknown = true;
        return 0;
      }
      ok = true;
      return q.value * s ** exp;
    };
    volume = conv(r.volume, 3);
    area = conv(r.area, 2);
    length = conv(r.length, 1);

    if (ok) measured++;
    else if (unknown) unitUnknown++;
    rows.push({
      modelID: 0,
      expressID: r.dbId, // S49 관례: expressID 슬롯에 APS dbId.
      category: r.category,
      name: r.name,
      length,
      area,
      volume,
      source: ok ? 'ifc' : 'count',
    });
  }

  const categories = aggregateByCategory(rows);
  const total = sumCategories(categories);
  return { rows, categories, total, measured, unitUnknown };
}
