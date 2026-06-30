// =====================================================================
// APS(ACC) 물량 산출(QTO) 데이터층 — S51/S54. 옛 web-ifc 경로(quantities.ts)는
// 뷰어에 로드된 IFC 요소에서 IfcElementQuantity/메시를 읽었다. APS Viewer 에는
// web-ifc 가 없으므로 **APS 속성 DB**(getBulkProperties2)에서 수량을 추출한다.
//
// ⚠️ 통합 NWD(나비스웍스) 안의 Revit 객체는 수량 속성명이 모델마다 제각각이다:
//   · 영문 Revit/IFC: Volume·Area·Length·Perimeter, NetVolume, Qto_*…
//   · 한글 Revit(국내): 체적·면적·길이·둘레·순체적·총면적…
//   · 값이 숫자가 아니라 "12.5 ㎥" 처럼 단위 포함 **문자열**로 오는 경우가 많다.
// 그래서 고정 영문 이름 + 정확매칭 + propFilter 만으로는 전부 "미산출"이 된다.
//
// 해결(S54): ① **속성명 자동 발견**(샘플 요소에서 수량처럼 보이는 속성명을 이름·단위로
// 찾아냄, 한글/영문 무관) → ② 그 이름들로만 일괄 조회(propFilter, 효율) → ③ 각 속성을
// 이름·단위로 분류하고 값/단위를 문자열에서도 파싱. 단위는 ㎥/㎡/㎜·미터 등 한글 단위와
// m^3/m3/sqm 표기까지 m³/m²/m 로 정규화. 무엇이 발견됐는지 진단(QtyDiagnostics)으로 노출.
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
type Axis = 'volume' | 'area' | 'length';

/** 한 요소에서 추출한 원시 수량(정규화 전, 단위 문자열 보존). */
export interface ApsRawQty {
  dbId: number;
  category: string;
  name: string;
  volume: { value: number; units: string } | null;
  area: { value: number; units: string } | null;
  length: { value: number; units: string } | null;
}

export interface ApsQtyResult {
  rows: ElementQty[];
  categories: CategoryQty[];
  total: CategoryQty;
  measured: number;
  unitUnknown: number;
}

/** 물량 산출 진단 — 어떤 속성을 수량으로 인식했는지/샘플 속성 목록. */
export interface QtyDiagnostics {
  /** 인식한 수량 속성명(축별, 표시용). */
  volumeNames: string[];
  areaNames: string[];
  lengthNames: string[];
  /** 샘플에서 본 수치형 속성 상위 목록(이름·예시값·단위·빈도) — 무엇이 있는지 진단. */
  samples: { name: string; value: string; units: string; count: number; axis: Axis | '' }[];
  /** 샘플한 요소 수. */
  sampled: number;
}

type ApsProp = { displayName?: string; attributeName?: string; displayValue?: unknown; units?: string | null };

// --- 이름 키워드(정규화 후 includes 매칭). 한글·영문 동시. --------------
const NAME_KEYS: Record<Axis, string[]> = {
  volume: ['netvolume', 'grossvolume', 'volume', '체적', '부피', '순체적', '총체적', '입방', '세제곱미터', '콘크리트량', '물량'],
  area: ['netarea', 'grossarea', 'surfacearea', 'crosssection', 'sectionarea', 'area', '면적', '순면적', '총면적', '단면적', '평면적', '도장면적', '거푸집'],
  length: ['netlength', 'grosslength', 'perimeter', 'length', '길이', '순길이', '연장', '둘레', '주장'],
};

// 발견/매칭 보강용 영문 폴백 이름(샘플에 안 잡혀도 시도).
const FALLBACK_NAMES = [
  'Volume', 'NetVolume', 'GrossVolume', 'Net Volume', 'Gross Volume',
  'Area', 'NetArea', 'GrossArea', 'Surface Area', 'CrossSectionArea',
  'Length', 'NetLength', 'Perimeter',
  '체적', '면적', '길이', '둘레', '순체적', '총체적', '순면적', '총면적', '단면적', '연장',
];

const normName = (s: string): string => (s ?? '').toLowerCase().replace(/[\s_()[\]<>:./-]+/g, '');

/** 이름으로 수량 축을 추정(없으면 null). 우선순위 volume>area>length(겹침 시). */
function axisByName(name: string): Axis | null {
  const n = normName(name);
  if (!n) return null;
  if (NAME_KEYS.volume.some((k) => n.includes(normName(k)))) return 'volume';
  if (NAME_KEYS.area.some((k) => n.includes(normName(k)))) return 'area';
  if (NAME_KEYS.length.some((k) => n.includes(normName(k)))) return 'length';
  return null;
}

/** 단위 문자열로 수량 축을 추정(㎥/㎡/m 등). 길이/면적/체적 단위 구분. */
function axisByUnits(units: string): Axis | null {
  const u = (units ?? '').toLowerCase();
  if (!u) return null;
  if (/㎥|㎤|㎦|m\^?3\b|m3\b|cubic|입방|세제곱|cu\.?\s*(m|ft|in)|ft\^?3|in\^?3/.test(u)) return 'volume';
  if (/㎡|㎠|㎢|m\^?2\b|m2\b|square|sq\.?\s*(m|ft|in)|평방|제곱|ft\^?2|in\^?2/.test(u)) return 'area';
  if (/㎜|㎝|㎞|\bmm\b|\bcm\b|\bkm\b|\bm\b|\bft\b|\bin\b|millimet|centimet|met(er|re)|밀리|센티|미터|길이/.test(u)) return 'length';
  return null;
}

/** "12,345.6 ㎥" / "12.5" / 12.5 → {value, units}. 숫자 없으면 null. */
function parseNumeric(displayValue: unknown, unitsField?: string | null): { value: number; units: string } | null {
  let units = (unitsField ?? '').trim();
  if (typeof displayValue === 'number') {
    return Number.isFinite(displayValue) ? { value: displayValue, units } : null;
  }
  const s = String(displayValue ?? '').trim();
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const value = Number(m[0]);
  if (!Number.isFinite(value)) return null;
  if (!units) {
    const rest = s.replace(/,/g, '').replace(m[0], '').trim();
    if (rest) units = rest;
  }
  return { value, units };
}

/** 한 속성을 (축, 우선순위 점수, 값, 단위)로 분류. 수량 아님이면 null. */
function classifyProp(p: ApsProp): { axis: Axis; score: number; value: number; units: string } | null {
  const name = p.displayName ?? p.attributeName ?? '';
  const parsed = parseNumeric(p.displayValue, p.units);
  if (!parsed || parsed.value <= 0) return null;
  let axis = axisByName(name);
  let score: number;
  if (axis) {
    const n = normName(name);
    // Net/순 우선 > Gross/총 > 기본.
    score = /net|^순|순체적|순면적|순길이/.test(n) ? 3 : /gross|^총|총체적|총면적/.test(n) ? 2 : 1;
  } else {
    // 이름으로 못 잡으면 단위로 추정(낮은 점수).
    axis = axisByUnits(parsed.units);
    if (!axis) return null;
    score = 0.5;
  }
  return { axis, score, value: parsed.value, units: parsed.units };
}

/**
 * 단위 문자열 → 미터 환산 선형 계수(예: mm→0.001, ft→0.3048, m→1). 면적/체적은
 * 같은 선형 계수를 제곱/세제곱해 적용한다. 한글·전각 단위(㎥/㎡/㎜·미터…)와
 * m^3/m3/sqm 표기까지 흡수한다. 인식 불가/빈 문자열이면 null(→ 미산출).
 */
export function linearMeterScale(units: string): number | null {
  let u = (units ?? '').trim().toLowerCase();
  if (!u) return null;
  // 전각/한글 단위 → ascii 선형 단위(차원 표기는 떼고 선형만 남긴다).
  u = u
    .replace(/㎜|㎟/g, 'mm')
    .replace(/㎝|㎠|㎤/g, 'cm')
    .replace(/㎞|㎢/g, 'km')
    .replace(/㎡|㎥|㎦/g, 'm')
    .replace(/밀리미터|밀리/g, 'mm')
    .replace(/센티미터/g, 'cm')
    .replace(/킬로미터/g, 'km')
    .replace(/미터|미타|미톤/g, 'm')
    .replace(/제곱|세제곱|입방|평방/g, '');
  // square/cubic 단어와 지수 표기(^2, ^3, ², ³, 끝의 2/3)를 떼어 선형 단위만 남긴다.
  const base = u
    .replace(/square|sq\.?|cubic|cu\.?/g, '')
    .replace(/\^?[23]\b/g, '')
    .replace(/[²³]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (/^(mm|millimet(er|re)s?)$/.test(base)) return 0.001;
  if (/^(cm|centimet(er|re)s?)$/.test(base)) return 0.01;
  if (/^(km|kilomet(er|re)s?)$/.test(base)) return 1000;
  if (/^(m|met(er|re)s?)$/.test(base)) return 1;
  if (/^(ft|foot|feet|')$/.test(base)) return 0.3048;
  if (/^(in|inch|inches|")$/.test(base)) return 0.0254;
  if (/^(yd|yards?)$/.test(base)) return 0.9144;
  return null;
}

/** dbId 묶음의 속성을 일괄 조회. propFilter 가 있으면 그것만, 없으면 전체 속성. */
function bulkProps(
  model: ApsModel,
  dbIds: number[],
  propFilter?: string[],
): Promise<Array<{ dbId: number; properties?: ApsProp[] }>> {
  return new Promise((resolve) => {
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve([]);
      return;
    }
    const opts: any = { ignoreHidden: false };
    if (propFilter && propFilter.length) opts.propFilter = propFilter;
    model.getBulkProperties2(
      dbIds,
      opts,
      (results: Array<{ dbId: number; properties?: ApsProp[] }>) => resolve(results ?? []),
      () => resolve([]),
    );
  });
}

/** 진행 콜백(대형 모델 청크 단위). */
export type QtyProgress = (ratio: number) => void;

/**
 * 샘플 요소에서 수량 속성을 자동 발견한다. propFilter 없이 전체 속성을 읽어 이름·단위로
 * 수량처럼 보이는 속성을 추려 축별 이름 목록과 진단 샘플을 만든다. 효율을 위해 요소를
 * 고르게 샘플링(기본 최대 600개)한다.
 */
export async function discoverQtyProps(
  model: ApsModel,
  elements: ApsElement[],
  sampleSize = 600,
): Promise<QtyDiagnostics> {
  const ids = elements.map((e) => e.dbId);
  const step = Math.max(1, Math.floor(ids.length / sampleSize));
  const sample: number[] = [];
  for (let i = 0; i < ids.length && sample.length < sampleSize; i += step) sample.push(ids[i]);

  const results = await bulkProps(model, sample); // 전체 속성(propFilter 없음)
  // 이름별 집계: 축·빈도·예시값.
  const agg = new Map<string, { axis: Axis | ''; score: number; count: number; value: string; units: string }>();
  for (const r of results) {
    for (const p of r.properties ?? []) {
      const name = (p.displayName ?? p.attributeName ?? '').trim();
      if (!name) continue;
      const cls = classifyProp(p);
      if (!cls) continue; // 수량 아님(비수치·0·축 미상)
      const prev = agg.get(name);
      if (prev) {
        prev.count++;
      } else {
        agg.set(name, {
          axis: cls.axis,
          score: cls.score,
          count: 1,
          value: String(p.displayValue ?? cls.value),
          units: cls.units,
        });
      }
    }
  }
  const byAxis = (axis: Axis): string[] =>
    [...agg.entries()]
      .filter(([, v]) => v.axis === axis)
      .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count)
      .map(([name]) => name);

  const samples = [...agg.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 60)
    .map(([name, v]) => ({ name, value: v.value, units: v.units, count: v.count, axis: v.axis }));

  return {
    volumeNames: byAxis('volume'),
    areaNames: byAxis('area'),
    lengthNames: byAxis('length'),
    samples,
    sampled: sample.length,
  };
}

/** 한 요소의 속성에서 축별 최고점 후보를 골라 원시 수량으로. */
function pickRaw(props: ApsProp[]): Pick<ApsRawQty, 'volume' | 'area' | 'length'> {
  const best: Record<Axis, { value: number; units: string; score: number } | null> = {
    volume: null,
    area: null,
    length: null,
  };
  for (const p of props) {
    const cls = classifyProp(p);
    if (!cls) continue;
    const cur = best[cls.axis];
    if (!cur || cls.score > cur.score) best[cls.axis] = { value: cls.value, units: cls.units, score: cls.score };
  }
  return {
    volume: best.volume ? { value: best.volume.value, units: best.volume.units } : null,
    area: best.area ? { value: best.area.value, units: best.area.units } : null,
    length: best.length ? { value: best.length.value, units: best.length.units } : null,
  };
}

/**
 * 모델 요소(elements)에서 원시 수량을 추출한다. 먼저 속성명을 자동 발견(discoverQtyProps)
 * 하고, 발견된 이름 + 영문 폴백으로 propFilter 를 만들어 일괄 조회 후 이름·단위로 분류한다.
 * 단위 정규화/집계는 normalizeApsQuantities 가 한다. 진단(diag)도 함께 반환한다.
 */
export async function computeApsQuantities(
  model: ApsModel,
  elements: ApsElement[],
  onProgress?: QtyProgress,
): Promise<{ raw: ApsRawQty[]; diag: QtyDiagnostics }> {
  const metaById = new Map(elements.map((e) => [e.dbId, e] as const));
  const dbIds = elements.map((e) => e.dbId);

  // 1) 속성명 자동 발견.
  const diag = await discoverQtyProps(model, elements).catch(
    () => ({ volumeNames: [], areaNames: [], lengthNames: [], samples: [], sampled: 0 }) as QtyDiagnostics,
  );
  // 2) propFilter = 발견된 이름 + 영문/한글 폴백(중복 제거). 비면 폴백만.
  const filter = [
    ...new Set([...diag.volumeNames, ...diag.areaNames, ...diag.lengthNames, ...FALLBACK_NAMES]),
  ];

  const out: ApsRawQty[] = [];
  const CHUNK = 2000;
  for (let i = 0; i < dbIds.length; i += CHUNK) {
    const slice = dbIds.slice(i, i + CHUNK);
    const results = await bulkProps(model, slice, filter);
    const propsById = new Map(results.map((r) => [r.dbId, r.properties ?? []] as const));
    for (const dbId of slice) {
      const meta = metaById.get(dbId);
      if (!meta) continue;
      const picked = pickRaw(propsById.get(dbId) ?? []);
      out.push({ dbId, category: meta.category, name: meta.name, ...picked });
    }
    onProgress?.(Math.min(1, (i + CHUNK) / Math.max(1, dbIds.length)));
  }
  onProgress?.(1);
  return { raw: out, diag };
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
