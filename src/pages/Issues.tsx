import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  DUE_LABEL,
  addComment,
  assignIssue,
  createIssue,
  deleteIssue,
  dueDeltaLabel,
  dueState,
  listComments,
  listEvents,
  listIssues,
  listUnreadIssues,
  markIssueRead,
  setIssueStatus,
  type Issue,
  type IssueComment,
  type IssueEvent,
  type IssuePriority,
  type IssueStatus,
} from '../lib/issues';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import { formatDate } from '../lib/dashboard';
import { Attachments } from '../components/Attachments';
import { MentionInput } from '../components/MentionInput';
import { useProjectRole } from '../auth/useProjectRole';

/** 협업 · 이슈/지적 관리 — 상태 워크플로우·담당자·마감 추적 트래커. */
export function Issues() {
  const { projectId = '' } = useParams();
  const { profile, session } = useAuth();
  // 쓰기(이슈·코멘트·첨부 CRUD) = 실무자(editor) 이상. RLS(0023)와 일치.
  const { canEdit } = useProjectRole(projectId);
  const myId = session?.user.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<IssueStatus | 'all'>('all');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState<{
    title: string;
    description: string;
    priority: IssuePriority;
    assignee_id: string;
    due_date: string;
  }>({ title: '', description: '', priority: 'normal', assignee_id: '', due_date: '' });

  // 통합모델 이슈 핀 '이슈로 이동' 으로 들어오면 해당 이슈를 펼친다.
  const location = useLocation();
  const focusIssueId = (location.state as { focusIssueId?: string } | null)?.focusIssueId ?? null;

  useEffect(() => {
    refresh();
    // 담당 배정·@멘션 후보 목록 — 뷰어를 뺀 모두(실무자·관리자)가 배정 가능(0033: 같은
    // 프로젝트 멤버끼리 이름 조회 허용). 뷰어는 canEdit=false 라 목록을 받지 않는다.
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (focusIssueId) {
      setOpenId(focusIssueId);
      onRead(focusIssueId); // 알림에서 진입 시 읽음 처리
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIssueId]);

  const refresh = async () => {
    try {
      const list = await listIssues(projectId);
      setIssues(list);
      listUnreadIssues(list.map((i) => i.id))
        .then(setUnread)
        .catch(() => setUnread(new Set()));
    } catch {
      setIssues([]);
    }
  };

  // 이슈 상세를 열 때 읽음 처리 후 안읽음 배지 갱신.
  const onRead = (issueId: string) => {
    markIssueRead(issueId).then(() =>
      setUnread((prev) => {
        if (!prev.has(issueId)) return prev;
        const next = new Set(prev);
        next.delete(issueId);
        return next;
      }),
    );
  };

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      const member = members.find((m) => m.id === form.assignee_id);
      await createIssue(
        projectId,
        {
          title: form.title.trim(),
          description: form.description,
          priority: form.priority,
          assignee_id: form.assignee_id || null,
          assignee_name: member?.name,
          due_date: form.due_date || null,
        },
        authorName,
      );
      setForm({ title: '', description: '', priority: 'normal', assignee_id: '', due_date: '' });
      setShowForm(false);
      await refresh();
      setMsg('이슈 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onStatus = async (issue: Issue, status: IssueStatus) => {
    try {
      await setIssueStatus(issue, status, authorName);
      await refresh();
    } catch (e) {
      setMsg(`상태 변경 실패: ${errMessage(e)}`);
    }
  };

  const onAssign = async (issue: Issue, assigneeId: string) => {
    const member = members.find((m) => m.id === assigneeId);
    try {
      await assignIssue(issue, assigneeId || null, member?.name ?? null, authorName);
      await refresh();
    } catch (e) {
      setMsg(`담당자 배정 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 이슈를 삭제할까요?')) return;
    await deleteIssue(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const shown = filter === 'all' ? issues : issues.filter((i) => i.status === filter);
  // 생성 순(오래된→최신) 순차 번호 — 간섭 저장 순서와 무관(#5).
  const numberOf = useMemo(() => {
    const m = new Map<string, number>();
    [...issues]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach((it, i) => m.set(it.id, i + 1));
    return m;
  }, [issues]);

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">협업 · 이슈</h1>
        {canEdit && (
          <button className="primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? '취소' : '＋ 이슈 등록'}
          </button>
        )}
      </div>

      {showForm && (
        <section className="card dash-edit">
          <h3>새 이슈</h3>
          <div className="dash-edit-row">
            <label className="grow">제목<input value={form.title} placeholder="예: 3층 보-슬래브 간섭 지적" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>우선순위
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as IssuePriority })}>
                {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </label>
            <label>담당자
              <select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">미지정</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.company ? ` · ${m.company}` : ''}</option>)}
              </select>
            </label>
            <label>마감일<input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
          </div>
          <div className="dash-edit-row">
            <label className="grow">내용<input value={form.description} placeholder="상세 내용" onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <button className="primary" onClick={onCreate}>등록</button>
          </div>
        </section>
      )}

      <div className="issue-filters">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>전체 {issues.length}</button>
        {ISSUE_STATUSES.map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {STATUS_LABEL[s]} {issues.filter((i) => i.status === s).length}
          </button>
        ))}
      </div>

      <section className="card" style={{ padding: 0 }}>
        <div className="cde-table-wrap" style={{ padding: 0 }}>
          <table className="cde-table">
            <thead>
              <tr>
                <th style={{ width: 48 }}>번호</th>
                <th>제목</th>
                <th>상태</th>
                <th>우선순위</th>
                <th>담당자</th>
                <th>마감일</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => (
                <IssueRow
                  key={it.id}
                  num={numberOf.get(it.id) ?? 0}
                  issue={it}
                  open={openId === it.id}
                  unread={unread.has(it.id)}
                  canEdit={canEdit}
                  myId={myId}
                  members={members}
                  authorName={authorName}
                  onToggle={() => {
                    const opening = openId !== it.id;
                    setOpenId(opening ? it.id : null);
                    if (opening) onRead(it.id);
                  }}
                  onStatus={onStatus}
                  onAssign={onAssign}
                  onDelete={onDelete}
                  onCommented={() => onRead(it.id)}
                />
              ))}
              {shown.length === 0 && (
                <tr><td colSpan={7}><EmptyState compact icon="🗂" title="이슈가 없습니다" desc="새 이슈를 등록하면 여기에 표시됩니다." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

/** 마감일 셀 — 임박/지연 뱃지 포함. */
function DueCell({ issue }: { issue: Issue }) {
  if (!issue.due_date) return <span className="muted">—</span>;
  const state = dueState(issue.due_date, issue.status);
  return (
    <span className="nowrap">
      {formatDate(issue.due_date)}
      {(state === 'overdue' || state === 'soon') && (
        <span className={`due-badge due-${state}`}>{DUE_LABEL[state]} {dueDeltaLabel(issue.due_date)}</span>
      )}
    </span>
  );
}

function IssueRow({
  num,
  issue,
  open,
  unread,
  canEdit,
  myId,
  members,
  authorName,
  onToggle,
  onStatus,
  onAssign,
  onDelete,
  onCommented,
}: {
  num: number;
  issue: Issue;
  open: boolean;
  unread: boolean;
  canEdit: boolean;
  myId: string | null;
  members: ProjectMember[];
  authorName: string | null;
  onToggle: () => void;
  onStatus: (issue: Issue, s: IssueStatus) => void;
  onAssign: (issue: Issue, assigneeId: string) => void;
  onDelete: (id: string) => void;
  onCommented: () => void;
}) {
  // 담당자 본인도 자기 이슈의 상태를 변경할 수 있다(S30 결정).
  const canStatus = canEdit || (!!myId && issue.assignee_id === myId);
  return (
    <>
      <tr>
        <td className="nowrap" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{num}</td>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>
            {open ? '▾ ' : '▸ '}
            {unread && !open && (
              <span
                title="새 코멘트(안읽음)"
                style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: 'var(--color-brand-accent, #dc2626)', marginRight: 6, verticalAlign: 'middle' }}
              />
            )}
            <span style={{ fontWeight: unread && !open ? 700 : 400 }}>{issue.title}</span>
          </button>
        </td>
        <td><span className={`issue-badge issue-${issue.status}`}>{STATUS_LABEL[issue.status]}</span></td>
        <td><span className={`issue-prio issue-prio-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span></td>
        <td className="nowrap">{issue.assignee_name || '—'}</td>
        <td><DueCell issue={issue} /></td>
        <td className="right nowrap">
          {canStatus ? (
            <select value={issue.status} onChange={(e) => onStatus(issue, e.target.value as IssueStatus)} aria-label="상태 변경">
              {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          ) : (
            <span className="muted">—</span>
          )}
          {canEdit && <button className="danger" onClick={() => onDelete(issue.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={7}>
            <IssueDetail
              issue={issue}
              canEdit={canEdit}
              members={members}
              authorName={authorName}
              onAssign={onAssign}
              onCommented={onCommented}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function IssueDetail({
  issue,
  canEdit,
  members,
  authorName,
  onAssign,
  onCommented,
}: {
  issue: Issue;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
  onAssign: (issue: Issue, assigneeId: string) => void;
  onCommented: () => void;
}) {
  const navigate = useNavigate();
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const hasLocation = !!issue.model_id && issue.express_id != null;
  const hasGlobal = !!issue.global_id; // APS/ACC 앵커(S49) — GlobalId→dbId 위치보기

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '구성원';

  useEffect(() => {
    listComments(issue.id).then(setComments).catch(() => setComments([]));
    listEvents(issue.id).then(setEvents).catch(() => setEvents([]));
  }, [issue.id, issue.status, issue.assignee_id]);

  const onAdd = async () => {
    if (!body.trim()) return;
    await addComment(issue, body.trim(), authorName, mentions);
    setBody('');
    setMentions([]);
    setComments(await listComments(issue.id));
    onCommented();
  };

  return (
    <div className="issue-detail">
      {issue.description && <p className="issue-desc">{issue.description}</p>}
      <p className="muted issue-meta">
        등록 {issue.created_by_name || '—'} · {formatDate(issue.created_at.slice(0, 10))}
      </p>

      {canEdit && (
        <div className="issue-assign-row">
          <label>담당자 배정
            <select value={issue.assignee_id ?? ''} onChange={(e) => onAssign(issue, e.target.value)}>
              <option value="">미지정</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {(hasLocation || hasGlobal || issue.viewpoint_id) && (
        <p style={{ margin: '0 0 10px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {hasGlobal && (
            <button
              onClick={() =>
                navigate(
                  issue.global_id_b
                    ? `/project/${issue.project_id}/clash?focusClashA=${encodeURIComponent(issue.global_id!)}&focusClashB=${encodeURIComponent(issue.global_id_b)}`
                    : `/project/${issue.project_id}/acc?focusGlobalId=${encodeURIComponent(issue.global_id!)}`,
                )
              }
            >
              📍 위치 보기 {issue.global_id_b ? '(간섭 뷰)' : '(ACC 모델)'}
            </button>
          )}
          {hasLocation && (
            <button
              onClick={() =>
                navigate(`/project/${issue.project_id}/model`, {
                  state: { focus: { modelDbId: issue.model_id, expressID: issue.express_id } },
                })
              }
            >
              📍 위치 보기 (3D 객체 #{issue.express_id})
            </button>
          )}
          {issue.viewpoint_id && (
            <button
              onClick={() =>
                navigate(`/project/${issue.project_id}/model`, {
                  state: { openViewpoint: issue.viewpoint_id },
                })
              }
            >
              📌 뷰포인트 열기
            </button>
          )}
        </p>
      )}

      {events.length > 0 && (
        <div className="issue-history">
          <h4 className="issue-section-h">변경 이력</h4>
          {events.map((ev) => (
            <div className="issue-event" key={ev.id}>
              <span className="issue-event-when">{new Date(ev.created_at).toLocaleString('ko-KR')}</span>
              <span className="issue-event-text">{eventText(ev)}</span>
              <span className="muted">{ev.actor_name || '—'}</span>
            </div>
          ))}
        </div>
      )}

      <Attachments
        projectId={issue.project_id}
        targetType="issue"
        targetId={issue.id}
        canEdit={canEdit}
        label="첨부 문서·사진"
      />

      <div className="issue-comments">
        <h4 className="issue-section-h">코멘트</h4>
        {comments.map((c) => (
          <div className="issue-comment" key={c.id}>
            <span className="issue-comment-author">{c.author_name || '익명'}</span>
            <span className="issue-comment-body">
              {c.body}
              {c.mentions.length > 0 && (
                <span className="issue-comment-mentions"> @{c.mentions.map(nameOf).join(', @')}</span>
              )}
            </span>
            <span className="muted issue-comment-when">{new Date(c.created_at).toLocaleString('ko-KR')}</span>
          </div>
        ))}
        {comments.length === 0 && <p className="muted">코멘트가 없습니다.</p>}
      </div>
      {canEdit && (
        <div className="issue-comment-add">
          <MentionInput
            value={body}
            onChange={setBody}
            members={members}
            onMentionsChange={setMentions}
            onEnter={onAdd}
            placeholder="코멘트 입력 (@ 입력 시 구성원 선택)"
          />
          <button onClick={onAdd}>등록</button>
        </div>
      )}
    </div>
  );
}

function eventText(ev: IssueEvent): string {
  if (ev.kind === 'created') return `이슈 생성 — ${ev.to_value ?? ''}`;
  if (ev.kind === 'status') return `상태 ${ev.from_value} → ${ev.to_value}`;
  return `담당자 ${ev.from_value} → ${ev.to_value}`;
}
