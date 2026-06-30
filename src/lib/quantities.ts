import type { ElementMeta, IfcViewer } from '../viewer/IfcViewer';

/**
 * 5D 물량 산출(QTO) 데이터층. 뷰어에 로드된 모델을 순회하며 요소별 물량을 모아
 * 카테고리(IFC 타입)별로 집계한다. 물량 소스 우선순위(설계 §12 / DECISIONS):
 *   ① IFC IfcElementQuantity(BaseQuantities) → ② 메시 기반 근사(체적·면적·bbox)
 *   → ③ 개수는 항상.
 * 길이단위(mm/m)는 모델마다 다르므로 IfcUnitAssignment 에서 읽어 m·m²·m³ 로
 * 정규화한다(자동 추정 실패 시 수동 토글 폴백). 계산은 전부 클라이언트.
 */

/** 단위 정규화 모드: auto=IFC 단위 자동 감지, m/mm=수동 강제. */
export type QtyUnitMode = 'auto' | 'm' | 'mm';

/** 한 요소의 물량(미터 정규화 후). */
export interface ElementQty {
  modelID: number;
  expressID: number;
  category: string;
  name: string;
  length: number; // m
  area: number; // m²
  volume: number; // m³
  source: 'ifc' | 'mesh' | 'count';
}

/** 카테고리(공종)별 물량 집계. */
export interface CategoryQty {
  category: string;
  count: number;
  length: number; // m
  area: number; // m²
  volume: number; // m³
  /** 물량 소스 내역(투명성): IFC 수량셋 vs 메시근사 vs 개수만. */
  ifcCount: number;
  meshCount: number;
  countOnly: number;
}

export interface QtyResult {
  rows: ElementQty[];
  categories: CategoryQty[];
  total: CategoryQty;
  /** 모델별 적용된 미터 환산 계수(진단·UI 표기용). */
  modelScale: { modelID: number; label: string; scale: number; detected: boolean }[];
}

/** 진행 콜백(대형 모델에서 UI 프리징 방지를 위해 청크 단위로 호출). */
export type QtyProgress = (ratio: number) => void;

/** 메인스레드 청크 사이에 한 프레임 양보(ClashPanel 패턴과 동일). */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 선택 집합(items)의 물량을 산출한다. items 는 보통 ClashPanel 과 같은
 * (모델→카테고리) 2단계 선택으로 필터링된 요소 목록.
 */
export async function computeQuantities(
  viewer: IfcViewer,
  items: ElementMeta[],
  unitMode: QtyUnitMode,
  onProgress?: QtyProgress,
): Promise<QtyResult> {
  // 모델별 미터 환산 계수.
  const scaleByModel = new Map<number, { scale: number; detected: boolean }>();
  const resolveScale = (modelID: number) => {
    let s = scaleByModel.get(modelID);
    if (!s) {
      const detected = viewer.getLengthUnitToMeters(modelID);
      if (unitMode === 'm') s = { scale: 1, detected: false };
      else if (unitMode === 'mm') s = { scale: 0.001, detected: false };
      else s = detected != null ? { scale: detected, detected: true } : { scale: 1, detected: false };
      scaleByModel.set(modelID, s);
    }
    return s.scale;
  };

  const rows: ElementQty[] = [];
  const CHUNK = 400;
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const s = resolveScale(e.modelID);
    let length = 0;
    let area = 0;
    let volume = 0;
    let source: ElementQty['source'] = 'count';

    const ifc = viewer.getElementBaseQuantities(e.modelID, e.expressID);
    if (ifc && (ifc.length > 0 || ifc.area > 0 || ifc.volume > 0)) {
      length = ifc.length * s;
      area = ifc.area * s * s;
      volume = ifc.volume * s * s * s;
      source = 'ifc';
    } else {
      const mq = viewer.getMeshQuantities(e.modelID, e.expressID);
      if (mq) {
        volume = mq.volume * s * s * s;
        area = mq.area * s * s;
        // 선형 요소(보·배관 등) 근사: bbox 최장변을 길이로(근사값).
        length = Math.max(mq.bbox.x, mq.bbox.y, mq.bbox.z) * s;
        source = 'mesh';
      }
    }
    rows.push({ modelID: e.modelID, expressID: e.expressID, category: e.category, name: e.name, length, area, volume, source });

    if (i % CHUNK === CHUNK - 1) {
      onProgress?.((i + 1) / items.length);
      await yieldToUi();
    }
  }
  onProgress?.(1);

  const categories = aggregateByCategory(rows);
  const total = sumCategories(categories);

  const models = viewer.getLoadedModels();
  const modelScale = [...scaleByModel.entries()].map(([modelID, s]) => ({
    modelID,
    label: models.find((m) => m.modelID === modelID)?.label ?? `모델 ${modelID}`,
    scale: s.scale,
    detected: s.detected,
  }));

  return { rows, categories, total, modelScale };
}

/** 요소 물량을 카테고리별로 합산(개수 내림차순). */
export function aggregateByCategory(rows: ElementQty[]): CategoryQty[] {
  const map = new Map<string, CategoryQty>();
  for (const r of rows) {
    let c = map.get(r.category);
    if (!c) {
      c = { category: r.category, count: 0, length: 0, area: 0, volume: 0, ifcCount: 0, meshCount: 0, countOnly: 0 };
      map.set(r.category, c);
    }
    c.count += 1;
    c.length += r.length;
    c.area += r.area;
    c.volume += r.volume;
    if (r.source === 'ifc') c.ifcCount += 1;
    else if (r.source === 'mesh') c.meshCount += 1;
    else c.countOnly += 1;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function sumCategories(cats: CategoryQty[]): CategoryQty {
  return cats.reduce(
    (a, c) => {
      a.count += c.count;
      a.length += c.length;
      a.area += c.area;
      a.volume += c.volume;
      a.ifcCount += c.ifcCount;
      a.meshCount += c.meshCount;
      a.countOnly += c.countOnly;
      return a;
    },
    { category: '합계', count: 0, length: 0, area: 0, volume: 0, ifcCount: 0, meshCount: 0, countOnly: 0 },
  );
}

/** 표시용 숫자 포맷(소수 자릿수 고정, 천단위 콤마). */
export function fmtQty(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 카테고리별 물량 표 → CSV(엑셀 한글 호환 BOM 포함). */
export function quantitiesToCsv(cats: CategoryQty[], total: CategoryQty): string {
  const head = ['공종(카테고리)', '개수', '길이(m)', '면적(m2)', '체적(m3)', 'IFC수량', '메시근사', '개수만'];
  const line = (c: CategoryQty) =>
    [
      `"${c.category.replace(/"/g, '""')}"`,
      c.count,
      c.length.toFixed(3),
      c.area.toFixed(3),
      c.volume.toFixed(3),
      c.ifcCount,
      c.meshCount,
      c.countOnly,
    ].join(',');
  const body = cats.map(line).join('\n');
  return '﻿' + [head.join(','), body, line({ ...total, category: '합계' })].join('\n');
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
