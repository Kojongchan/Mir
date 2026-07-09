import { supabase } from './supabase';
import { notify } from './notifications';
import type { ClashStatus } from './clash';

// =====================================================================
// 간섭 코디네이션 룸 데이터층 (migration 0032_clash_coordination.sql).
// "플랫폼 내 완결": 담당 배정 · 기한 · 코멘트 스레드(@멘션·읽음) · 해소→검증 이력을
// 전부 우리 DB(clashes 확장 + clash_comment + clash_read)에 남긴다. 알림은
// notifications(clash_id) 재사용. 저장된 간섭(clashes.id, dbBacked)에만 붙는다.
// =====================================================================

/** 간섭 상태 흐름: 신규(open) → 검토중(진행) → 해결(해소) → 승인(검증완료). */
export const CLASH_FLOW: ClashStatus[] = ['new', 'reviewing', 'resolved', 'approved'];

export interface ClashComment {
  id: string;
  clash_id: string;
  author: string | null;
  author_name: string | null;
  body: string;
  mentions: string[];
  created_at: string;
}

/** 저장된 간섭 한 건의 협의 상태(담당·기한·해소/검증 감사). */
export interface ClashCoordination {
  id: string; // clashes.id
  assignee: string | null;
  assignee_label: string | null;
  due_date: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  status: ClashStatus;
}

/** 리스트 행 뱃지용 경량 요약(담당·기한·코멘트 수·미읽음). */
export interface ClashCoordSummary {
  assignee: string | null;
  assignee_label: string | null;
  due_date: string | null;
  status: ClashStatus;
  commentCount: number;
  unread: boolean;
}

const COORD_COLS =
  'id, assignee, assignee_label, due_date, resolved_by, resolved_at, verified_by, verified_at, status';

async function myId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ---------- 협의 상태 조회 -------------------------------------------

export async function getClashCoordination(clashDbId: string): Promise<ClashCoordination | null> {
  const { data, error } = await supabase
    .from('clashes')
    .select(COORD_COLS)
    .eq('id', clashDbId)
    .single();
  if (error) throw error;
  return (data ?? null) as ClashCoordination | null;
}

/**
 * 한 테스트의 모든 간섭에 대한 협의 요약(담당·기한·코멘트 수·미읽음)을 clash_id 로
 * 인덱싱해 돌려준다. 리스트 뱃지 렌더용 — 코멘트/읽음은 별도 질의로 집계한다.
 */
export async function listCoordSummaries(testId: string): Promise<Map<string, ClashCoordSummary>> {
  const out = new Map<string, ClashCoordSummary>();
  const { data: base, error } = await supabase
    .from('clashes')
    .select('id, assignee, assignee_label, due_date, status')
    .eq('test_id', testId);
  if (error) throw error;
  const ids = (base ?? []).map((r) => r.id as string);
  for (const r of base ?? []) {
    out.set(r.id as string, {
      assignee: (r.assignee as string) ?? null,
      assignee_label: (r.assignee_label as string) ?? null,
      due_date: (r.due_date as string) ?? null,
      status: r.status as ClashStatus,
      commentCount: 0,
      unread: false,
    });
  }
  if (ids.length === 0) return out;

  const [{ data: comments }, { data: reads }] = await Promise.all([
    supabase.from('clash_comment').select('clash_id, created_at').in('clash_id', ids),
    (async () => {
      const uid = await myId();
      if (!uid) return { data: [] as { clash_id: string; last_read_at: string }[] };
      return supabase
        .from('clash_read')
        .select('clash_id, last_read_at')
        .eq('user_id', uid)
        .in('clash_id', ids);
    })(),
  ]);

  const readAt = new Map<string, string>();
  for (const r of (reads ?? []) as { clash_id: string; last_read_at: string }[]) {
    readAt.set(r.clash_id, r.last_read_at);
  }
  for (const c of (comments ?? []) as { clash_id: string; created_at: string }[]) {
    const s = out.get(c.clash_id);
    if (!s) continue;
    s.commentCount += 1;
    const last = readAt.get(c.clash_id);
    if (!last || new Date(c.created_at) > new Date(last)) s.unread = true;
  }
  return out;
}

// ---------- 담당 배정 · 기한 -----------------------------------------

export async function assignClash(input: {
  clashDbId: string;
  projectId: string;
  assignee: string | null;
  assigneeLabel: string | null;
  actorName?: string | null;
  clashTitle?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('clashes')
    .update({ assignee: input.assignee, assignee_label: input.assigneeLabel })
    .eq('id', input.clashDbId);
  if (error) throw error;
  if (input.assignee) {
    await notify({
      projectId: input.projectId,
      recipients: [input.assignee],
      type: 'clash_assigned',
      title: '간섭 담당 배정',
      body: input.clashTitle ? `담당: ${input.clashTitle}` : undefined,
      clashId: input.clashDbId,
      actorName: input.actorName,
    });
  }
}

export async function setClashDue(input: {
  clashDbId: string;
  projectId: string;
  due: string | null;
  assignee: string | null;
  actorName?: string | null;
  clashTitle?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('clashes')
    .update({ due_date: input.due })
    .eq('id', input.clashDbId);
  if (error) throw error;
  if (input.due && input.assignee) {
    await notify({
      projectId: input.projectId,
      recipients: [input.assignee],
      type: 'clash_assigned',
      title: '간섭 기한 설정',
      body: `${input.clashTitle ? input.clashTitle + ' · ' : ''}기한 ${input.due}`,
      clashId: input.clashDbId,
      actorName: input.actorName,
    });
  }
}

// ---------- 코멘트 스레드(@멘션·읽음) --------------------------------

export async function listClashComments(clashDbId: string): Promise<ClashComment[]> {
  const { data, error } = await supabase
    .from('clash_comment')
    .select('id, clash_id, author, author_name, body, mentions, created_at')
    .eq('clash_id', clashDbId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ClashComment[];
}

export async function addClashComment(input: {
  clashDbId: string;
  projectId: string;
  body: string;
  mentions: string[];
  authorName?: string | null;
  assignee?: string | null;
  clashTitle?: string;
}): Promise<ClashComment> {
  const author = await myId();
  const { data, error } = await supabase
    .from('clash_comment')
    .insert({
      clash_id: input.clashDbId,
      author,
      author_name: input.authorName ?? null,
      body: input.body,
      mentions: input.mentions,
    })
    .select('id, clash_id, author, author_name, body, mentions, created_at')
    .single();
  if (error) throw error;

  const preview = input.body.length > 60 ? input.body.slice(0, 60) + '…' : input.body;
  // @멘션 대상엔 멘션 알림, 담당자(멘션 제외)엔 코멘트 알림.
  if (input.mentions.length) {
    await notify({
      projectId: input.projectId,
      recipients: input.mentions,
      type: 'clash_mention',
      title: '간섭 코멘트에서 멘션',
      body: preview,
      clashId: input.clashDbId,
      actorName: input.authorName,
    });
  }
  if (input.assignee && !input.mentions.includes(input.assignee)) {
    await notify({
      projectId: input.projectId,
      recipients: [input.assignee],
      type: 'clash_comment',
      title: '담당 간섭에 새 코멘트',
      body: preview,
      clashId: input.clashDbId,
      actorName: input.authorName,
    });
  }
  return data as ClashComment;
}

export async function deleteClashComment(commentId: string): Promise<void> {
  const { error } = await supabase.from('clash_comment').delete().eq('id', commentId);
  if (error) throw error;
}

/** 스레드를 지금 읽음으로 표시(사용자별 upsert). */
export async function markClashRead(clashDbId: string): Promise<void> {
  const uid = await myId();
  if (!uid) return;
  const { error } = await supabase
    .from('clash_read')
    .upsert(
      { clash_id: clashDbId, user_id: uid, last_read_at: new Date().toISOString() },
      { onConflict: 'clash_id,user_id' },
    );
  if (error) throw error;
}

// ---------- 해소 → 검증 (상태 전이 + 감사) ---------------------------

/** 담당이 '해소 처리': status=resolved + 해소자/시각 기록. */
export async function resolveClash(input: {
  clashDbId: string;
  projectId: string;
  actorName?: string | null;
  clashTitle?: string;
}): Promise<ClashCoordination> {
  const uid = await myId();
  const { data, error } = await supabase
    .from('clashes')
    .update({ status: 'resolved', resolved_by: uid, resolved_at: new Date().toISOString() })
    .eq('id', input.clashDbId)
    .select(COORD_COLS)
    .single();
  if (error) throw error;
  return data as ClashCoordination;
}

/** 검토자가 '검증 완료': status=approved + 검증자/시각 기록. 담당자에게 알림. */
export async function verifyClash(input: {
  clashDbId: string;
  projectId: string;
  assignee?: string | null;
  actorName?: string | null;
  clashTitle?: string;
}): Promise<ClashCoordination> {
  const uid = await myId();
  const { data, error } = await supabase
    .from('clashes')
    .update({ status: 'approved', verified_by: uid, verified_at: new Date().toISOString() })
    .eq('id', input.clashDbId)
    .select(COORD_COLS)
    .single();
  if (error) throw error;
  if (input.assignee) {
    await notify({
      projectId: input.projectId,
      recipients: [input.assignee],
      type: 'clash_status',
      title: '간섭 해소 검증 완료',
      body: input.clashTitle,
      clashId: input.clashDbId,
      actorName: input.actorName,
    });
  }
  return data as ClashCoordination;
}

/** 상태를 흐름 밖 값으로 되돌릴 때(재검토): 감사 필드는 유지. */
export async function reopenClash(clashDbId: string, status: ClashStatus): Promise<void> {
  const { error } = await supabase.from('clashes').update({ status }).eq('id', clashDbId);
  if (error) throw error;
}
