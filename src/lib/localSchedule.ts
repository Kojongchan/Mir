// =====================================================================
// 4D 공정표 로컬(브라우저) 영속화 — 프로젝트별. DB(마이그레이션/권한)에 의존하지
// 않고도 임포트한 공정표가 메뉴 이동·새로고침 후에도 유지되도록 한다(사용자 요청 #3).
// 프로젝트마다 별도 키로 저장하므로 프로젝트별 서로 다른 공정표가 각각 보존된다.
// 매핑은 dbId 가 세션마다 휘발성이라 GlobalId 로 저장하고, 복원 시 현재 세션의
// ApsMapping 으로 dbId 로 다시 해석한다(APS 전용; IFC 경로는 기존 DB 경로 사용).
// =====================================================================
import type { ScheduleTask, ScheduleSource } from './schedule';
import type { TaskMapping } from './fourd';
import type { ApsMapping } from './apsMapping';

export interface StoredSchedule {
  tasks: ScheduleTask[];
  source: ScheduleSource;
  /** 작업 id → GlobalId[] (APS). 매핑 없으면 비어 있음. */
  globalMapping?: Record<string, string[]>;
  savedAt: number;
}

const key = (projectId: string) => `mir-4d-sched:${projectId}`;

/** 임포트/매핑 직후 호출. 매핑이 비어 있어도 공정표(tasks)는 항상 저장한다. */
export function saveLocalApsSchedule(
  projectId: string,
  tasks: ScheduleTask[],
  source: ScheduleSource,
  mapping: TaskMapping,
  apsMapping: ApsMapping | null,
): void {
  if (!projectId || tasks.length === 0) return;
  const globalMapping: Record<string, string[]> = {};
  if (apsMapping) {
    for (const [taskId, refs] of Object.entries(mapping)) {
      const gids = refs
        .map((r) => apsMapping.dbIdToGlobalId.get(r.expressID))
        .filter((g): g is string => !!g);
      if (gids.length) globalMapping[taskId] = gids;
    }
  }
  try {
    localStorage.setItem(key(projectId), JSON.stringify({ tasks, source, globalMapping, savedAt: Date.now() }));
  } catch {
    /* 용량 초과 등 — 무시(DB 경로가 백업) */
  }
}

export function loadLocalApsSchedule(projectId: string): StoredSchedule | null {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(key(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSchedule;
    return parsed && Array.isArray(parsed.tasks) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLocalSchedule(projectId: string): void {
  try {
    localStorage.removeItem(key(projectId));
  } catch {
    /* 무시 */
  }
}

/** 저장된 GlobalId 매핑을 현재 세션의 ApsMapping(+ 뷰어 modelID)으로 dbId 해석. */
export function resolveLocalMapping(
  stored: StoredSchedule,
  apsMapping: ApsMapping | null,
  modelID: number,
): TaskMapping {
  const out: TaskMapping = {};
  if (!stored.globalMapping || !apsMapping) return out;
  for (const [taskId, gids] of Object.entries(stored.globalMapping)) {
    const refs = gids
      .map((g) => apsMapping.globalIdToDbId.get(g))
      .filter((d): d is number => typeof d === 'number')
      .map((dbId) => ({ modelID, expressID: dbId }));
    if (refs.length) out[taskId] = refs;
  }
  return out;
}
