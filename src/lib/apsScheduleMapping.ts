import type { ScheduleTask } from './schedule';
import type { ElementInfo, TaskMapping } from './fourd';
import { mapByName, mapSequential } from './fourd';
import type { ApsElement } from './apsElements';

// =====================================================================
// APS 공정표 매핑 엔진 — S50. 나비스웍스 TimeLiner 의 "원본 속성 → 공정표 매칭"
// 동작을 재현한다. 우선순위:
//   ① 속성 매칭 — 모델·공정표마다 매칭 기준 속성(WBS/구역/공정코드 등)이 달라
//      사용자가 UI 에서 직접 고른다(하드코딩 금지).
//   ② 이름 매칭 — fourd.ts 의 mapByName 재사용.
//   ③ 순서 폴백 — fourd.ts 의 mapSequential 재사용.
// ① 이 0건이면 ②, ②도 0건이면 ③ 으로 자동 폴백한다.
// =====================================================================

type ApsModel = any;

function normKey(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

/** dbId 들의 지정 속성값을 일괄 조회(APS getBulkProperties2). */
export function bulkPropertyValues(
  model: ApsModel,
  dbIds: number[],
  propName: string,
): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    const out = new Map<number, string>();
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve(out);
      return;
    }
    model.getBulkProperties2(
      dbIds,
      { propFilter: [propName] },
      (results: Array<{ dbId: number; properties?: Array<{ displayName: string; displayValue: unknown }> }>) => {
        for (const r of results) {
          const v = r.properties?.find((p) => p.displayName === propName)?.displayValue;
          if (v !== undefined && v !== null && String(v) !== '') out.set(r.dbId, String(v));
        }
        resolve(out);
      },
      () => resolve(out),
    );
  });
}

/**
 * 매칭 기준 속성 후보 이름들을 수집(UI 선택 드롭다운용) — dbId 샘플의 속성 목록 합집합.
 * 카테고리/이름 등 항상 있는 속성은 매칭 기준으로 의미가 적어 흔한 것 위주로 두되,
 * 제외하지는 않는다(모델마다 의미가 다를 수 있어 사용자 판단에 맡긴다).
 */
export function collectPropertyNames(model: ApsModel, dbIds: number[], sampleSize = 30): Promise<string[]> {
  return new Promise((resolve) => {
    const sample = dbIds.slice(0, sampleSize);
    if (!sample.length || typeof model.getBulkProperties2 !== 'function') {
      resolve([]);
      return;
    }
    model.getBulkProperties2(
      sample,
      {},
      (results: Array<{ properties?: Array<{ displayName: string }> }>) => {
        const names = new Set<string>();
        for (const r of results) for (const p of r.properties ?? []) names.add(p.displayName);
        resolve([...names].sort());
      },
      () => resolve([]),
    );
  });
}

/** 속성값(정규화) ↔ 공정표 작업(externalId/id/name 후보)을 매칭. */
export function mapByProperty(
  tasks: ScheduleTask[],
  propValues: Map<number, string>,
  modelID: number,
): TaskMapping {
  const byKey = new Map<string, number[]>();
  for (const [dbId, v] of propValues) {
    const k = normKey(v);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(dbId);
    byKey.set(k, arr);
  }

  const mapping: TaskMapping = {};
  for (const task of tasks) {
    const candidates = [task.externalId, task.id, task.name].filter((v): v is string => !!v);
    for (const c of candidates) {
      const hits = byKey.get(normKey(c));
      if (hits?.length) {
        mapping[task.id] = hits.map((dbId) => ({ modelID, expressID: dbId }));
        break;
      }
    }
  }
  return mapping;
}

/**
 * 우선순위대로 매핑을 만든다: matchProperty 가 주어지면 속성 매칭을 먼저 시도하고,
 * 결과가 비면(또는 matchProperty 가 없으면) 이름 매칭 → 순서 폴백으로 내려간다.
 */
export async function buildApsTaskMapping(
  model: ApsModel,
  elements: ApsElement[],
  tasks: ScheduleTask[],
  matchProperty: string | null,
): Promise<TaskMapping> {
  const modelID: number = model?.id ?? 0;
  const catalog: ElementInfo[] = elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));

  let mapping: TaskMapping = {};
  if (matchProperty) {
    const propValues = await bulkPropertyValues(model, elements.map((e) => e.dbId), matchProperty);
    mapping = mapByProperty(tasks, propValues, modelID);
  }
  if (Object.keys(mapping).length === 0) mapping = mapByName(tasks, catalog);
  if (Object.keys(mapping).length === 0) mapping = mapSequential(tasks, catalog);
  return mapping;
}
