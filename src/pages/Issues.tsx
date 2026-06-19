import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  addComment,
  createIssue,
  deleteIssue,
  listComments,
  listIssues,
  setIssueStatus,
  type Issue,
  type IssueComment,
  type IssuePriority,
  type IssueStatus,
} from '../lib/issues';
import { formatDate } from '../lib/dashboard';

/** 협업 · 이슈/지적 관리 — RFI·지적사항·검토의견 트래커. */
export function Issues() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<IssueStatus | 'all'>('all');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState<{
    title: string;
    description: string;
    priority: IssuePriority;
    assignee_name: string;
    due_date: string;
  }>({ title: '', description: '', priority: 'normal', assignee_name: '', due_date: '' });

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listIssues(projectId).then(setIssues).catch(() => setIssues([]));

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      await createIssue(
        projectId,
        {
          title: form.title.trim(),
          description: form.description,
          priority: form.priority,
          assignee_name: form.assignee_name,
          due_date: form.due_date || null,
        },
        authorName,
      );
      setForm({ title: '', description: '', priority: 'normal', assignee_name: '', due_date: '' });
      setShowForm(false);
      await refresh();
      setMsg('이슈 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onStatus = async (id: string, status: IssueStatus) => {
    await setIssueStatus(id, status);
    await refresh();
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
            <label>담당자<input value={form.assignee_name} placeholder="이름" onChange={(e) => setForm({ ...form, assignee_name: e.target.value })} /></label>
            <label>기한<input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
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
                <th>기한</th>
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
                  authorName={authorName}
                  onToggle={() => setOpenId(openId === it.id ? null : it.id)}
                  onStatus={onStatus}
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

function IssueRow({
  issue,
  open,
  isAdmin,
  authorName,
  onToggle,
  onStatus,
  onDelete,
}: {
  issue: Issue;
  open: boolean;
  isAdmin: boolean;
  authorName: string | null;
  onToggle: () => void;
  onStatus: (id: string, s: IssueStatus) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <tr>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{issue.title}</button>
        </td>
        <td><span className={`issue-badge issue-${issue.status}`}>{STATUS_LABEL[issue.status]}</span></td>
        <td><span className={`issue-prio issue-prio-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span></td>
        <td className="nowrap">{issue.assignee_name || '—'}</td>
        <td className="nowrap">{issue.due_date ? formatDate(issue.due_date) : '—'}</td>
        <td className="right nowrap">
          {isAdmin ? (
            <>
              <select value={issue.status} onChange={(e) => onStatus(issue.id, e.target.value as IssueStatus)} aria-label="상태 변경">
                {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <button className="danger" onClick={() => onDelete(issue.id)}>삭제</button>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={6}>
            <IssueDetail issue={issue} isAdmin={isAdmin} authorName={authorName} />
          </td>
        </tr>
      )}
    </>
  );
}

function IssueDetail({ issue, isAdmin, authorName }: { issue: Issue; isAdmin: boolean; authorName: string | null }) {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [body, setBody] = useState('');

  useEffect(() => {
    listComments(issue.id).then(setComments).catch(() => setComments([]));
  }, [issue.id]);

  const onAdd = async () => {
    if (!body.trim()) return;
    await addComment(issue.id, body.trim(), authorName);
    setBody('');
    setComments(await listComments(issue.id));
  };

  return (
    <div className="issue-detail">
      {issue.description && <p className="issue-desc">{issue.description}</p>}
      <p className="muted issue-meta">
        등록 {issue.created_by_name || '—'} · {formatDate(issue.created_at.slice(0, 10))}
      </p>
      <div className="issue-comments">
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
