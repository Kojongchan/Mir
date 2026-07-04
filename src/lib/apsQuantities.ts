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

// 수량 속성 분류 — 정확 일치가 아니라 표시명 '부분일치'로 판단한다. Revit/IFC 파생
// 모델의 다양한 명칭(NetVolume·Gross Volume·Material Volume·면적 등)을 폭넓게 포착.
type QtyKind = 'volume' | 'area' | 'length';

function classifyProp(displayName: string): QtyKind | null {
  const n = (displayName || '').toLowerCase();
  if (!n) return null;
  // 부피(체적) — area/length 보다 먼저 검사(‘volume’ 우선).
  if (n.includes('volume') || n.includes('체적') || n.includes('부피')) return 'volume';
  if (n.includes('area') || n.includes('면적')) return 'area';
  if (n.includes('length') || n.includes('길이') || n.includes('perimeter') || n.includes('둘레')) {
    return n.includes('perimeter') || n.includes('둘레') ? null : 'length'; // 둘레는 길이합에서 제외
  }
  return null;
}

/** 같은 종류 속성이 여럿일 때 우선순위(정확히 'volume'/'area'/'length' 인 것을 최우선). */
function propPriority(displayName: string): number {
  const n = (displayName || '').toLowerCase().trim();
  if (n === 'volume' || n === 'area' || n === 'length' || n === '체적' || n === '면적' || n === '길이') return 3;
  if (n.startsWith('net ') || n.startsWith('gross ')) return 2;
  return 1;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.eE+-]/g, ''));
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

type ApsProp = { displayName: string; displayValue: any; units?: string };

/** 한 배치의 dbId 들에 대해 '모든' 속성을 받아 수량으로 분류. propFilter 를 걸지
 *  않아야(전체 조회) NetVolume·면적 등 변형 명칭까지 포착된다. */
function bulkBatch(model: ApsModel, dbIds: number[]): Promise<Map<number, RawQty>> {
  return new Promise((resolve) => {
    const out = new Map<number, RawQty>();
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve(out);
      return;
    }
    model.getBulkProperties2(
      dbIds,
      { ignoreHidden: true },
      (results: Array<{ dbId: number; properties?: ApsProp[] }>) => {
        for (const r of results) {
          // 종류별로 우선순위가 가장 높은 속성 1개만 채택(중복 합산 방지).
          const best: Record<QtyKind, { prio: number; value: number } | undefined> = {
            volume: undefined, area: undefined, length: undefined,
          };
          for (const p of r.properties ?? []) {
            const kind = classifyProp(p.displayName);
            if (!kind) continue;
            const v = num(p.displayValue);
            if (!Number.isFinite(v) || v <= 0) continue;
            const units = p.units || '';
            const norm = kind === 'volume' ? volumeToM3(v, units) : kind === 'area' ? areaToM2(v, units) : lengthToM(v, units);
            const prio = propPriority(p.displayName);
            const cur = best[kind];
            if (!cur || prio > cur.prio) best[kind] = { prio, value: norm };
          }
          const q: RawQty = {};
          if (best.volume) q.volume = best.volume.value;
          if (best.area) q.area = best.area.value;
          if (best.length) q.length = best.length.value;
          out.set(r.dbId, q);
        }
        resolve(out);
      },
      () => resolve(out),
    );
  });
}

/** 대형 모델에서도 안전하도록 배치로 나눠 전체 속성을 조회한다. */
async function bulkQtyProps(model: ApsModel, dbIds: number[]): Promise<Map<number, RawQty>> {
  const out = new Map<number, RawQty>();
  const CHUNK = 1500;
  for (let i = 0; i < dbIds.length; i += CHUNK) {
    const batch = dbIds.slice(i, i + CHUNK);
    const part = await bulkBatch(model, batch).catch(() => new Map<number, RawQty>());
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
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
