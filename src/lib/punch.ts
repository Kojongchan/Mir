import { supabase } from './supabase';
import { notify } from './notifications';

// =====================================================================
// R3 — Punch List(하자·미완료) 데이터층.
// 이슈/RFI 패턴 재사용: 상태 워크플로우 + 담당 배정 + 알림 + 3D/도면 핀 앵커.
// 사진(before/after)은 attachments(target_type='punch') 재사용.
// 준공률 = closed / total.
// =====================================================================

export type PunchStatus = 'open' | 'in_progress' | 'verified' | 'closed';
export type PunchSeverity = 'low' | 'normal' | 'high' | 'critical';

export const PUNCH_STATUSES: PunchStatus[] = ['open', 'in_progress', 'verified', 'closed'];
export const PUNCH_SEVERITIES: PunchSeverity[] = ['low', 'normal', 'high', 'critical'];

export const PUNCH_STATUS_LABEL: Record<PunchStatus, string> = {
  open: '신규',
  in_progress: '조치중',
  verified: '확인',
  closed: '완료',
};
export const PUNCH_SEVERITY_LABEL: Record<PunchSeverity, string> = {
  low: '경미',
  normal: '보통',
  high: '중요',
  critical: '심각',
};

/** 완료로 간주하는 상태(준공률 계산). */
export const PUNCH_DONE_STATUSES: PunchStatus[] = ['closed'];

export interface Punch {
  id: string;
  project_id: string;
  punch_no: number;
  title: string;
  description: string | null;
  location_desc: string | null;
  global_id: string | null;
  drawing_id: string | null;
  pin_x: number | null;
  pin_y: number | null;
  pin_page: number | null;
  status: PunchStatus;
  severity: PunchSeverity;
  assignee_company: string | null;
  assignee: string | null;
  assignee_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  'id, project_id, punch_no, title, description, location_desc, global_id, drawing_id, pin_x, pin_y, pin_page, status, severity, assignee_company, assignee, assignee_name, created_by, created_by_name, created_at, updated_at';

export async function listPunches(projectId: string): Promise<Punch[]> {
  const { data, error } = await supabase
    .from('punch')
    .select(COLS)
    .eq('project_id', projectId)
    .order('punch_no', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Punch[];
}

export interface CreatePunchInput {
  title: string;
  description?: string;
  location_desc?: string | null;
  severity: PunchSeverity;
  assignee_company?: string | null;
  assignee?: string | null;
  assignee_name?: string | null;
  global_id?: string | null;
  drawing_id?: string | null;
  pin_x?: number | null;
  pin_y?: number | null;
  pin_page?: number | null;
}

export async function createPunch(
  projectId: string,
  input: CreatePunchInput,
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const payload: Record<string, unknown> = {
    project_id: projectId,
    title: input.title,
    description: input.description ?? null,
    location_desc: input.location_desc || null,
    severity: input.severity,
    assignee_company: input.assignee_company || null,
    assignee: input.assignee ?? null,
    assignee_name: input.assignee_name || null,
    created_by: userData.user?.id ?? null,
    created_by_name: authorName,
  };
  if (input.global_id) payload.global_id = input.global_id;
  if (input.drawing_id) payload.drawing_id = input.drawing_id;
  if (input.pin_x != null) payload.pin_x = input.pin_x;
  if (input.pin_y != null) payload.pin_y = input.pin_y;
  if (input.pin_page != null) payload.pin_page = input.pin_page;

  const { data, error } = await supabase.from('punch').insert(payload).select('id, punch_no').single();
  if (error) throw error;
  const id = data.id as string;

  if (input.assignee) {
    await notify({
      projectId,
      recipients: [input.assignee],
      type: 'punch_assigned',
      title: `Punch 배정 #${data.punch_no}: ${input.title}`,
      body: input.assignee_company ? `협력사: ${input.assignee_company}` : undefined,
      actorName: authorName,
    });
  }
  return id;
}

export async function setPunchStatus(punch: Punch, status: PunchStatus, actorName: string | null): Promise<void> {
  if (punch.status === status) return;
  const { error } = await supabase
    .from('punch')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', punch.id);
  if (error) throw error;

  await notify({
    projectId: punch.project_id,
    recipients: [punch.assignee, punch.created_by],
    type: 'punch_status',
    title: `Punch 상태 변경 #${punch.punch_no}: ${punch.title}`,
    body: `${PUNCH_STATUS_LABEL[punch.status]} → ${PUNCH_STATUS_LABEL[status]}`,
    actorName,
  });
}

export async function assignPunch(
  punch: Punch,
  assigneeId: string | null,
  assigneeName: string | null,
  company: string | null,
  actorName: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('punch')
    .update({
      assignee: assigneeId,
      assignee_name: assigneeName,
      assignee_company: company,
      updated_at: new Date().toISOString(),
    })
    .eq('id', punch.id);
  if (error) throw error;

  if (assigneeId && assigneeId !== punch.assignee) {
    await notify({
      projectId: punch.project_id,
      recipients: [assigneeId],
      type: 'punch_assigned',
      title: `Punch 담당 배정 #${punch.punch_no}: ${punch.title}`,
      body: company ? `협력사: ${company}` : undefined,
      actorName,
    });
  }
}

export async function deletePunch(id: string): Promise<void> {
  const { error } = await supabase.from('punch').delete().eq('id', id);
  if (error) throw error;
}

/** 준공률(완료/전체) 집계. */
export interface PunchProgress {
  total: number;
  closed: number;
  ratio: number; // 0..1
}
export function punchProgress(punches: Punch[]): PunchProgress {
  const total = punches.length;
  const closed = punches.filter((p) => PUNCH_DONE_STATUSES.includes(p.status)).length;
  return { total, closed, ratio: total ? closed / total : 0 };
}
