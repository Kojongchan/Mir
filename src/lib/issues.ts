import { supabase } from './supabase';

// =====================================================================
// 협업 · 이슈/지적 관리 데이터층 (Phase 12 / S22).
// =====================================================================

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type IssuePriority = 'low' | 'normal' | 'high' | 'urgent';

export const ISSUE_STATUSES: IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
export const ISSUE_PRIORITIES: IssuePriority[] = ['low', 'normal', 'high', 'urgent'];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: '미해결',
  in_progress: '진행중',
  resolved: '해결',
  closed: '종료',
};
export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  low: '낮음',
  normal: '보통',
  high: '높음',
  urgent: '긴급',
};

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_name: string | null;
  due_date: string | null;
  model_id: string | null;
  express_id: number | null;
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

const COLS =
  'id, project_id, title, description, status, priority, assignee_name, due_date, model_id, express_id, created_by_name, created_at, updated_at';

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
    .in('status', ['open', 'in_progress']);
  if (error) throw error;
  return count ?? 0;
}

export async function createIssue(
  projectId: string,
  input: {
    title: string;
    description?: string;
    priority: IssuePriority;
    assignee_name?: string;
    due_date?: string | null;
    model_id?: string | null;
    express_id?: number | null;
  },
  authorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('issues').insert({
    project_id: projectId,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority,
    assignee_name: input.assignee_name || null,
    due_date: input.due_date || null,
    model_id: input.model_id ?? null,
    express_id: input.express_id ?? null,
    created_by: userData.user?.id ?? null,
    created_by_name: authorName,
  });
  if (error) throw error;
}

export async function setIssueStatus(id: string, status: IssueStatus): Promise<void> {
  const { error } = await supabase
    .from('issues')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteIssue(id: string): Promise<void> {
  const { error } = await supabase.from('issues').delete().eq('id', id);
  if (error) throw error;
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
  issueId: string,
  body: string,
  authorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('issue_comments').insert({
    issue_id: issueId,
    body,
    author: userData.user?.id ?? null,
    author_name: authorName,
  });
  if (error) throw error;
}
