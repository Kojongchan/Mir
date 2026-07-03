import { supabase } from './supabase';
import { notify } from './notifications';

// =====================================================================
// R4+R5 — ISO 19650 승인 워크플로우 + Submittals 데이터층.
// ★ 상태전환은 반드시 서버측 RPC(rpc_submittal_transition / rpc_file_status_transition)
//   를 통해서만 수행한다. 이 파일의 어떤 함수도 status 를 직접 UPDATE 하지 않는다.
//   (DB 가드 트리거가 직접 전환을 거부하므로, 클라이언트를 신뢰하지 않아도 안전하다.)
// 재사용: notifications(내차례/반려 알림) · approval_flow 감사로그.
// =====================================================================

export type SubmittalStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'conditional'
  | 'rejected'
  | 'closed';

export const SUBMITTAL_STATUS_LABEL: Record<SubmittalStatus, string> = {
  draft: '작성',
  submitted: '제출',
  under_review: '검토중',
  approved: '승인',
  conditional: '조건부승인',
  rejected: '반려',
  closed: '완료',
};

/** 진행중(ball-in-court 병목 대상) 상태. */
export const SUBMITTAL_OPEN_STATUSES: SubmittalStatus[] = [
  'draft',
  'submitted',
  'under_review',
  'conditional',
  'rejected',
];

export type SubmittalAction =
  | 'submit'
  | 'start_review'
  | 'approve'
  | 'conditional'
  | 'reject'
  | 'resubmit'
  | 'close';

export const ACTION_LABEL: Record<SubmittalAction, string> = {
  submit: '제출',
  start_review: '검토 착수',
  approve: '승인',
  conditional: '조건부 승인',
  reject: '반려',
  resubmit: '재제출(리비전)',
  close: '완료 처리',
};

/** 현재 상태에서 가능한 액션 목록(UI 버튼 노출용 — 서버가 최종 검증). */
export function allowedActions(status: SubmittalStatus): SubmittalAction[] {
  switch (status) {
    case 'draft':
      return ['submit'];
    case 'submitted':
      return ['start_review'];
    case 'under_review':
      return ['approve', 'conditional', 'reject'];
    case 'conditional':
      return ['resubmit', 'close'];
    case 'rejected':
      return ['resubmit'];
    case 'approved':
      return ['close'];
    case 'closed':
      return [];
  }
}

/** 승인권자(프로젝트 관리자) 또는 볼 보유자만 수행 가능한 결정성 액션. */
export const APPROVER_ACTIONS: SubmittalAction[] = ['start_review', 'approve', 'conditional', 'reject'];

export interface Submittal {
  id: string;
  project_id: string;
  submittal_no: number;
  title: string;
  type: string | null;
  spec_section: string | null;
  status: SubmittalStatus;
  revision_no: number;
  current_holder: string | null;
  current_holder_name: string | null;
  file_id: string | null;
  due_date: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  held_since: string;
}

export type ApprovalDecision = 'approved' | 'conditional' | 'rejected' | 'resubmit' | 'transition';

export interface ApprovalEntry {
  id: string;
  project_id: string;
  target_type: 'file' | 'model' | 'submittal';
  target_id: string;
  from_state: string | null;
  to_state: string;
  approver: string | null;
  approver_name: string | null;
  decision: ApprovalDecision;
  comment: string | null;
  created_at: string;
}

const SUB_COLS =
  'id, project_id, submittal_no, title, type, spec_section, status, revision_no, current_holder, current_holder_name, file_id, due_date, created_by, created_by_name, created_at, updated_at, held_since';

export async function listSubmittals(projectId: string): Promise<Submittal[]> {
  const { data, error } = await supabase
    .from('submittal')
    .select(SUB_COLS)
    .eq('project_id', projectId)
    .order('submittal_no', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Submittal[];
}

export interface CreateSubmittalInput {
  title: string;
  type?: string | null;
  spec_section?: string | null;
  file_id?: string | null;
  due_date?: string | null;
  current_holder?: string | null;
  current_holder_name?: string | null;
}

export async function createSubmittal(
  projectId: string,
  input: CreateSubmittalInput,
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('submittal')
    .insert({
      project_id: projectId,
      title: input.title,
      type: input.type || null,
      spec_section: input.spec_section || null,
      file_id: input.file_id ?? null,
      due_date: input.due_date || null,
      current_holder: input.current_holder ?? userData.user?.id ?? null,
      current_holder_name: input.current_holder_name ?? authorName,
      created_by: userData.user?.id ?? null,
      created_by_name: authorName,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** 메타(제목·유형·기한·파일)만 수정 — status 는 건드리지 않는다(가드 트리거 준수). */
export async function updateSubmittalMeta(
  id: string,
  patch: Partial<Pick<CreateSubmittalInput, 'title' | 'type' | 'spec_section' | 'file_id' | 'due_date'>>,
): Promise<void> {
  const { error } = await supabase.from('submittal').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function deleteSubmittal(id: string): Promise<void> {
  const { error } = await supabase.from('submittal').delete().eq('id', id);
  if (error) throw error;
}

/**
 * ★ 서버측 상태전환. RPC 가 상태머신·권한을 검증하고 감사로그를 남긴다.
 * 실패(불법 전환·권한 부족)는 예외로 전달된다. 성공 시 다음 볼 보유자에게 알림.
 */
export async function transitionSubmittal(
  sub: Submittal,
  action: SubmittalAction,
  comment: string | null,
  nextHolder: string | null,
  actorName: string | null,
): Promise<SubmittalStatus> {
  const { data, error } = await supabase.rpc('rpc_submittal_transition', {
    p_id: sub.id,
    p_action: action,
    p_comment: comment,
    p_next_holder: nextHolder,
  });
  if (error) throw error;
  const newStatus = data as SubmittalStatus;

  // 내차례/반려 알림 — 다음 볼 보유자(또는 반려 시 제출자)에게.
  const recipient = nextHolder ?? (APPROVER_ACTIONS.includes(action) ? sub.created_by : sub.current_holder);
  await notify({
    projectId: sub.project_id,
    recipients: [recipient],
    type: action === 'reject' ? 'submittal_rejected' : 'submittal_turn',
    title: `제출물 #${sub.submittal_no} ${ACTION_LABEL[action]}: ${sub.title}`,
    body: comment ? comment.slice(0, 80) : `${SUBMITTAL_STATUS_LABEL[sub.status]} → ${SUBMITTAL_STATUS_LABEL[newStatus]}`,
    actorName,
  });
  return newStatus;
}

/** 파일 ISO19650 라이프사이클 전환(승인 게이트) — 서버 RPC. */
export async function fileStatusTransition(fileId: string, to: string, comment: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_file_status_transition', {
    p_file_id: fileId,
    p_to: to,
    p_comment: comment,
  });
  if (error) throw error;
  return data as string;
}

/** 대상(제출물·파일)의 감사로그 타임라인(오래된→최신). */
export async function listApprovalFlow(
  targetType: 'file' | 'model' | 'submittal',
  targetId: string,
): Promise<ApprovalEntry[]> {
  const { data, error } = await supabase
    .from('approval_flow')
    .select('id, project_id, target_type, target_id, from_state, to_state, approver, approver_name, decision, comment, created_at')
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ApprovalEntry[];
}

/** 프로젝트 전체 최근 승인 활동(감사 대시보드용). */
export async function listProjectApprovals(projectId: string, limit = 100): Promise<ApprovalEntry[]> {
  const { data, error } = await supabase
    .from('approval_flow')
    .select('id, project_id, target_type, target_id, from_state, to_state, approver, approver_name, decision, comment, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ApprovalEntry[];
}

/** ball-in-court 보유 일수(현 상태 진입 후 경과일). 종결 상태는 null. */
export function daysInCourt(sub: Submittal): number | null {
  if (!SUBMITTAL_OPEN_STATUSES.includes(sub.status)) return null;
  const since = new Date(sub.held_since).getTime();
  return Math.floor((Date.now() - since) / 86_400_000);
}

/** SLA 지연 여부(due_date 초과 & 미종결). */
export function isOverdue(sub: Submittal): boolean {
  if (!sub.due_date || !SUBMITTAL_OPEN_STATUSES.includes(sub.status)) return false;
  const d = new Date(sub.due_date + 'T00:00:00').getTime();
  return d < Date.now();
}
