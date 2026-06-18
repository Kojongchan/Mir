// 4D 시뮬레이션 코어 — 일정 작업(ScheduleTask)을 IFC 객체(expressID)에 매핑하고,
// 특정 시점의 각 객체 시공 상태(시공완료/진행중/미시공)를 계산한다.
//
// 매핑 전략(1차):
//  - byName: 작업 이름과 IFC 요소 이름을 정규화해 매칭(이름이 정렬돼 있을 때 정확).
//  - sequential: 모델 요소를 일정 순서대로 균등 분배(이름이 안 맞는 모델/공정표
//    조합에서도 시각적으로 동작하는 빠른 데모용).
// DB(추가형 마이그레이션) 기반 정밀 매핑은 설계만 잡아둔다(supabase/migrations).

import type { ScheduleTask } from './schedule';

/** 모델 내 한 요소를 가리키는 참조 */
export interface ElementRef {
  modelID: number;
  expressID: number;
}

/** 뷰어가 제공하는 요소 카탈로그 항목 */
export interface ElementInfo extends ElementRef {
  name: string;
}

/** 작업 id → 그 작업이 만드는 요소들 */
export type TaskMapping = Record<string, ElementRef[]>;

// future  : 아직 생성 전(숨김 / ghost)
// active   : 현재 작업 진행 중(주황 강조)
// built    : 생성 완료되어 존재
// removed  : 철거(또는 임시)되어 사라짐(항상 숨김)
export type BuildState = 'built' | 'active' | 'future' | 'removed';

type Effect = 'build' | 'remove';

/** 작업 유형 → 요소에 끼치는 효과(생성/제거). 철거·임시는 끝나면 사라진다. */
function effectOf(kind: string): Effect {
  return kind === 'demolish' || kind === 'temporary' ? 'remove' : 'build';
}

export const elementKey = (e: ElementRef): string => `${e.modelID}:${e.expressID}`;

// --- 매핑 ----------------------------------------------------------------

function normalizeName(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

/** "A1 버림: A1 버림" 같은 이름에서 매칭 후보 키들을 만든다. */
function nameKeys(name: string): string[] {
  const keys = new Set<string>();
  const full = normalizeName(name);
  if (full) keys.add(full);
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const a = normalizeName(name.slice(0, colon));
    const b = normalizeName(name.slice(colon + 1));
    if (a) keys.add(a);
    if (b) keys.add(b);
  }
  return [...keys];
}

/**
 * 이름 기반 매핑. 작업 이름 후보 키가 요소 이름에 포함(또는 그 반대)되면 연결.
 * 매칭이 거의 없으면 호출측에서 sequential 로 폴백하도록 결과를 그대로 반환.
 */
export function mapByName(tasks: ScheduleTask[], catalog: ElementInfo[]): TaskMapping {
  const mapping: TaskMapping = {};
  const normedCatalog = catalog
    .filter((c) => c.name)
    .map((c) => ({ ref: c, key: normalizeName(c.name) }));

  for (const task of tasks) {
    const keys = nameKeys(task.name);
    const hits: ElementRef[] = [];
    for (const { ref, key } of normedCatalog) {
      if (keys.some((k) => k.length >= 2 && (key.includes(k) || k.includes(key)))) {
        hits.push({ modelID: ref.modelID, expressID: ref.expressID });
      }
    }
    if (hits.length) mapping[task.id] = hits;
  }
  return mapping;
}

/**
 * 순서 기반 자동 분배. 시작 시각 순으로 정렬한 작업에 요소(expressID 순)를 균등
 * 분배한다. 이름이 맞지 않는 모델/공정표에서도 4D 시뮬레이션을 시각화하기 위한
 * 빠른 폴백. 장비/임시 유형은 형상이 없는 경우가 많아 분배 대상에서 제외한다.
 */
export function mapSequential(tasks: ScheduleTask[], catalog: ElementInfo[]): TaskMapping {
  // 순서 데모는 "쌓아 올리는" 시각화이므로 생성 작업에만 분배한다(철거/장비/임시 제외).
  const buildTasks = tasks
    .filter((t) => t.type === 'construct' || t.type === 'other')
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const targets = buildTasks.length ? buildTasks : tasks.slice().sort((a, b) => a.start - b.start);
  if (targets.length === 0) return {};

  const elems = catalog.slice().sort((a, b) => a.modelID - b.modelID || a.expressID - b.expressID);
  const mapping: TaskMapping = {};
  if (elems.length === 0) return mapping;

  const per = Math.ceil(elems.length / targets.length);
  for (let i = 0; i < targets.length; i++) {
    const chunk = elems.slice(i * per, (i + 1) * per);
    if (chunk.length) {
      mapping[targets[i].id] = chunk.map((c) => ({ modelID: c.modelID, expressID: c.expressID }));
    }
  }
  return mapping;
}

/** 매핑된 (작업 수, 요소 수) 통계 */
export function mappingStats(mapping: TaskMapping): { tasks: number; elements: number } {
  let elements = 0;
  let tasks = 0;
  for (const refs of Object.values(mapping)) {
    if (refs.length) {
      tasks++;
      elements += refs.length;
    }
  }
  return { tasks, elements };
}

// --- 상태 계산 -----------------------------------------------------------

interface ElementEvent {
  start: number;
  end: number;
  effect: Effect;
}

/**
 * 특정 시점(now)에 매핑된 모든 요소의 시공 상태를 계산. 한 요소가 여러 작업에
 * 걸리면(예: 생성 후 철거) 작업을 시작 시각 순으로 적용해 생애주기를 따른다.
 *  - 진행 중인 작업이 있으면 active
 *  - 그 외에는 마지막으로 끝난 작업의 효과에 따라 built(생성) / removed(철거)
 *  - 아직 어떤 작업도 시작되지 않았으면 future
 * 매핑되지 않은 요소는 결과에 없으며(=항상 보이게 유지) 모델이 통째로 사라지지 않는다.
 */
export function computeStates(
  tasks: ScheduleTask[],
  mapping: TaskMapping,
  now: number,
): Map<string, { ref: ElementRef; state: BuildState }> {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // 요소별 이벤트 수집
  const events = new Map<string, { ref: ElementRef; list: ElementEvent[] }>();
  for (const [taskId, refs] of Object.entries(mapping)) {
    const task = byId.get(taskId);
    if (!task) continue;
    const ev: ElementEvent = { start: task.start, end: task.end, effect: effectOf(task.type) };
    for (const ref of refs) {
      const key = elementKey(ref);
      let entry = events.get(key);
      if (!entry) {
        entry = { ref, list: [] };
        events.set(key, entry);
      }
      entry.list.push(ev);
    }
  }

  const result = new Map<string, { ref: ElementRef; state: BuildState }>();
  for (const [key, { ref, list }] of events) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let state: BuildState = 'future';
    for (const ev of list) {
      if (ev.start > now) continue; // 아직 시작 안 한 작업은 무시
      if (now < ev.end) state = 'active';
      else state = ev.effect === 'build' ? 'built' : 'removed';
    }
    result.set(key, { ref, state });
  }
  return result;
}
