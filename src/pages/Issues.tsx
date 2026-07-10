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
  updateIssueMeta,
  logIssueEvent,
  type Issue,
  type IssueComment,
  type IssueEvent,
  type IssuePriority,
  type IssueStatus,
} from '../lib/issues';
import { listProjectMembers, memberLabel, type ProjectMember } from '../lib/members';
import { formatDate } from '../lib/dashboard';
import { Attachments } from '../components/Attachments';
import { MentionInput } from '../components/MentionInput';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { AccFilePreview } from '../components/AccFilePreview';
import { addIssueFile, listIssueFiles, removeIssueFile, type IssueFileLink } from '../lib/issueFiles';
import { downloadAccItemProgress, isAccModel } from '../lib/aps';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 담당 배정·@멘션 후보 목록 — 뷰어를 뺀 모두(실무자·관리자)가 배정 가능(0033: 같은
  // 프로젝트 멤버끼리 이름 조회 허용). canEdit 은 역할 로딩 후 갱신되므로 별도 effect 로
  // canEdit 이 true 가 되는 시점에 반드시 다시 불러온다(초기 false 캡처로 목록이 비던 버그 수정).
  useEffect(() => {
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    else setMembers([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, canEdit]);

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

  const onMeta = async (issue: Issue, fields: { priority?: IssuePriority; due_date?: string | null; description?: string | null }) => {
    try {
      await updateIssueMeta(issue, fields, authorName);
      await refresh();
    } catch (e) {
      setMsg(`수정 실패: ${errMessage(e)}`);
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
                {members.map((m) => <option key={m.id} value={m.id}>{memberLabel(m)}</option>)}
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
                  onMeta={onMeta}
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
  onMeta,
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
  onMeta: (issue: Issue, fields: { priority?: IssuePriority; due_date?: string | null; description?: string | null }) => Promise<void> | void;
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
              onMeta={onMeta}
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
  onMeta,
  onCommented,
}: {
  issue: Issue;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
  onAssign: (issue: Issue, assigneeId: string) => void;
  onMeta: (issue: Issue, fields: { priority?: IssuePriority; due_date?: string | null; description?: string | null }) => Promise<void> | void;
  onCommented: () => void;
}) {
  const navigate = useNavigate();
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [propOpen, setPropOpen] = useState(false);
  const [files, setFiles] = useState<IssueFileLink[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editContent, setEditContent] = useState(false);
  const [descDraft, setDescDraft] = useState(issue.description ?? '');
  // 파일별 다운로드 진행률(동시 다운로드 지원 — 다른 파일을 눌러도 기존 것이 이어짐).
  const [dls, setDls] = useState<Record<string, number | null>>({});
  const [previewFile, setPreviewFile] = useState<IssueFileLink | null>(null);
  const [showAllComments, setShowAllComments] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const hasLocation = !!issue.model_id && issue.express_id != null;
  const hasGlobal = !!issue.global_id; // APS/ACC 앵커(S49) — GlobalId→dbId 위치보기

  const assignedMember = members.find((m) => m.id === issue.assignee_id) ?? null;

  useEffect(() => {
    listComments(issue.id).then(setComments).catch(() => setComments([]));
    listEvents(issue.id).then(setEvents).catch(() => setEvents([]));
    listIssueFiles(issue.id).then(setFiles).catch(() => setFiles([]));
  }, [issue.id, issue.status, issue.assignee_id]);

  const onPickFile = async (f: PickedAccFile) => {
    try {
      const link = await addIssueFile({
        projectId: issue.project_id,
        issueId: issue.id,
        accProjectId: f.accProjectId,
        accItemId: f.accItemId,
        accUrn: f.accUrn,
        name: f.name,
        folderId: f.folderId,
        folderIds: f.folderIds,
        folderNames: f.folderNames,
        addedByName: authorName,
      });
      setFiles((fs) => [...fs, link]);
      setPickerOpen(false);
      refreshEvents();
    } catch (e) {
      alert(`첨부 실패: ${errMessage(e)}`);
    }
  };
  const onRemoveFile = async (id: string) => {
    if (!window.confirm('이 첨부 링크를 해제할까요? (자료관리 원본 파일은 유지됩니다)')) return;
    try {
      await removeIssueFile(id);
      setFiles((fs) => fs.filter((x) => x.id !== id));
    } catch (e) {
      alert(`해제 실패: ${errMessage(e)}`);
    }
  };

  const refreshEvents = () => listEvents(issue.id).then(setEvents).catch(() => {});

  const onDownloadFile = async (f: IssueFileLink) => {
    if (dls[f.id] !== undefined) return; // 이미 이 파일 받는 중
    setDls((d) => ({ ...d, [f.id]: 0 }));
    try {
      await downloadAccItemProgress(f.acc_project_id, f.acc_item_id, f.name, (frac) =>
        setDls((d) => ({ ...d, [f.id]: frac == null ? null : Math.round(frac * 100) })),
      );
      await logIssueEvent(issue.id, issue.project_id, 'file_download', f.name, authorName);
      refreshEvents();
    } catch (e) {
      alert(`다운로드 실패: ${errMessage(e)}`);
    } finally {
      setDls((d) => {
        const n = { ...d };
        delete n[f.id];
        return n;
      });
    }
  };

  const saveContent = async () => {
    await onMeta(issue, { description: descDraft.trim() || null });
    setEditContent(false);
    refreshEvents();
  };

  const onAdd = async () => {
    if (!body.trim()) return;
    await addComment(issue, body.trim(), authorName, mentions);
    setBody('');
    setMentions([]);
    setComments(await listComments(issue.id));
    refreshEvents();
    onCommented();
  };

  const hasAnyLocation = hasLocation || hasGlobal || !!issue.viewpoint_id;

  return (
    <div className="issue-detail issue-report">
      {/* 속성 — 요약(상태·우선순위·담당·마감)은 항상, 편집은 펼쳐서 */}
      <section className="issue-block">
        <button className="issue-block__h issue-block__toggle" onClick={() => setPropOpen((o) => !o)} aria-expanded={propOpen}>
          <span>속성</span>
          {canEdit && <span className="issue-block__chev">{propOpen ? '▾ 설정 접기' : '▸ 설정 편집'}</span>}
        </button>
        <div className="issue-block__b">
          <div className="issue-facts">
            <span><b>상태</b> <span className={`issue-badge issue-${issue.status}`}>{STATUS_LABEL[issue.status]}</span></span>
            <span><b>우선순위</b> <span className={`issue-prio issue-prio-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span></span>
            <span><b>담당</b> {assignedMember ? memberLabel(assignedMember) : issue.assignee_name || '미지정'}</span>
            <span><b>마감</b> {issue.due_date ? formatDate(issue.due_date) : '—'}</span>
          </div>
          {canEdit && propOpen && (
            <div className="issue-assign-row" style={{ marginTop: 10 }}>
              <label>담당자 배정
                <select value={issue.assignee_id ?? ''} onChange={(e) => onAssign(issue, e.target.value)}>
                  <option value="">미지정</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{memberLabel(m)}</option>)}
                </select>
              </label>
              <label>우선순위
                <select value={issue.priority} onChange={async (e) => { await onMeta(issue, { priority: e.target.value as IssuePriority }); refreshEvents(); }}>
                  {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </label>
              <label>마감일
                <input type="date" value={issue.due_date ?? ''} onChange={async (e) => { await onMeta(issue, { due_date: e.target.value || null }); refreshEvents(); }} />
              </label>
            </div>
          )}
        </div>
      </section>

      {/* 내용 (+ 편집 + 위치 보기) */}
      <section className="issue-block">
        <div className="issue-block__h">
          <span>내용</span>
          {canEdit && !editContent && (
            <span className="issue-block__chev" style={{ cursor: 'pointer' }} onClick={() => { setDescDraft(issue.description ?? ''); setEditContent(true); }}>✏ 편집</span>
          )}
        </div>
        <div className="issue-block__b">
          {editContent ? (
            <div>
              <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} style={{ width: '100%', minHeight: 90, resize: 'vertical' }} placeholder="내용을 입력하세요" />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="primary" onClick={() => void saveContent()}>저장</button>
                <button onClick={() => setEditContent(false)}>취소</button>
              </div>
            </div>
          ) : issue.description ? (
            <p className="issue-desc">{issue.description}</p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>내용 없음</p>
          )}
          <p className="muted issue-meta" style={{ margin: '8px 0 0' }}>
            등록 {issue.created_by_name || '—'} · {formatDate(issue.created_at.slice(0, 10))}
          </p>
          {hasAnyLocation && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
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
                    navigate(`/project/${issue.project_id}/model`, { state: { openViewpoint: issue.viewpoint_id } })
                  }
                >
                  📌 뷰포인트 열기
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 간섭 검토 이미지 — 간섭검토에서 이슈 생성 시 자동 첨부(읽기전용) */}
      <section className="issue-block">
        <div className="issue-block__h">간섭 검토 이미지</div>
        <div className="issue-block__b">
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>간섭 검토에서 이슈 생성 시 자동으로 추가됩니다.</p>
          <Attachments projectId={issue.project_id} targetType="issue" targetId={issue.id} canEdit={false} label="" />
        </div>
      </section>

      {/* 관련 자료 — 자료관리(ACC) 파일 링크. 미리보기 + 다운로드(진행률) + 파일 위치 */}
      <section className="issue-block">
        <div className="issue-block__h">관련 자료 · {files.length}</div>
        <div className="issue-block__b">
          {files.length === 0 && <p className="muted" style={{ margin: 0 }}>연결된 파일이 없습니다.</p>}
          {files.map((f) => {
            const pct = dls[f.id];
            const dling = pct !== undefined;
            return (
              <div className="issue-file" key={f.id}>
                <span className="issue-file-name" title={f.name}>{isAccModel(f.name) ? '🧱' : '📄'} {f.name}</span>
                <button className="issue-file-dl" title="미리보기" onClick={() => setPreviewFile(f)}>👁 미리보기</button>
                <button className="issue-file-dl" disabled={dling} title="이 파일 다운로드" onClick={() => void onDownloadFile(f)}>
                  {dling ? (pct == null ? '⬇ …' : `⬇ ${pct}%`) : '⬇ 다운로드'}
                </button>
                <span className="issue-file-locwrap">
                  파일 위치 :
                  <button
                    className="issue-file-loc"
                    title="자료관리에서 이 파일이 있는 폴더 열기"
                    onClick={() =>
                      navigate(`/project/${issue.project_id}/docs`, {
                        state: { openFolderIds: f.folder_ids, openFolderNames: f.folder_names },
                      })
                    }
                  >
                    📁 {f.folder_names.length ? f.folder_names.join(' / ') : '위치'} ›
                  </button>
                </span>
                {canEdit && <button className="issue-file-del" title="첨부 해제" onClick={() => onRemoveFile(f.id)}>✕</button>}
              </div>
            );
          })}
          {canEdit && (
            <button style={{ marginTop: 8 }} onClick={() => setPickerOpen(true)}>＋ 자료관리에서 첨부</button>
          )}
        </div>
      </section>

      {pickerOpen && (
        <AccFilePicker projectId={issue.project_id} canEdit={canEdit} onPick={onPickFile} onClose={() => setPickerOpen(false)} />
      )}
      {previewFile && (
        <AccFilePreview
          accProject={previewFile.acc_project_id}
          itemId={previewFile.acc_item_id}
          name={previewFile.name}
          urn={previewFile.acc_urn}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* 코멘트 */}
      <section className="issue-block issue-block--pop">
        <div className="issue-block__h">코멘트 · {comments.length}</div>
        <div className="issue-block__b">
          <div className="issue-comments">
            {comments.length > 10 && !showAllComments && (
              <button className="issue-more" onClick={() => setShowAllComments(true)}>
                이전 코멘트 {comments.length - 10}개 더 보기
              </button>
            )}
            {(showAllComments ? comments : comments.slice(-10)).map((c) => (
              <div className="issue-comment" key={c.id}>
                <span className="issue-comment-author">{c.author_name || '익명'}</span>
                <span className="issue-comment-body">{renderCommentBody(c.body, members)}</span>
                <span className="muted issue-comment-when">{fmtDateTime(c.created_at)}</span>
              </div>
            ))}
            {comments.length === 0 && <p className="muted" style={{ margin: 0 }}>코멘트가 없습니다.</p>}
          </div>
          {canEdit && (
            <div className="issue-comment-add" style={{ marginTop: 8 }}>
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
      </section>

      {/* 변경이력 — 접기/펼치기(자주 바뀌면 길어져서 기본 접힘) */}
      <section className="issue-block">
        <button className="issue-block__h issue-block__toggle" onClick={() => setHistOpen((o) => !o)} aria-expanded={histOpen}>
          <span>변경이력 · {events.length}</span>
          <span className="issue-block__chev">{histOpen ? '▾' : '▸'}</span>
        </button>
        {histOpen && (
          <div className="issue-block__b">
            {events.length === 0 && <p className="muted" style={{ margin: 0 }}>이력이 없습니다.</p>}
            {events.length > 10 && !showAllEvents && (
              <button className="issue-more" onClick={() => setShowAllEvents(true)}>
                이전 이력 {events.length - 10}개 더 보기
              </button>
            )}
            {(showAllEvents ? events : events.slice(-10)).map((ev) => {
              const i = events.indexOf(ev);
              return (
                <div className="issue-event" key={ev.id}>
                  <span className="issue-event-no">#{i + 1}</span>
                  <span className="issue-event-text">{eventText(ev)}</span>
                  <span className="muted issue-event-meta">{ev.actor_name || '—'} · {fmtDateTime(ev.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 코멘트 본문의 @이름(구성원 일치, 경계)만 파랗게 인라인 하이라이트. */
function renderCommentBody(text: string, members: ProjectMember[]): React.ReactNode {
  const names = members.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(?:${esc.join('|')})(?=[\\s.,!?)\\]}·]|$)`, 'g');
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span className="mention-tag" key={k++}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function eventText(ev: IssueEvent): string {
  switch (ev.kind) {
    case 'created': return `이슈 생성 — ${ev.to_value ?? ''}`;
    case 'status': return `상태 ${ev.from_value} → ${ev.to_value}`;
    case 'assign': return `담당자 ${ev.from_value} → ${ev.to_value}`;
    case 'priority': return `우선순위 ${ev.from_value} → ${ev.to_value}`;
    case 'due': return `마감일 ${ev.from_value} → ${ev.to_value}`;
    case 'content': return '내용 수정';
    case 'file_add': return `관련 자료 추가 — ${ev.to_value ?? ''}`;
    case 'file_download': return `자료 다운로드 — ${ev.to_value ?? ''}`;
    case 'comment': return `코멘트 — ${ev.to_value ?? ''}`;
    default: return ev.kind;
  }
}
