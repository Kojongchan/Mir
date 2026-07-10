import { supabase } from './supabase';
import { notify } from './notifications';
import type { IssueType } from './issueTypes';

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
  /** 이슈 타입(0038) — general·rfi·punch·safety·quality. 미적용 DB 폴백 = general. */
  type: IssueType;
  /** 타입별 전용 필드(0038, jsonb) — RFI 상대처/응답기한/답변, 현장 GPS 태그(site) 등. */
  meta: Record<string, unknown>;
  /** 항목(공종·대상 분류, 0039) — issue_category FK. 미지정/미적용 = null. */
  category_id: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  model_id: string | null;
  express_id: number | null;
  /** APS GlobalId(=externalId) 앵커 — ACC 모델 3D 위치(0026). expressID 대체. */
  global_id: string | null;
  /** 간섭 이슈의 상대측(B) GlobalId — 위치보기에서 간섭뷰 복원(0028). */
  global_id_b: string | null;
  viewpoint_id: string | null;
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
  mentions: string[];
  created_at: string;
}

export type IssueEventKind =
  | 'created'
  | 'status'
  | 'assign'
  | 'content'
  | 'priority'
  | 'due'
  | 'file_add'
  | 'file_download'
  | 'comment'
  | 'meta'
  | 'viewpoint_add'
  | 'viewpoint_del'
  | 'category';
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
  'id, project_id, title, description, status, priority, assignee_id, assignee_name, due_date, model_id, express_id, global_id, global_id_b, viewpoint_id, created_by, created_by_name, created_at, updated_at';
// 0038(type·meta)/0039(category_id) 적용 수준별 조회 — 미적용이면 단계적으로 폴백.
const COLS_TYPED = `${COLS}, type, meta`;
const COLS_FULL = `${COLS_TYPED}, category_id`;

/** 신규 컬럼 미포함 행(0038/0039 미적용 폴백)에 기본값을 채워 Issue 로 정규화. */
function normalizeIssue(row: Record<string, unknown>): Issue {
  return {
    ...(row as unknown as Issue),
    type: ((row.type as string) || 'general') as IssueType,
    meta: (row.meta as Record<string, unknown>) ?? {},
    category_id: (row.category_id as string | null) ?? null,
  };
}

export async function listIssues(projectId: string): Promise<Issue[]> {
  // full(0039) → typed(0038) → legacy 순서로 시도.
  let rows: Record<string, unknown>[] | null = null;
  for (const cols of [COLS_FULL, COLS_TYPED, COLS]) {
    const res = await supabase
      .from('issues')
      .select(cols)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (!res.error) {
      rows = (res.data ?? []) as unknown as Record<string, unknown>[];
      break;
    }
    if (cols === COLS) throw res.error;
  }
  return (rows ?? []).map(normalizeIssue);
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
    type?: IssueType;
    meta?: Record<string, unknown>;
    category_id?: string | null;
    priority: IssuePriority;
    assignee_id?: string | null;
    assignee_name?: string;
    due_date?: string | null;
    model_id?: string | null;
    express_id?: number | null;
    global_id?: string | null;
    global_id_b?: string | null;
    viewpoint_id?: string | null;
  },
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const payload: Record<string, unknown> = {
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
  };
  // type/meta 는 0038, category_id 는 0039 컬럼 — 값이 있을 때만 포함(미적용 폴백).
  if (input.type && input.type !== 'general') payload.type = input.type;
  if (input.meta && Object.keys(input.meta).length) payload.meta = input.meta;
  if (input.category_id) payload.category_id = input.category_id;
  // viewpoint_id 는 0017 에서 추가된 컬럼 — 값이 있을 때만 포함(미적용 폴백).
  if (input.viewpoint_id) payload.viewpoint_id = input.viewpoint_id;
  // global_id 는 0026(APS 앵커) — 값이 있을 때만 포함(미적용 폴백).
  if (input.global_id) payload.global_id = input.global_id;
  // global_id_b 는 0028(간섭 이슈 B측) — 값이 있을 때만 포함.
  if (input.global_id_b) payload.global_id_b = input.global_id_b;
  const { data, error } = await supabase.from('issues').insert(payload).select('id').single();
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

/** 우선순위·마감일·내용 갱신 + 변경이력 기록(상태/담당자는 별도 함수). */
export async function updateIssueMeta(
  issue: Issue,
  fields: { priority?: IssuePriority; due_date?: string | null; description?: string | null },
  actorName: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('issues')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (error) throw error;

  if (fields.priority !== undefined && fields.priority !== issue.priority) {
    await logEvent(issue.id, issue.project_id, 'priority', PRIORITY_LABEL[issue.priority], PRIORITY_LABEL[fields.priority], actorName);
  }
  if (fields.due_date !== undefined && (fields.due_date ?? null) !== (issue.due_date ?? null)) {
    await logEvent(issue.id, issue.project_id, 'due', issue.due_date || '없음', fields.due_date || '없음', actorName);
  }
  if (fields.description !== undefined && (fields.description ?? '') !== (issue.description ?? '')) {
    await logEvent(issue.id, issue.project_id, 'content', null, '내용 수정', actorName);
  }
}

/** 항목(공종·대상 분류) 변경 + 변경이력('category') 기록. 0039 필요. */
export async function setIssueCategory(
  issue: Issue,
  categoryId: string | null,
  fromName: string,
  toName: string,
  actorName: string | null,
): Promise<void> {
  if ((issue.category_id ?? null) === (categoryId ?? null)) return;
  const { error } = await supabase
    .from('issues')
    .update({ category_id: categoryId, updated_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (error) throw error;
  await logEvent(issue.id, issue.project_id, 'category', fromName, toName, actorName);
}

/** 타입별 전용 필드(meta jsonb) 갱신 + 변경이력('meta') 기록. 0038 필요. */
export async function updateIssueTypeFields(
  issue: Issue,
  patch: Record<string, unknown>,
  changedLabel: string,
  actorName: string | null,
): Promise<void> {
  const meta = { ...issue.meta, ...patch };
  const { error } = await supabase
    .from('issues')
    .update({ meta, updated_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (error) throw error;
  await logEvent(issue.id, issue.project_id, 'meta', null, changedLabel, actorName);
}

/** 외부(첨부 링크·다운로드 등)에서 이슈 변경이력을 남기기 위한 공개 헬퍼. */
export async function logIssueEvent(
  issueId: string,
  projectId: string,
  kind: IssueEventKind,
  toValue: string | null,
  actorName: string | null,
): Promise<void> {
  await logEvent(issueId, projectId, kind, null, toValue, actorName);
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
    .select('id, issue_id, body, author_name, mentions, created_at')
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((c) => ({ ...c, mentions: (c.mentions as string[]) ?? [] })) as IssueComment[];
}

export async function addComment(
  issue: Issue,
  body: string,
  authorName: string | null,
  mentions: string[] = [],
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('issue_comments').insert({
    issue_id: issue.id,
    body,
    author: userData.user?.id ?? null,
    author_name: authorName,
    mentions,
  });
  if (error) throw error;

  const preview = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  await logEvent(issue.id, issue.project_id, 'comment', null, preview, authorName);
  // @멘션 대상엔 멘션 알림, 담당자·작성자(멘션 제외)엔 코멘트 알림.
  if (mentions.length) {
    await notify({
      projectId: issue.project_id,
      recipients: mentions,
      type: 'issue_mention',
      title: `이슈 코멘트에서 멘션: ${issue.title}`,
      body: preview,
      issueId: issue.id,
      actorName: authorName,
    });
  }
  await notify({
    projectId: issue.project_id,
    recipients: [issue.assignee_id, issue.created_by].filter((r) => !r || !mentions.includes(r)),
    type: 'issue_comment',
    title: `이슈 새 코멘트: ${issue.title}`,
    body: preview,
    issueId: issue.id,
    actorName: authorName,
  });
}

// ---------- 읽음/안읽음 (issue_read, 0033) --------------------------

/** 이슈 상세를 지금 읽음으로 표시(사용자별 upsert). 미적용(0033 전)이면 무시. */
export async function markIssueRead(issueId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return;
  try {
    await supabase
      .from('issue_read')
      .upsert(
        { issue_id: issueId, user_id: uid, last_read_at: new Date().toISOString() },
        { onConflict: 'issue_id,user_id' },
      );
  } catch {
    /* non-fatal — 읽음 표시는 편의 레이어 */
  }
}

/**
 * 주어진 이슈들 중 "안읽음"(내 마지막 열람 이후 새 코멘트가 있는) 이슈 id 집합.
 * 코멘트가 있고 한 번도 안 읽었거나, 마지막 열람보다 최신 코멘트가 있으면 안읽음.
 */
export async function listUnreadIssues(issueIds: string[]): Promise<Set<string>> {
  const unread = new Set<string>();
  if (issueIds.length === 0) return unread;
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return unread;

  const [{ data: comments }, { data: reads }] = await Promise.all([
    supabase.from('issue_comments').select('issue_id, created_at').in('issue_id', issueIds),
    supabase.from('issue_read').select('issue_id, last_read_at').eq('user_id', uid).in('issue_id', issueIds),
  ]);

  const lastRead = new Map<string, string>();
  for (const r of (reads ?? []) as { issue_id: string; last_read_at: string }[]) {
    lastRead.set(r.issue_id, r.last_read_at);
  }
  for (const c of (comments ?? []) as { issue_id: string; created_at: string }[]) {
    const seen = lastRead.get(c.issue_id);
    if (!seen || new Date(c.created_at) > new Date(seen)) unread.add(c.issue_id);
  }
  return unread;
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
