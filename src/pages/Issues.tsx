import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

/** 협업 · 이슈/지적 관리 — 상태 워크플로우·담당자·마감 추적 트래커. */
export function Issues() {
  const { projectId = '' } = useParams();
  const { profile, session } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const myId = session?.user.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
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

  useEffect(() => {
    refresh();
    if (isAdmin) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listIssues(projectId).then(setIssues).catch(() => setIssues([]));

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

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">협업 · 이슈</h1>
        {isAdmin && (
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
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
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
                  issue={it}
                  open={openId === it.id}
                  isAdmin={isAdmin}
                  myId={myId}
                  members={members}
                  authorName={authorName}
                  onToggle={() => setOpenId(openId === it.id ? null : it.id)}
                  onStatus={onStatus}
                  onAssign={onAssign}
                  onDelete={onDelete}
                />
              ))}
              {shown.length === 0 && (
                <tr><td colSpan={6} className="muted empty">이슈가 없습니다.</td></tr>
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
  issue,
  open,
  isAdmin,
  myId,
  members,
  authorName,
  onToggle,
  onStatus,
  onAssign,
  onDelete,
}: {
  issue: Issue;
  open: boolean;
  isAdmin: boolean;
  myId: string | null;
  members: ProjectMember[];
  authorName: string | null;
  onToggle: () => void;
  onStatus: (issue: Issue, s: IssueStatus) => void;
  onAssign: (issue: Issue, assigneeId: string) => void;
  onDelete: (id: string) => void;
}) {
  // 담당자 본인도 자기 이슈의 상태를 변경할 수 있다(S30 결정).
  const canStatus = isAdmin || (!!myId && issue.assignee_id === myId);
  return (
    <>
      <tr>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{issue.title}</button>
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
          {isAdmin && <button className="danger" onClick={() => onDelete(issue.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={6}>
            <IssueDetail
              issue={issue}
              isAdmin={isAdmin}
              members={members}
              authorName={authorName}
              onAssign={onAssign}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function IssueDetail({
  issue,
  isAdmin,
  members,
  authorName,
  onAssign,
}: {
  issue: Issue;
  isAdmin: boolean;
  members: ProjectMember[];
  authorName: string | null;
  onAssign: (issue: Issue, assigneeId: string) => void;
}) {
  const navigate = useNavigate();
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [body, setBody] = useState('');
  const hasLocation = !!issue.model_id && issue.express_id != null;

  useEffect(() => {
    listComments(issue.id).then(setComments).catch(() => setComments([]));
    listEvents(issue.id).then(setEvents).catch(() => setEvents([]));
  }, [issue.id, issue.status, issue.assignee_id]);

  const onAdd = async () => {
    if (!body.trim()) return;
    await addComment(issue, body.trim(), authorName);
    setBody('');
    setComments(await listComments(issue.id));
  };

  return (
    <div className="issue-detail">
      {issue.description && <p className="issue-desc">{issue.description}</p>}
      <p className="muted issue-meta">
        등록 {issue.created_by_name || '—'} · {formatDate(issue.created_at.slice(0, 10))}
      </p>

      {isAdmin && (
        <div className="issue-assign-row">
          <label>담당자 배정
            <select value={issue.assignee_id ?? ''} onChange={(e) => onAssign(issue, e.target.value)}>
              <option value="">미지정</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {hasLocation && (
        <p style={{ margin: '0 0 10px' }}>
          <button
            onClick={() =>
              navigate(`/project/${issue.project_id}/viewer`, {
                state: { focus: { modelDbId: issue.model_id, expressID: issue.express_id } },
              })
            }
          >
            📍 위치 보기 (3D 객체 #{issue.express_id})
          </button>
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
        isAdmin={isAdmin}
        label="첨부 문서·사진"
      />

      <div className="issue-comments">
        <h4 className="issue-section-h">코멘트</h4>
        {comments.map((c) => (
          <div className="issue-comment" key={c.id}>
            <span className="issue-comment-author">{c.author_name || '익명'}</span>
            <span className="issue-comment-body">{c.body}</span>
            <span className="muted issue-comment-when">{new Date(c.created_at).toLocaleString('ko-KR')}</span>
          </div>
        ))}
        {comments.length === 0 && <p className="muted">코멘트가 없습니다.</p>}
      </div>
      {isAdmin && (
        <div className="issue-comment-add">
          <input value={body} placeholder="코멘트 입력" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
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
