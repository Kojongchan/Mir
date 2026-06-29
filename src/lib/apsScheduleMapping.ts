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
export function collectPropertyNames(model: ApsModel, dbIds: number[], sampleSize = 600): Promise<string[]> {
  return new Promise((resolve) => {
    if (!dbIds.length || typeof model.getBulkProperties2 !== 'function') {
      resolve([]);
      return;
    }
    // 요소 종류마다 속성 집합이 다르므로 앞부분만 보지 말고 모델 전체에서 고르게
    // 표본을 뽑는다(stride 샘플링). 표본이 적으면(일부 속성 누락) 매핑 후보가
    // 빠지는 문제(#1) 방지.
    const stride = Math.max(1, Math.floor(dbIds.length / sampleSize));
    const sample = stride === 1 ? dbIds.slice(0, sampleSize) : dbIds.filter((_, i) => i % stride === 0).slice(0, sampleSize);
    model.getBulkProperties2(
      sample,
      {},
      (results: Array<{ properties?: Array<{ displayName: string; hidden?: boolean }> }>) => {
        const names = new Set<string>();
        for (const r of results)
          for (const p of r.properties ?? []) {
            // 내부/숨김 속성(__viewable_in 등)·빈 이름 제외, 나머지는 모두 후보로.
            if (p.hidden) continue;
            const n = (p.displayName ?? '').trim();
            if (n && !n.startsWith('__')) names.add(n);
          }
        resolve([...names].sort((a, b) => a.localeCompare(b, 'ko')));
      },
      () => resolve([]),
    );
  });
}

/** UI 라벨용 가상 필드명 — 작업명/동기화ID 는 항상 비교 후보에 포함. */
export const TASK_NAME_FIELD = '작업명';
export const TASK_EXTERNAL_ID_FIELD = '동기화 ID/GUID';

/**
 * 공정표 작업의 비교 필드 목록(UI 선택용) — 나비스웍스 TimeLiner 규칙처럼 어떤
 * 작업 열을 모델 속성과 비교할지 사용자가 직접 고른다. 작업명/동기화ID는 항상
 * 포함하고, CSV 의 매핑되지 않은 나머지 열(custom) 이름들을 합집합으로 추가한다.
 */
export function collectTaskFields(tasks: ScheduleTask[]): string[] {
  const names = new Set<string>([TASK_NAME_FIELD]);
  if (tasks.some((t) => t.externalId)) names.add(TASK_EXTERNAL_ID_FIELD);
  for (const t of tasks) for (const k of Object.keys(t.custom)) names.add(k);
  return [...names];
}

/** 지정한 비교 필드에 대한 작업의 값(들)을 가져온다. 비어 있으면 작업명으로 폴백. */
function taskFieldValue(task: ScheduleTask, field: string | null): string | null {
  if (field === TASK_EXTERNAL_ID_FIELD) return task.externalId;
  if (field && field !== TASK_NAME_FIELD) return task.custom[field] ?? null;
  return task.name;
}

/**
 * 속성값(정규화) ↔ 공정표 작업을 매칭. `taskField` 로 비교 기준 열을 지정하면
 * (나비스웍스 "Column Name" 옵션처럼) 그 값만 비교하고, 지정하지 않으면 작업명→
 * 동기화ID→작업ID 순으로 후보를 시도한다(기존 동작 유지).
 */
export function mapByProperty(
  tasks: ScheduleTask[],
  propValues: Map<number, string>,
  modelID: number,
  taskField: string | null = null,
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
    const candidates = taskField
      ? [taskFieldValue(task, taskField)].filter((v): v is string => !!v)
      : [task.externalId, task.id, task.name].filter((v): v is string => !!v);
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
  matchTaskField: string | null = null,
): Promise<TaskMapping> {
  const modelID: number = model?.id ?? 0;
  const catalog: ElementInfo[] = elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));

  let mapping: TaskMapping = {};
  if (matchProperty) {
    const propValues = await bulkPropertyValues(model, elements.map((e) => e.dbId), matchProperty);
    mapping = mapByProperty(tasks, propValues, modelID, matchTaskField);
  }
  if (Object.keys(mapping).length === 0) mapping = mapByName(tasks, catalog);
  if (Object.keys(mapping).length === 0) mapping = mapSequential(tasks, catalog);
  return mapping;
}

// ---------------------------------------------------------------------
// 규칙 기반 매핑(나비스웍스 TimeLiner '규칙 편집기' 류). 여러 규칙을 위에서
// 아래로 적용해 결과를 합집합(객체 중복 제거)으로 누적한다. 각 규칙은 모델 속성
// (없으면 객체 이름)과 공정표 비교 열(없으면 자동: 동기화ID→작업ID→작업명)을 짝짓는다.
// ---------------------------------------------------------------------
export interface ApsMatchRule {
  id: string;
  /** 모델 객체 속성명. null/'' 이면 객체 이름으로 매칭. */
  modelProperty: string | null;
  /** 공정표 비교 열. null/'' 이면 자동(동기화ID→작업ID→작업명). */
  taskField: string | null;
  enabled: boolean;
}

function mergeMapping(into: TaskMapping, add: TaskMapping): void {
  for (const [taskId, refs] of Object.entries(add)) {
    const existing = into[taskId] ?? [];
    const seen = new Set(existing.map((r) => `${r.modelID}:${r.expressID}`));
    for (const r of refs) {
      const k = `${r.modelID}:${r.expressID}`;
      if (!seen.has(k)) {
        existing.push(r);
        seen.add(k);
      }
    }
    into[taskId] = existing;
  }
}

export async function applyApsRules(
  model: ApsModel,
  elements: ApsElement[],
  tasks: ScheduleTask[],
  rules: ApsMatchRule[],
): Promise<TaskMapping> {
  const modelID: number = model?.id ?? 0;
  const catalog: ElementInfo[] = elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));
  const dbIds = elements.map((e) => e.dbId);
  const merged: TaskMapping = {};
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let partial: TaskMapping = {};
    if (rule.modelProperty) {
      const propValues = await bulkPropertyValues(model, dbIds, rule.modelProperty);
      partial = mapByProperty(tasks, propValues, modelID, rule.taskField);
    } else {
      partial = mapByName(tasks, catalog);
    }
    mergeMapping(merged, partial);
  }
  return merged;
}
