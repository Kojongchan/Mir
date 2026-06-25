// =====================================================================
// APS 요소 열거 — S49. 간섭 집합 선택(카테고리)·이슈 생성(선택 dbId→이름)에 쓰는
// dbId 별 이름·카테고리 인덱스. instanceTree(동기)로 leaf 와 이름을 모으고,
// getBulkProperties2 로 'Category'/타입을 비동기 보강한다(없으면 이름에서 추정).
// =====================================================================

type ApsModel = any;

export interface ApsElement {
  dbId: number;
  name: string;
  category: string;
}

/** instanceTree 의 leaf dbId(실제 요소)만 수집. */
function leafDbIds(model: ApsModel): number[] {
  const it = model.getInstanceTree?.();
  if (!it) return [];
  const ids: number[] = [];
  const walk = (dbId: number) => {
    let n = 0;
    it.enumNodeChildren(dbId, (c: number) => {
      n++;
      walk(c);
    });
    if (n === 0) ids.push(dbId);
  };
  walk(it.getRootId());
  return ids;
}

/** "IfcWall [123456]" / "Basic Wall [98765]" → "IfcWall" 처럼 카테고리 추정. */
function deriveCategory(name: string): string {
  if (!name) return 'UNKNOWN';
  const noId = name.replace(/\s*\[\d+\]\s*$/, '').trim();
  // 첫 토큰(공백/콜론 이전)을 카테고리로. IFC 타입명(IFCWALL 등)에 유효.
  const m = noId.match(/^([A-Za-z][\w-]*)/);
  return (m?.[1] ?? noId.split(/[\s:]/)[0] ?? 'UNKNOWN') || 'UNKNOWN';
}

/** dbId 들의 'Category' 속성을 일괄 조회(Revit). 없으면 빈 맵. */
function bulkCategories(model: ApsModel, dbIds: number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    const out = new Map<number, string>();
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve(out);
      return;
    }
    model.getBulkProperties2(
      dbIds,
      { propFilter: ['Category', 'Type Name', '_RC'] },
      (results: Array<{ dbId: number; properties?: Array<{ displayName: string; displayValue: any }> }>) => {
        for (const r of results) {
          const cat = r.properties?.find((p) => p.displayName === 'Category')?.displayValue;
          if (cat) out.set(r.dbId, String(cat));
        }
        resolve(out);
      },
      () => resolve(out),
    );
  });
}

/**
 * 모델의 모든 leaf 요소를 dbId·이름·카테고리로 열거한다. 카테고리는 Revit
 * 'Category' 속성을 우선하고, 없으면 노드 이름에서 추정한다.
 */
export async function enumerateApsElements(model: ApsModel): Promise<ApsElement[]> {
  const it = model.getInstanceTree?.();
  if (!it) return [];
  const ids = leafDbIds(model);
  const catMap = await bulkCategories(model, ids).catch(() => new Map<number, string>());
  return ids.map((dbId) => {
    const name = it.getNodeName?.(dbId) ?? '';
    return {
      dbId,
      name,
      category: catMap.get(dbId) ?? deriveCategory(name),
    };
  });
}

/** dbId → {name, category} 로 빠르게 찾기 위한 맵. */
export function elementMetaMap(elements: ApsElement[]): Map<number, { name: string; category: string }> {
  const m = new Map<number, { name: string; category: string }>();
  for (const e of elements) m.set(e.dbId, { name: e.name, category: e.category });
  return m;
}

/** 카테고리별 dbId 묶음(집합 선택 드롭다운용). */
export function groupByCategory(elements: ApsElement[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const e of elements) {
    const arr = m.get(e.category) ?? [];
    arr.push(e.dbId);
    m.set(e.category, arr);
  }
  return m;
}
