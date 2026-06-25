// =====================================================================
// APS(Autodesk Platform Services) dbId ↔ externalId(GlobalId) 매핑 — S49 / 선결.
//
// 배경: 우리 고유기능(간섭·이슈·물량)은 원래 web-ifc `expressID` 에 묶여 있었다.
// 그러나 APS Viewer 는 요소를 **dbId**(모델 내부 정수, 휘발성·세션마다 동일하나
// 모델 종속) 로 다루고, 영구 식별키는 **externalId** 다. ACC 가 변환한 IFC 모델에서
// externalId = IFC GlobalId, Revit 모델에서는 Revit UniqueId 다. 우리는 영속 저장키를
// **GlobalId(=externalId)** 로 통일한다(D2 의 expressID 를 대체).
//
// 이 모듈은 APS 모델 1개에 대해 dbId↔externalId 양방향 인덱스를 **한 번** 비동기로
// 구축하고 캐시한다. 이후 간섭(apsClash)·이슈 핀·위치보기 등 모든 단계가 이 인덱스에
// 의존한다. 순수 데이터 모듈(뷰어 렌더 비의존) — 입력은 Autodesk Viewer 의 `model`.
//
// 구축 경로(우선순위):
//   1) model.getExternalIdMapping()  — externalId→dbId 통짜 맵(가장 빠르고 정확).
//   2) (폴백) instanceTree 순회 + getBulkProperties 로 externalId 수집.
// =====================================================================

/** APS 모델 객체(Autodesk.Viewing.Model). 타입 패키지 미설치라 느슨하게 둔다. */
type ApsModel = any;

export interface ApsMapping {
  /** 이 매핑이 속한 모델(런타임). */
  readonly model: ApsModel;
  /** dbId → externalId(GlobalId). */
  readonly dbIdToGlobalId: Map<number, string>;
  /** externalId(GlobalId) → dbId. */
  readonly globalIdToDbId: Map<string, number>;
  /** 매핑된 요소 수. */
  readonly size: number;
}

/** model 인스턴스별 매핑 캐시(중복 구축 방지). */
const _cache = new WeakMap<object, Promise<ApsMapping>>();

/**
 * externalId→dbId 통짜 맵을 비동기로 얻는다(APS 표준 API). 일부 뷰어 버전은
 * 콜백, 일부는 Promise 를 반환하므로 양쪽을 흡수한다.
 */
function getExternalIdMapping(model: ApsModel): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    try {
      const ret = model.getExternalIdMapping(
        (map: Record<string, number>) => resolve(map ?? {}),
        (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      );
      // 일부 버전은 Promise 를 반환(콜백 미호출) → 그것도 수용.
      if (ret && typeof ret.then === 'function') {
        ret.then((map: Record<string, number>) => resolve(map ?? {})).catch(reject);
      }
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** instanceTree 의 모든 leaf dbId 를 수집(폴백 경로용). */
function collectLeafDbIds(model: ApsModel): number[] {
  const tree = model.getInstanceTree?.();
  if (!tree) return [];
  const ids: number[] = [];
  const root = tree.getRootId();
  const walk = (dbId: number) => {
    let childCount = 0;
    tree.enumNodeChildren(dbId, (child: number) => {
      childCount++;
      walk(child);
    });
    if (childCount === 0) ids.push(dbId); // leaf = 실제 요소
  };
  walk(root);
  return ids;
}

/**
 * 폴백: getBulkProperties2 로 각 요소의 externalId 를 모아 맵을 구성한다.
 * (getExternalIdMapping 이 없거나 비어 있을 때만.)
 */
function bulkExternalIds(model: ApsModel, dbIds: number[]): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve({});
      return;
    }
    const out: Record<string, number> = {};
    model.getBulkProperties2(
      dbIds,
      { needsExternalId: true },
      (results: Array<{ dbId: number; externalId?: string }>) => {
        for (const r of results) if (r.externalId) out[r.externalId] = r.dbId;
        resolve(out);
      },
      () => resolve(out),
    );
  });
}

/**
 * APS 모델의 dbId↔externalId(GlobalId) 양방향 인덱스를 구축한다. 같은 model
 * 인스턴스에 대해서는 결과를 캐시해 한 번만 빌드한다.
 */
export function buildApsMapping(model: ApsModel): Promise<ApsMapping> {
  const cached = _cache.get(model);
  if (cached) return cached;

  const built = (async (): Promise<ApsMapping> => {
    let extToDb: Record<string, number> = {};
    try {
      extToDb = await getExternalIdMapping(model);
    } catch {
      extToDb = {};
    }
    // 비었으면 instanceTree + bulkProperties 폴백.
    if (!extToDb || Object.keys(extToDb).length === 0) {
      const leaves = collectLeafDbIds(model);
      extToDb = await bulkExternalIds(model, leaves);
    }

    const dbIdToGlobalId = new Map<number, string>();
    const globalIdToDbId = new Map<string, number>();
    for (const ext of Object.keys(extToDb)) {
      const dbId = extToDb[ext];
      if (typeof dbId !== 'number') continue;
      dbIdToGlobalId.set(dbId, ext);
      // 동일 externalId 가 여러 dbId 에 매핑되면 첫 값을 유지(IFC 는 보통 1:1).
      if (!globalIdToDbId.has(ext)) globalIdToDbId.set(ext, dbId);
    }

    return {
      model,
      dbIdToGlobalId,
      globalIdToDbId,
      get size() {
        return dbIdToGlobalId.size;
      },
    };
  })();

  _cache.set(model, built);
  // 빌드 실패 시 캐시를 비워 다음 호출에서 재시도 가능하게.
  built.catch(() => _cache.delete(model));
  return built;
}

/** dbId → GlobalId(없으면 null). */
export function globalIdOf(mapping: ApsMapping, dbId: number): string | null {
  return mapping.dbIdToGlobalId.get(dbId) ?? null;
}

/** GlobalId → dbId(없으면 null). */
export function dbIdOf(mapping: ApsMapping, globalId: string): number | null {
  return mapping.globalIdToDbId.get(globalId) ?? null;
}

/** 여러 GlobalId 를 현재 모델의 dbId 들로 해석(매핑 안 되는 건 제외). */
export function dbIdsForGlobalIds(mapping: ApsMapping, globalIds: string[]): number[] {
  const out: number[] = [];
  for (const g of globalIds) {
    const id = mapping.globalIdToDbId.get(g);
    if (typeof id === 'number') out.push(id);
  }
  return out;
}
