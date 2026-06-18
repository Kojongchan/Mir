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
  /** taskId(=DB task uuid) → [{ modelDbId, expressID }] */
  elements: Record<string, { modelDbId: string; expressID: number }[]>;
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
  modelDbId: string | null;
  name: string;
  source: ScheduleSource;
  tasks: ScheduleTask[];
  mapping: TaskMapping;
}): Promise<string> {
  const { projectId, modelDbId, name, source, tasks, mapping } = params;
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

  if (modelDbId) {
    const elemRows: { task_id: string; model_id: string; express_id: number }[] = [];
    for (const [clientTaskId, refs] of Object.entries(mapping)) {
      const taskDbId = dbId.get(clientTaskId);
      if (!taskDbId) continue;
      for (const ref of refs) {
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
  }));

  const taskIds = tasks.map((t) => t.id);
  const elements: LoadedSchedule['elements'] = {};
  if (taskIds.length) {
    const { data: elemRows, error: eErr } = await supabase
      .from('task_elements')
      .select('task_id, model_id, express_id')
      .in('task_id', taskIds);
    if (eErr) throw eErr;
    for (const row of elemRows ?? []) {
      const tid = row.task_id as string;
      (elements[tid] ??= []).push({
        modelDbId: row.model_id as string,
        expressID: Number(row.express_id),
      });
    }
  }

  return { meta: meta as SavedScheduleMeta, tasks, elements };
}

/** 저장된 일정 삭제(연쇄로 작업/요소도 삭제됨). */
export async function deleteSchedule(scheduleId: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('id', scheduleId);
  if (error) throw error;
}
