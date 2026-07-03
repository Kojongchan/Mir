import { supabase } from './supabase';
import { notify } from './notifications';

// =====================================================================
// RFI(정보요청서) 관리 데이터층 (R1).
// 이슈(issues.ts) 패턴을 그대로 따른다: 상태 워크플로우 + 담당 배정 + 활동 이력 +
// 인앱 알림 + SLA(기한) 계산. 첨부는 attachments(target_type='rfi') 재사용,
// 3D 위치는 APS GlobalId 앵커(0026 이슈 핀 인프라) 재사용.
// 0032 미적용 환경에서도 앱이 깨지지 않도록 조회 실패는 호출부에서 폴백 처리한다.
// =====================================================================

export type RfiStatus = 'open' | 'answered' | 'void' | 'closed';
export type RfiPriority = 'low' | 'normal' | 'high' | 'urgent';

export const RFI_STATUSES: RfiStatus[] = ['open', 'answered', 'closed', 'void'];
export const RFI_PRIORITIES: RfiPriority[] = ['low', 'normal', 'high', 'urgent'];

export const RFI_STATUS_LABEL: Record<RfiStatus, string> = {
  open: '접수',
  answered: '답변',
  closed: '종료',
  void: '무효',
};
export const RFI_PRIORITY_LABEL: Record<RfiPriority, string> = {
  low: '낮음',
  normal: '보통',
  high: '높음',
  urgent: '긴급',
};

/** 상대처(정보 요청 방향). */
export const RFI_PARTIES = ['발주처', '감리', '설계', '시공'] as const;
/** 공종(디시플린) 기본 후보. */
export const RFI_DISCIPLINES = ['건축', '구조', '기계', '전기', '토목', '조경', '소방', '기타'] as const;

/** 미해결로 간주하는 상태(SLA·대시보드 계산용). */
export const RFI_OPEN_STATUSES: RfiStatus[] = ['open'];

export interface Rfi {
  id: string;
  project_id: string;
  rfi_no: number;
  title: string;
  question: string | null;
  discipline: string | null;
  from_party: string | null;
  to_assignee: string | null;
  to_assignee_name: string | null;
  status: RfiStatus;
  priority: RfiPriority;
  due_date: string | null;
  answered_at: string | null;
  answer: string | null;
  global_id: string | null;
  drawing_id: string | null;
  pin_x: number | null;
  pin_y: number | null;
  pin_page: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface RfiComment {
  id: string;
  rfi_id: string;
  body: string;
  author_name: string | null;
  created_at: string;
}

export type RfiEventKind = 'created' | 'status' | 'assign' | 'answer';
export interface RfiEvent {
  id: string;
  rfi_id: string;
  kind: RfiEventKind;
  from_value: string | null;
  to_value: string | null;
  actor_name: string | null;
  created_at: string;
}

const COLS =
  'id, project_id, rfi_no, title, question, discipline, from_party, to_assignee, to_assignee_name, status, priority, due_date, answered_at, answer, global_id, drawing_id, pin_x, pin_y, pin_page, created_by, created_by_name, created_at, updated_at';

export async function listRfis(projectId: string): Promise<Rfi[]> {
  const { data, error } = await supabase
    .from('rfi')
    .select(COLS)
    .eq('project_id', projectId)
    .order('rfi_no', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Rfi[];
}

/** 미응답(open) RFI 수 — 대시보드/배지용. */
export async function countOpenRfis(projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('rfi')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .in('status', RFI_OPEN_STATUSES);
  if (error) throw error;
  return count ?? 0;
}

export interface CreateRfiInput {
  title: string;
  question?: string;
  discipline?: string | null;
  from_party?: string | null;
  to_assignee?: string | null;
  to_assignee_name?: string | null;
  priority: RfiPriority;
  due_date?: string | null;
  global_id?: string | null;
  drawing_id?: string | null;
  pin_x?: number | null;
  pin_y?: number | null;
  pin_page?: number | null;
}

export async function createRfi(
  projectId: string,
  input: CreateRfiInput,
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const payload: Record<string, unknown> = {
    project_id: projectId,
    title: input.title,
    question: input.question ?? null,
    discipline: input.discipline || null,
    from_party: input.from_party || null,
    to_assignee: input.to_assignee ?? null,
    to_assignee_name: input.to_assignee_name || null,
    priority: input.priority,
    due_date: input.due_date || null,
    created_by: userData.user?.id ?? null,
    created_by_name: authorName,
  };
  if (input.global_id) payload.global_id = input.global_id;
  if (input.drawing_id) payload.drawing_id = input.drawing_id;
  if (input.pin_x != null) payload.pin_x = input.pin_x;
  if (input.pin_y != null) payload.pin_y = input.pin_y;
  if (input.pin_page != null) payload.pin_page = input.pin_page;

  const { data, error } = await supabase.from('rfi').insert(payload).select('id, rfi_no').single();
  if (error) throw error;
  const rfiId = data.id as string;

  await logEvent(rfiId, projectId, 'created', null, input.title, authorName);
  if (input.to_assignee) {
    await notify({
      projectId,
      recipients: [input.to_assignee],
      type: 'rfi_assigned',
      title: `RFI 배정 #${data.rfi_no}: ${input.title}`,
      body: input.to_assignee_name ? `담당자: ${input.to_assignee_name}` : undefined,
      actorName: authorName,
    });
  }
  return rfiId;
}

/** 상태 전이 + 이력 + 알림. 'answered' 로 갈 때 answered_at 을 채운다. */
export async function setRfiStatus(rfi: Rfi, status: RfiStatus, actorName: string | null): Promise<void> {
  if (rfi.status === status) return;
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === 'answered' && !rfi.answered_at) patch.answered_at = new Date().toISOString();
  const { error } = await supabase.from('rfi').update(patch).eq('id', rfi.id);
  if (error) throw error;

  await logEvent(rfi.id, rfi.project_id, 'status', RFI_STATUS_LABEL[rfi.status], RFI_STATUS_LABEL[status], actorName);
  await notify({
    projectId: rfi.project_id,
    recipients: [rfi.to_assignee, rfi.created_by],
    type: 'rfi_status',
    title: `RFI 상태 변경 #${rfi.rfi_no}: ${rfi.title}`,
    body: `${RFI_STATUS_LABEL[rfi.status]} → ${RFI_STATUS_LABEL[status]}`,
    actorName,
  });
}

/** 응답 저장(+ 상태를 answered 로) + 이력 + 요청자 알림. */
export async function answerRfi(rfi: Rfi, answer: string, actorName: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('rfi')
    .update({ answer, answered_at: now, status: 'answered', updated_at: now })
    .eq('id', rfi.id);
  if (error) throw error;

  await logEvent(rfi.id, rfi.project_id, 'answer', null, answer.slice(0, 80), actorName);
  await notify({
    projectId: rfi.project_id,
    recipients: [rfi.created_by],
    type: 'rfi_answered',
    title: `RFI 응답 등록 #${rfi.rfi_no}: ${rfi.title}`,
    body: answer.length > 60 ? `${answer.slice(0, 60)}…` : answer,
    actorName,
  });
}

/** 담당자 배정 변경 + 이력 + 새 담당자 알림. */
export async function assignRfi(
  rfi: Rfi,
  assigneeId: string | null,
  assigneeName: string | null,
  actorName: string | null,
): Promise<void> {
  if ((rfi.to_assignee ?? null) === (assigneeId ?? null)) return;
  const { error } = await supabase
    .from('rfi')
    .update({ to_assignee: assigneeId, to_assignee_name: assigneeName, updated_at: new Date().toISOString() })
    .eq('id', rfi.id);
  if (error) throw error;

  await logEvent(rfi.id, rfi.project_id, 'assign', rfi.to_assignee_name || '없음', assigneeName || '없음', actorName);
  if (assigneeId) {
    await notify({
      projectId: rfi.project_id,
      recipients: [assigneeId],
      type: 'rfi_assigned',
      title: `RFI 담당자 배정 #${rfi.rfi_no}: ${rfi.title}`,
      body: assigneeName ? `담당자: ${assigneeName}` : undefined,
      actorName,
    });
  }
}

export async function deleteRfi(id: string): Promise<void> {
  const { error } = await supabase.from('rfi').delete().eq('id', id);
  if (error) throw error;
}

async function logEvent(
  rfiId: string,
  projectId: string,
  kind: RfiEventKind,
  fromValue: string | null,
  toValue: string | null,
  actorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  try {
    await supabase.from('rfi_events').insert({
      rfi_id: rfiId,
      project_id: projectId,
      kind,
      from_value: fromValue,
      to_value: toValue,
      actor: userData.user?.id ?? null,
      actor_name: actorName,
    });
  } catch {
    /* non-fatal — 이력은 편의 레이어 */
  }
}

export async function listRfiEvents(rfiId: string): Promise<RfiEvent[]> {
  const { data, error } = await supabase
    .from('rfi_events')
    .select('id, rfi_id, kind, from_value, to_value, actor_name, created_at')
    .eq('rfi_id', rfiId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RfiEvent[];
}

export async function listRfiComments(rfiId: string): Promise<RfiComment[]> {
  const { data, error } = await supabase
    .from('rfi_comments')
    .select('id, rfi_id, body, author_name, created_at')
    .eq('rfi_id', rfiId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function addRfiComment(rfi: Rfi, body: string, authorName: string | null): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('rfi_comments').insert({
    rfi_id: rfi.id,
    body,
    author: userData.user?.id ?? null,
    author_name: authorName,
  });
  if (error) throw error;

  await notify({
    projectId: rfi.project_id,
    recipients: [rfi.to_assignee, rfi.created_by],
    type: 'rfi_comment',
    title: `RFI 새 코멘트 #${rfi.rfi_no}: ${rfi.title}`,
    body: body.length > 60 ? `${body.slice(0, 60)}…` : body,
    actorName: authorName,
  });
}

// ---------- SLA(응답 기한) 상태 -------------------------------------

export type RfiDueState = 'overdue' | 'soon' | 'normal' | 'none';

/** 기한과 상태로 임박/지연 계산. 종결(answered/closed/void)된 RFI 는 'none'. */
export function rfiDueState(due: string | null, status: RfiStatus, soonDays = 3): RfiDueState {
  if (!due) return 'none';
  if (status !== 'open') return 'none';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= soonDays) return 'soon';
  return 'normal';
}

export const RFI_DUE_LABEL: Record<Exclude<RfiDueState, 'none' | 'normal'>, string> = {
  overdue: '지연',
  soon: '임박',
};

/** 기한까지 남은 일수 D-표기. */
export function rfiDueDeltaLabel(due: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return 'D-day';
  return diffDays > 0 ? `D-${diffDays}` : `D+${-diffDays}`;
}
