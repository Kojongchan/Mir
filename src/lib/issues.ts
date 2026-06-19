import { supabase } from './supabase';
import { notify } from './notifications';

// =====================================================================
// 협업 · 이슈/지적 관리 데이터층 (Phase 12 / S22, 워크플로우 확장 S30).
// =====================================================================

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | 'on_hold';
export type IssuePriority = 'low' | 'normal' | 'high' | 'urgent';

export const ISSUE_STATUSES: IssueStatus[] = [
  'open',
  'in_progress',
  'resolved',
  'closed',
  'on_hold',
];
export const ISSUE_PRIORITIES: IssuePriority[] = ['low', 'normal', 'high', 'urgent'];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: '신규',
  in_progress: '진행',
  resolved: '완료',
  closed: '종료',
  on_hold: '보류',
};
export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  low: '낮음',
  normal: '보통',
  high: '높음',
  urgent: '긴급',
};

/** 미해결로 간주하는 상태(대시보드 카드·마감 임박 계산용). */
export const OPEN_STATUSES: IssueStatus[] = ['open', 'in_progress', 'on_hold'];

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  model_id: string | null;
  express_id: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  body: string;
  author_name: string | null;
  created_at: string;
}

export type IssueEventKind = 'created' | 'status' | 'assign';
export interface IssueEvent {
  id: string;
  issue_id: string;
  kind: IssueEventKind;
  from_value: string | null;
  to_value: string | null;
  actor_name: string | null;
  created_at: string;
}

const COLS =
  'id, project_id, title, description, status, priority, assignee_id, assignee_name, due_date, model_id, express_id, created_by, created_by_name, created_at, updated_at';

export async function listIssues(projectId: string): Promise<Issue[]> {
  const { data, error } = await supabase
    .from('issues')
    .select(COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Issue[];
}

/** Count of issues not yet closed/resolved — for the dashboard card. */
export async function countOpenIssues(projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('issues')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .in('status', OPEN_STATUSES);
  if (error) throw error;
  return count ?? 0;
}

export async function createIssue(
  projectId: string,
  input: {
    title: string;
    description?: string;
    priority: IssuePriority;
    assignee_id?: string | null;
    assignee_name?: string;
    due_date?: string | null;
    model_id?: string | null;
    express_id?: number | null;
  },
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('issues')
    .insert({
      project_id: projectId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      assignee_id: input.assignee_id ?? null,
      assignee_name: input.assignee_name || null,
      due_date: input.due_date || null,
      model_id: input.model_id ?? null,
      express_id: input.express_id ?? null,
      created_by: userData.user?.id ?? null,
      created_by_name: authorName,
    })
    .select('id')
    .single();
  if (error) throw error;

  const issueId = data.id as string;
  await logEvent(issueId, projectId, 'created', null, input.title, authorName);
  if (input.assignee_id) {
    await notify({
      projectId,
      recipients: [input.assignee_id],
      type: 'issue_assigned',
      title: `새 이슈 배정: ${input.title}`,
      body: input.assignee_name ? `담당자: ${input.assignee_name}` : undefined,
      issueId,
      actorName: authorName,
    });
  }
  return issueId;
}

/** 상태 전이 + 이력 기록 + 담당자/작성자 알림. */
export async function setIssueStatus(issue: Issue, status: IssueStatus, actorName: string | null): Promise<void> {
  if (issue.status === status) return;
  const { error } = await supabase
    .from('issues')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (error) throw error;

  await logEvent(issue.id, issue.project_id, 'status', STATUS_LABEL[issue.status], STATUS_LABEL[status], actorName);
  await notify({
    projectId: issue.project_id,
    recipients: [issue.assignee_id, issue.created_by],
    type: 'issue_status',
    title: `이슈 상태 변경: ${issue.title}`,
    body: `${STATUS_LABEL[issue.status]} → ${STATUS_LABEL[status]}`,
    issueId: issue.id,
    actorName,
  });
}

/** 담당자 배정 변경 + 이력 + 새 담당자 알림. */
export async function assignIssue(
  issue: Issue,
  assigneeId: string | null,
  assigneeName: string | null,
  actorName: string | null,
): Promise<void> {
  if ((issue.assignee_id ?? null) === (assigneeId ?? null)) return;
  const { error } = await supabase
    .from('issues')
    .update({
      assignee_id: assigneeId,
      assignee_name: assigneeName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', issue.id);
  if (error) throw error;

  await logEvent(
    issue.id,
    issue.project_id,
    'assign',
    issue.assignee_name || '없음',
    assigneeName || '없음',
    actorName,
  );
  if (assigneeId) {
    await notify({
      projectId: issue.project_id,
      recipients: [assigneeId],
      type: 'issue_assigned',
      title: `이슈 담당자 배정: ${issue.title}`,
      body: assigneeName ? `담당자: ${assigneeName}` : undefined,
      issueId: issue.id,
      actorName,
    });
  }
}

export async function deleteIssue(id: string): Promise<void> {
  const { error } = await supabase.from('issues').delete().eq('id', id);
  if (error) throw error;
}

async function logEvent(
  issueId: string,
  projectId: string,
  kind: IssueEventKind,
  fromValue: string | null,
  toValue: string | null,
  actorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  try {
    await supabase.from('issue_events').insert({
      issue_id: issueId,
      project_id: projectId,
      kind,
      from_value: fromValue,
      to_value: toValue,
      actor: userData.user?.id ?? null,
      actor_name: actorName,
    });
  } catch {
    /* non-fatal — history is a convenience layer */
  }
}

export async function listEvents(issueId: string): Promise<IssueEvent[]> {
  const { data, error } = await supabase
    .from('issue_events')
    .select('id, issue_id, kind, from_value, to_value, actor_name, created_at')
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as IssueEvent[];
}

export async function listComments(issueId: string): Promise<IssueComment[]> {
  const { data, error } = await supabase
    .from('issue_comments')
    .select('id, issue_id, body, author_name, created_at')
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function addComment(
  issue: Issue,
  body: string,
  authorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('issue_comments').insert({
    issue_id: issue.id,
    body,
    author: userData.user?.id ?? null,
    author_name: authorName,
  });
  if (error) throw error;

  await notify({
    projectId: issue.project_id,
    recipients: [issue.assignee_id, issue.created_by],
    type: 'issue_comment',
    title: `이슈 새 코멘트: ${issue.title}`,
    body: body.length > 60 ? `${body.slice(0, 60)}…` : body,
    issueId: issue.id,
    actorName: authorName,
  });
}

// ---------- 마감일 상태(임박/지연) ----------------------------------

export type DueState = 'overdue' | 'soon' | 'normal' | 'none';

/** 마감일과 상태로 임박/지연 여부를 계산. 완료/종료된 이슈는 'none'. */
export function dueState(due: string | null, status: IssueStatus, soonDays = 3): DueState {
  if (!due) return 'none';
  if (status === 'resolved' || status === 'closed') return 'none';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= soonDays) return 'soon';
  return 'normal';
}

export const DUE_LABEL: Record<Exclude<DueState, 'none' | 'normal'>, string> = {
  overdue: '지연',
  soon: '임박',
};

/** 마감까지 남은 일수 텍스트(D-표기). */
export function dueDeltaLabel(due: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return 'D-day';
  return diffDays > 0 ? `D-${diffDays}` : `D+${-diffDays}`;
}
