import { supabase } from './supabase';

// =====================================================================
// 인앱 알림 데이터층 (S30 이슈 워크플로우).
// 이슈 상태 변경·담당자 배정·코멘트 시 수신자(담당자·작성자)에게 알림을 남긴다.
// notifications RLS: 본인 것만 읽기/표시변경, 생성은 프로젝트 멤버.
// =====================================================================

export type NotificationType =
  | 'issue_status'
  | 'issue_assigned'
  | 'issue_comment'
  | 'clash_assigned'
  | 'clash_comment'
  | 'clash_mention'
  | 'clash_status';

export interface AppNotification {
  id: string;
  project_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  issue_id: string | null;
  clash_id: string | null;
  actor_name: string | null;
  is_read: boolean;
  created_at: string;
}

const COLS =
  'id, project_id, user_id, type, title, body, issue_id, clash_id, actor_name, is_read, created_at';

/** Recent notifications for the signed-in user (newest first). */
export async function listNotifications(limit = 30): Promise<AppNotification[]> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from('notifications')
    .select(COLS)
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AppNotification[];
}

export async function countUnread(): Promise<number> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return 0;
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', uid)
    .eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
}

export async function markRead(id: string): Promise<void> {
  const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  if (error) throw error;
}

export async function markAllRead(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', uid)
    .eq('is_read', false);
  if (error) throw error;
}

interface NotifyInput {
  projectId: string;
  recipients: (string | null | undefined)[]; // user ids (담당자·작성자 등)
  type: NotificationType;
  title: string;
  body?: string;
  issueId?: string;
  clashId?: string;
  actorName?: string | null;
}

/**
 * Insert a notification for each distinct recipient, skipping the actor itself
 * and empty ids. Best-effort: failures (e.g. 0013 not applied) are swallowed so
 * the primary action (status change) still succeeds.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const actorId = userData.user?.id;
  const targets = Array.from(
    new Set(input.recipients.filter((r): r is string => !!r && r !== actorId)),
  );
  if (targets.length === 0) return;
  const rows = targets.map((user_id) => ({
    project_id: input.projectId,
    user_id,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    issue_id: input.issueId ?? null,
    clash_id: input.clashId ?? null,
    actor_name: input.actorName ?? null,
  }));
  try {
    await supabase.from('notifications').insert(rows);
  } catch {
    /* non-fatal — notifications are a convenience layer */
  }
}
