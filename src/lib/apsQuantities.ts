// =====================================================================
// APS(ACC) 물량 산출 — QTO 를 web-ifc 에서 APS 뷰어로 이전(옵션 A).
// getBulkProperties2 로 요소별 수량 속성(Volume/Area/Length)을 읽어 미터법으로
// 정규화하고 카테고리(공종)별로 집계한다. IFC BaseQuantities 대신 APS 속성 사용.
// 속성이 없으면 개수(count)만 집계(투명하게 소스 내역을 함께 제공).
// =====================================================================

import type { ApsElement } from './apsElements';

type ApsModel = any;

export interface ApsCategoryQty {
  category: string;
  count: number;
  volume: number; // m³
  area: number; // m²
  length: number; // m
  volCount: number; // 체적 값이 있던 요소 수
  areaCount: number;
  lenCount: number;
}

export interface ApsQtyResult {
  categories: ApsCategoryQty[];
  total: ApsCategoryQty;
}

// 수량 속성 후보(표시명, 소문자 비교). Revit/IFC 파생 명칭 다양성 대응.
const VOL_NAMES = ['volume', 'gross volume', 'net volume', '체적', '부피'];
const AREA_NAMES = ['area', 'gross area', 'net area', 'surface area', '면적'];
const LEN_NAMES = ['length', 'cut length', '길이'];

const ALL_CANDIDATES = [
  'Volume', 'Gross Volume', 'Net Volume',
  'Area', 'Gross Area', 'Net Area', 'Surface Area',
  'Length', 'Cut Length',
  '체적', '부피', '면적', '길이',
];

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** 단위 문자열을 보고 체적을 m³ 로 정규화. */
function volumeToM3(value: number, units: string): number {
  const u = units.toLowerCase();
  if (u.includes('ft') || u.includes('feet') || u.includes('cf')) return value * 0.0283168;
  if (u.includes('mm')) return value * 1e-9;
  if (u.includes('cm')) return value * 1e-6;
  return value; // m³ 가정
}
function areaToM2(value: number, units: string): number {
  const u = units.toLowerCase();
  if (u.includes('ft') || u.includes('sf')) return value * 0.092903;
  if (u.includes('mm')) return value * 1e-6;
  if (u.includes('cm')) return value * 1e-4;
  return value; // m² 가정
}
function lengthToM(value: number, units: string): number {
  const u = units.toLowerCase();
  if (u.includes('ft') || u.includes('feet')) return value * 0.3048;
  if (u.includes('inch') || u === 'in' || u.includes('"')) return value * 0.0254;
  if (u.includes('mm')) return value * 0.001;
  if (u.includes('cm')) return value * 0.01;
  return value; // m 가정
}

interface RawQty {
  volume?: number;
  area?: number;
  length?: number;
}

function bulkQtyProps(model: ApsModel, dbIds: number[]): Promise<Map<number, RawQty>> {
  return new Promise((resolve) => {
    const out = new Map<number, RawQty>();
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve(out);
      return;
    }
    model.getBulkProperties2(
      dbIds,
      { propFilter: ALL_CANDIDATES },
      (results: Array<{ dbId: number; properties?: Array<{ displayName: string; displayValue: any; units?: string }> }>) => {
        for (const r of results) {
          const q: RawQty = {};
          for (const p of r.properties ?? []) {
            const name = (p.displayName || '').toLowerCase();
            const v = num(p.displayValue);
            if (!Number.isFinite(v) || v <= 0) continue;
            const units = p.units || '';
            if (q.volume == null && VOL_NAMES.includes(name)) q.volume = volumeToM3(v, units);
            else if (q.area == null && AREA_NAMES.includes(name)) q.area = areaToM2(v, units);
            else if (q.length == null && LEN_NAMES.includes(name)) q.length = lengthToM(v, units);
          }
          out.set(r.dbId, q);
        }
        resolve(out);
      },
      () => resolve(out),
    );
  });
}

function emptyCat(category: string): ApsCategoryQty {
  return { category, count: 0, volume: 0, area: 0, length: 0, volCount: 0, areaCount: 0, lenCount: 0 };
}

/**
 * 선택 요소(dbIds 없으면 전체)의 물량을 APS 속성에서 산출해 공종별 집계.
 */
export async function computeApsQuantities(
  model: ApsModel,
  elements: ApsElement[],
  dbIds?: number[],
): Promise<ApsQtyResult> {
  const catByDb = new Map(elements.map((e) => [e.dbId, e.category]));
  const ids = dbIds && dbIds.length ? dbIds : elements.map((e) => e.dbId);
  const qtyMap = await bulkQtyProps(model, ids).catch(() => new Map<number, RawQty>());

  const byCat = new Map<string, ApsCategoryQty>();
  const total = emptyCat('합계');
  for (const dbId of ids) {
    const cat = catByDb.get(dbId) ?? 'UNKNOWN';
    const c = byCat.get(cat) ?? emptyCat(cat);
    const q = qtyMap.get(dbId) ?? {};
    c.count++;
    total.count++;
    if (q.volume) { c.volume += q.volume; c.volCount++; total.volume += q.volume; total.volCount++; }
    if (q.area) { c.area += q.area; c.areaCount++; total.area += q.area; total.areaCount++; }
    if (q.length) { c.length += q.length; c.lenCount++; total.length += q.length; total.lenCount++; }
    byCat.set(cat, c);
  }
  const categories = Array.from(byCat.values()).sort((a, b) => b.count - a.count);
  return { categories, total };
}
