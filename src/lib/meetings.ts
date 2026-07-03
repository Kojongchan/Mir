import { supabase } from './supabase';
import { notify } from './notifications';
import { createIssue } from './issues';

// =====================================================================
// R2 — 회의록 · 의사결정 로그 데이터층.
// 회의록 CRUD + 결정사항 + 액션아이템(담당·기한·상태·이슈 승격) + 검색.
// 재사용: issues(액션아이템 → 이슈 승격) · notifications(액션 담당 배정) ·
//         attachments(target_type='meeting').
// =====================================================================

export type DecisionType = 'decision' | 'agreement' | 'pending' | 'info';
export type ActionStatus = 'todo' | 'doing' | 'done';

export const DECISION_TYPES: DecisionType[] = ['decision', 'agreement', 'pending', 'info'];
export const DECISION_TYPE_LABEL: Record<DecisionType, string> = {
  decision: '결정',
  agreement: '합의',
  pending: '보류',
  info: '공유',
};

export const ACTION_STATUSES: ActionStatus[] = ['todo', 'doing', 'done'];
export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  todo: '대기',
  doing: '진행',
  done: '완료',
};
export const ACTION_STATUS_CLASS: Record<ActionStatus, string> = {
  todo: 'action-todo',
  doing: 'action-doing',
  done: 'action-done',
};

export interface Meeting {
  id: string;
  project_id: string;
  title: string;
  meeting_date: string;
  attendees: string[];
  body: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingDecision {
  id: string;
  meeting_id: string;
  project_id: string;
  text: string;
  decision_type: DecisionType;
  created_at: string;
}

export interface ActionItem {
  id: string;
  meeting_id: string;
  decision_id: string | null;
  project_id: string;
  text: string;
  assignee: string | null;
  assignee_name: string | null;
  due_date: string | null;
  status: ActionStatus;
  linked_issue_id: string | null;
  created_at: string;
}

const MEETING_COLS =
  'id, project_id, title, meeting_date, attendees, body, created_by, created_by_name, created_at, updated_at';
const DECISION_COLS = 'id, meeting_id, project_id, text, decision_type, created_at';
const ACTION_COLS =
  'id, meeting_id, decision_id, project_id, text, assignee, assignee_name, due_date, status, linked_issue_id, created_at';

// ---------- meetings -------------------------------------------------

export async function listMeetings(projectId: string): Promise<Meeting[]> {
  const { data, error } = await supabase
    .from('meeting')
    .select(MEETING_COLS)
    .eq('project_id', projectId)
    .order('meeting_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(normalizeMeeting);
}

function normalizeMeeting(row: any): Meeting {
  return { ...row, attendees: Array.isArray(row.attendees) ? row.attendees : [] } as Meeting;
}

export interface MeetingInput {
  title: string;
  meeting_date: string;
  attendees: string[];
  body?: string;
}

export async function createMeeting(
  projectId: string,
  input: MeetingInput,
  authorName: string | null,
): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('meeting')
    .insert({
      project_id: projectId,
      title: input.title,
      meeting_date: input.meeting_date,
      attendees: input.attendees,
      body: input.body ?? null,
      created_by: userData.user?.id ?? null,
      created_by_name: authorName,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateMeeting(id: string, input: MeetingInput): Promise<void> {
  const { error } = await supabase
    .from('meeting')
    .update({
      title: input.title,
      meeting_date: input.meeting_date,
      attendees: input.attendees,
      body: input.body ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteMeeting(id: string): Promise<void> {
  const { error } = await supabase.from('meeting').delete().eq('id', id);
  if (error) throw error;
}

// ---------- decisions ------------------------------------------------

export async function listDecisions(meetingId: string): Promise<MeetingDecision[]> {
  const { data, error } = await supabase
    .from('meeting_decision')
    .select(DECISION_COLS)
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as MeetingDecision[];
}

export async function addDecision(
  projectId: string,
  meetingId: string,
  text: string,
  decisionType: DecisionType,
): Promise<void> {
  const { error } = await supabase
    .from('meeting_decision')
    .insert({ project_id: projectId, meeting_id: meetingId, text, decision_type: decisionType });
  if (error) throw error;
}

export async function deleteDecision(id: string): Promise<void> {
  const { error } = await supabase.from('meeting_decision').delete().eq('id', id);
  if (error) throw error;
}

// ---------- action items ---------------------------------------------

export async function listActionItems(meetingId: string): Promise<ActionItem[]> {
  const { data, error } = await supabase
    .from('action_item')
    .select(ACTION_COLS)
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ActionItem[];
}

export interface ActionInput {
  text: string;
  assignee?: string | null;
  assignee_name?: string | null;
  due_date?: string | null;
  decision_id?: string | null;
}

export async function addActionItem(
  projectId: string,
  meetingId: string,
  input: ActionInput,
  actorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('action_item').insert({
    project_id: projectId,
    meeting_id: meetingId,
    decision_id: input.decision_id ?? null,
    text: input.text,
    assignee: input.assignee ?? null,
    assignee_name: input.assignee_name ?? null,
    due_date: input.due_date || null,
    created_by: userData.user?.id ?? null,
  });
  if (error) throw error;

  if (input.assignee) {
    await notify({
      projectId,
      recipients: [input.assignee],
      type: 'action_assigned',
      title: `액션아이템 배정: ${input.text.slice(0, 40)}`,
      body: input.due_date ? `기한: ${input.due_date}` : undefined,
      actorName,
    });
  }
}

export async function setActionStatus(id: string, status: ActionStatus): Promise<void> {
  const { error } = await supabase.from('action_item').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function deleteActionItem(id: string): Promise<void> {
  const { error } = await supabase.from('action_item').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 액션아이템을 이슈로 승격한다. 액션의 담당·기한을 그대로 이슈에 넘기고,
 * 생성된 이슈 id 를 action_item.linked_issue_id 로 되건다. 이미 연결됐으면 무시.
 */
export async function promoteActionToIssue(action: ActionItem, actorName: string | null): Promise<string> {
  if (action.linked_issue_id) return action.linked_issue_id;
  const issueId = await createIssue(
    action.project_id,
    {
      title: action.text,
      description: '회의 액션아이템에서 승격됨',
      priority: 'normal',
      assignee_id: action.assignee ?? null,
      assignee_name: action.assignee_name ?? undefined,
      due_date: action.due_date ?? null,
    },
    actorName,
  );
  const { error } = await supabase
    .from('action_item')
    .update({ linked_issue_id: issueId })
    .eq('id', action.id);
  if (error) throw error;
  return issueId;
}

// ---------- 검색 (본문/결정 전문 탐색) --------------------------------

export interface MeetingSearchHit {
  meeting: Meeting;
  /** 어디서 매치됐는지 표시(제목/본문/결정). */
  matchedIn: string;
  snippet: string;
}

/**
 * 회의록 제목·본문과 의사결정 텍스트를 across 검색한다. Postgres ilike 로
 * 서버측 필터 후 어느 필드에서 매치됐는지 스니펫을 만들어 반환한다.
 */
export async function searchMeetings(projectId: string, query: string): Promise<MeetingSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q}%`;

  // 1) 제목/본문 매치
  const { data: mData, error: mErr } = await supabase
    .from('meeting')
    .select(MEETING_COLS)
    .eq('project_id', projectId)
    .or(`title.ilike.${like},body.ilike.${like}`);
  if (mErr) throw mErr;

  // 2) 결정 텍스트 매치 → 소속 회의 조회
  const { data: dData, error: dErr } = await supabase
    .from('meeting_decision')
    .select('meeting_id, text')
    .eq('project_id', projectId)
    .ilike('text', like);
  if (dErr) throw dErr;

  const hits = new Map<string, MeetingSearchHit>();
  for (const raw of mData ?? []) {
    const meeting = normalizeMeeting(raw);
    const inTitle = meeting.title.toLowerCase().includes(q.toLowerCase());
    hits.set(meeting.id, {
      meeting,
      matchedIn: inTitle ? '제목' : '본문',
      snippet: inTitle ? meeting.title : makeSnippet(meeting.body ?? '', q),
    });
  }

  const decisionMeetingIds = Array.from(new Set((dData ?? []).map((d) => d.meeting_id as string))).filter(
    (id) => !hits.has(id),
  );
  if (decisionMeetingIds.length) {
    const { data: extra } = await supabase.from('meeting').select(MEETING_COLS).in('id', decisionMeetingIds);
    const textById = new Map((dData ?? []).map((d) => [d.meeting_id as string, d.text as string]));
    for (const raw of extra ?? []) {
      const meeting = normalizeMeeting(raw);
      hits.set(meeting.id, {
        meeting,
        matchedIn: '결정',
        snippet: makeSnippet(textById.get(meeting.id) ?? '', q),
      });
    }
  }

  return Array.from(hits.values()).sort((a, b) =>
    b.meeting.meeting_date.localeCompare(a.meeting.meeting_date),
  );
}

function makeSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + q.length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
