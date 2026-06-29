// 4D 일정/매핑의 Supabase 영속화 데이터층.
// supabase/migrations/0003_schedule.sql (schedules / schedule_tasks /
// task_elements) 스키마를 사용한다. RLS 는 models 와 동일하게 프로젝트 멤버십으로
// 강제된다(is_member/is_admin). 라이브 검증은 마이그레이션 적용 후 배포 환경에서.
//
// 매핑 영속화 메모(1차): task_elements 는 (db model_id, express_id) 로 저장한다.
// 런타임 web-ifc modelID 는 로드 때마다 달라지므로, 불러올 때 호출측이 db model_id
// → 런타임 modelID 로 변환한다(현재는 단일 활성 모델 가정).

import { supabase } from './supabase';
import type { ScheduleTask, TaskKind, ScheduleSource } from './schedule';
import type { TaskMapping } from './fourd';
import type { ApsMapping } from './apsMapping';
import { globalIdOf, dbIdOf } from './apsMapping';

export interface SavedScheduleMeta {
  id: string;
  name: string;
  source: ScheduleSource;
  model_id: string | null;
  created_at: string;
}

/** 불러온 일정 + 저장 시점의 (db model_id, expressID) 요소 매핑. */
export interface LoadedSchedule {
  meta: SavedScheduleMeta;
  tasks: ScheduleTask[];
  /** taskId(=DB task uuid) → [{ modelDbId, expressID }] (express_id 행만, IFC 경로) */
  elements: Record<string, { modelDbId: string; expressID: number }[]>;
  /** taskId(=DB task uuid) → [{ modelDbId, globalId }] (global_id 행만, APS 경로 — S50) */
  globalElements: Record<string, { modelDbId: string; globalId: string }[]>;
}

/** 프로젝트의 저장된 일정 목록(최신순). */
export async function listSchedules(projectId: string): Promise<SavedScheduleMeta[]> {
  const { data, error } = await supabase
    .from('schedules')
    .select('id, name, source, model_id, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SavedScheduleMeta[];
}

/**
 * 현재 일정과 매핑을 새 schedule 로 저장. 작업/요소 id 는 클라이언트에서 생성해
 * 매핑 상관관계를 정확히 보존한다. modelDbId 가 없으면 작업만 저장(요소 매핑 생략).
 */
export async function saveSchedule(params: {
  projectId: string;
  /** 런타임 modelID → DB 모델 uuid. 매핑된 각 요소의 소속 모델을 정확히 저장한다. */
  modelIdMap: Map<number, string>;
  name: string;
  source: ScheduleSource;
  tasks: ScheduleTask[];
  mapping: TaskMapping;
}): Promise<string> {
  const { projectId, modelIdMap, name, source, tasks, mapping } = params;
  const scheduleId = crypto.randomUUID();
  const { data: userData } = await supabase.auth.getUser();
  // 대표 모델(메타용) — 매핑에 등장하는 첫 DB 모델 id(없으면 null).
  const anyModelDbId = [...modelIdMap.values()][0] ?? null;

  const { error: sErr } = await supabase.from('schedules').insert({
    id: scheduleId,
    project_id: projectId,
    model_id: anyModelDbId,
    name,
    source,
    created_by: userData.user?.id ?? null,
  });
  if (sErr) throw sErr;

  // 클라이언트 task.id → 새 DB task uuid
  const dbId = new Map<string, string>();
  const taskRows = tasks.map((t, i) => {
    const id = crypto.randomUUID();
    dbId.set(t.id, id);
    return {
      id,
      schedule_id: scheduleId,
      external_id: t.externalId,
      name: t.name,
      kind: t.type,
      start_at: new Date(t.start).toISOString(),
      end_at: new Date(t.end).toISOString(),
      sort_order: i,
    };
  });
  if (taskRows.length) {
    const { error: tErr } = await supabase.from('schedule_tasks').insert(taskRows);
    if (tErr) {
      await supabase.from('schedules').delete().eq('id', scheduleId); // best-effort 정리
      throw tErr;
    }
  }

  if (modelIdMap.size) {
    const elemRows: { task_id: string; model_id: string; express_id: number }[] = [];
    for (const [clientTaskId, refs] of Object.entries(mapping)) {
      const taskDbId = dbId.get(clientTaskId);
      if (!taskDbId) continue;
      for (const ref of refs) {
        const modelDbId = modelIdMap.get(ref.modelID);
        if (!modelDbId) continue; // 알 수 없는 런타임 모델은 건너뜀
        elemRows.push({ task_id: taskDbId, model_id: modelDbId, express_id: ref.expressID });
      }
    }
    if (elemRows.length) {
      const { error: eErr } = await supabase.from('task_elements').insert(elemRows);
      if (eErr) throw eErr;
    }
  }

  return scheduleId;
}

/**
 * APS(ACC) 모델용 일정 저장 — S50. dbId 는 세션마다 휘발성이라 영속키로 쓸 수
 * 없으므로 ApsMapping 으로 GlobalId 로 변환해 task_elements.global_id 에 저장한다
 * (express_id 는 비워둠). 단일 활성 APS 모델 가정(현재 4D 모드는 모델 1개).
 */
export async function saveApsSchedule(params: {
  projectId: string;
  /** 저장할 APS 모델의 DB 모델 uuid(models.id). */
  modelDbId: string | null;
  /** 매핑의 ElementRef.modelID(런타임 model.id) → 그 모델의 dbId↔GlobalId 인덱스. */
  apsMapping: ApsMapping;
  name: string;
  source: ScheduleSource;
  tasks: ScheduleTask[];
  /** ElementRef.expressID 슬롯에 APS dbId 가 담긴 매핑(S49 관례). */
  mapping: TaskMapping;
}): Promise<string> {
  const { projectId, modelDbId, apsMapping, name, source, tasks, mapping } = params;
  const scheduleId = crypto.randomUUID();
  const { data: userData } = await supabase.auth.getUser();

  const { error: sErr } = await supabase.from('schedules').insert({
    id: scheduleId,
    project_id: projectId,
    model_id: modelDbId,
    name,
    source,
    created_by: userData.user?.id ?? null,
  });
  if (sErr) throw sErr;

  const dbTaskId = new Map<string, string>();
  const taskRows = tasks.map((t, i) => {
    const id = crypto.randomUUID();
    dbTaskId.set(t.id, id);
    return {
      id,
      schedule_id: scheduleId,
      external_id: t.externalId,
      name: t.name,
      kind: t.type,
      start_at: new Date(t.start).toISOString(),
      end_at: new Date(t.end).toISOString(),
      sort_order: i,
    };
  });
  if (taskRows.length) {
    const { error: tErr } = await supabase.from('schedule_tasks').insert(taskRows);
    if (tErr) {
      await supabase.from('schedules').delete().eq('id', scheduleId);
      throw tErr;
    }
  }

  if (modelDbId) {
    const elemRows: { task_id: string; model_id: string; global_id: string }[] = [];
    for (const [clientTaskId, refs] of Object.entries(mapping)) {
      const taskRowId = dbTaskId.get(clientTaskId);
      if (!taskRowId) continue;
      for (const ref of refs) {
        const gid = globalIdOf(apsMapping, ref.expressID);
        if (!gid) continue; // 매핑 안 되는 dbId 는 건너뜀
        elemRows.push({ task_id: taskRowId, model_id: modelDbId, global_id: gid });
      }
    }
    if (elemRows.length) {
      const { error: eErr } = await supabase.from('task_elements').insert(elemRows);
      if (eErr) throw eErr;
    }
  }

  return scheduleId;
}

/** 저장된 일정 + 요소 매핑을 불러온다(런타임 modelID 변환은 호출측 담당). */
export async function loadSchedule(scheduleId: string): Promise<LoadedSchedule> {
  const { data: meta, error: mErr } = await supabase
    .from('schedules')
    .select('id, name, source, model_id, created_at')
    .eq('id', scheduleId)
    .single();
  if (mErr) throw mErr;

  const { data: taskRows, error: tErr } = await supabase
    .from('schedule_tasks')
    .select('id, external_id, name, kind, start_at, end_at, sort_order')
    .eq('schedule_id', scheduleId)
    .order('sort_order', { ascending: true });
  if (tErr) throw tErr;

  const tasks: ScheduleTask[] = (taskRows ?? []).map((r) => ({
    id: r.id as string,
    name: (r.name as string) ?? '',
    type: ((r.kind as string) ?? 'other') as TaskKind,
    rawType: (r.kind as string) ?? '',
    start: Date.parse(r.start_at as string),
    end: Date.parse(r.end_at as string),
    // 0003 스키마는 계획 날짜/유형/외부ID 만 저장 → 나머지는 기본값(추후 컬럼 확장).
    actualStart: null,
    actualEnd: null,
    cost: null,
    externalId: (r.external_id as string) ?? null,
    custom: {},
    outline: null,
    isSummary: false,
  }));

  const taskIds = tasks.map((t) => t.id);
  const elements: LoadedSchedule['elements'] = {};
  const globalElements: LoadedSchedule['globalElements'] = {};
  if (taskIds.length) {
    const { data: elemRows, error: eErr } = await supabase
      .from('task_elements')
      .select('task_id, model_id, express_id, global_id')
      .in('task_id', taskIds);
    if (eErr) throw eErr;
    for (const row of elemRows ?? []) {
      const tid = row.task_id as string;
      if (row.global_id) {
        (globalElements[tid] ??= []).push({
          modelDbId: row.model_id as string,
          globalId: row.global_id as string,
        });
      } else if (row.express_id !== null && row.express_id !== undefined) {
        (elements[tid] ??= []).push({
          modelDbId: row.model_id as string,
          expressID: Number(row.express_id),
        });
      }
    }
  }

  return { meta: meta as SavedScheduleMeta, tasks, elements, globalElements };
}

/**
 * loadSchedule 의 globalElements(taskId→{modelDbId,globalId}[]) 를, 현재 세션의
 * (DB 모델 uuid → ApsMapping) 로 dbId 로 해석해 TaskMapping 으로 만든다.
 * 해석 안 되는(모델 미로드·GlobalId 불일치) 항목은 건너뛴다.
 */
export function resolveApsTaskMapping(
  loaded: LoadedSchedule,
  apsMappingByModelDbId: Map<string, { runtimeModelId: number; mapping: ApsMapping }>,
): TaskMapping {
  const out: TaskMapping = {};
  for (const [taskId, refs] of Object.entries(loaded.globalElements)) {
    for (const ref of refs) {
      const entry = apsMappingByModelDbId.get(ref.modelDbId);
      if (!entry) continue;
      const dbId = dbIdOf(entry.mapping, ref.globalId);
      if (dbId === null) continue;
      (out[taskId] ??= []).push({ modelID: entry.runtimeModelId, expressID: dbId });
    }
  }
  return out;
}

/** 저장된 일정 삭제(연쇄로 작업/요소도 삭제됨). */
export async function deleteSchedule(scheduleId: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('id', scheduleId);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// 활성 일정(자동 저장/복원) — 프로젝트당 1개 슬롯.
// 공정관리(4D)에서 모델+공정표+매핑을 한 번 구성하면 수동 저장 없이도 이 슬롯에
// 자동 저장되고, 재진입 시 자동 복원된다. 예약 이름으로 named 저장과 구분한다.
// ---------------------------------------------------------------------

export const ACTIVE_SCHEDULE_NAME = '__4D_ACTIVE__';

/** 현재 일정+매핑을 프로젝트의 활성 슬롯에 저장(기존 활성 슬롯은 교체). */
export async function saveActiveSchedule(params: {
  projectId: string;
  modelIdMap: Map<number, string>;
  source: ScheduleSource;
  tasks: ScheduleTask[];
  mapping: TaskMapping;
}): Promise<void> {
  // 기존 활성 슬롯 제거(연쇄로 작업/요소 삭제) 후 새로 저장.
  await supabase
    .from('schedules')
    .delete()
    .eq('project_id', params.projectId)
    .eq('name', ACTIVE_SCHEDULE_NAME);
  await saveSchedule({ ...params, name: ACTIVE_SCHEDULE_NAME });
}

/** APS 모드용 활성 슬롯 저장(GlobalId 경로) — saveActiveSchedule 의 APS 대응. */
export async function saveActiveApsSchedule(params: {
  projectId: string;
  modelDbId: string | null;
  apsMapping: ApsMapping;
  source: ScheduleSource;
  tasks: ScheduleTask[];
  mapping: TaskMapping;
}): Promise<void> {
  await supabase
    .from('schedules')
    .delete()
    .eq('project_id', params.projectId)
    .eq('name', ACTIVE_SCHEDULE_NAME);
  await saveApsSchedule({ ...params, name: ACTIVE_SCHEDULE_NAME });
}

/** 프로젝트의 활성 슬롯을 불러온다(없으면 null). */
export async function loadActiveSchedule(projectId: string): Promise<LoadedSchedule | null> {
  const { data, error } = await supabase
    .from('schedules')
    .select('id')
    .eq('project_id', projectId)
    .eq('name', ACTIVE_SCHEDULE_NAME)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const id = data?.[0]?.id as string | undefined;
  if (!id) return null;
  return loadSchedule(id);
}

/** 활성 슬롯 비우기(모델 삭제/초기화 시). */
export async function clearActiveSchedule(projectId: string): Promise<void> {
  await supabase
    .from('schedules')
    .delete()
    .eq('project_id', projectId)
    .eq('name', ACTIVE_SCHEDULE_NAME);
}
