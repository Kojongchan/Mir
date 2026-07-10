import { useEffect, useMemo, useRef, useState } from 'react';
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
  updateIssueTypeFields,
  logIssueEvent,
  type Issue,
  type IssueComment,
  type IssueEvent,
  type IssuePriority,
  type IssueStatus,
} from '../lib/issues';
import {
  ISSUE_TYPES,
  TYPE_COLOR,
  TYPE_FIELDS,
  TYPE_ICON,
  TYPE_LABEL,
  metaValue,
  siteTagOf,
  statusLabelFor,
  type IssueFieldDef,
  type IssueType,
} from '../lib/issueTypes';
import {
  listIssueViewpoints,
  removeIssueViewpoint,
  updateIssueViewpointMarkup,
  type IssueViewpoint,
} from '../lib/issueViewpoints';
import { exportIssueFormDocx, exportIssuesXlsx, openIssueFormPrint } from '../lib/issueExport';
import {
  getSiteTag,
  listDrafts,
  photoToDataUrl,
  saveDraft,
  syncDrafts,
  dataUrlToFile,
} from '../lib/issueDrafts';
import { listPinsForIssue, listIssuePins, type IssuePinRef } from '../lib/drawings';
import { listProjectMembers, memberLabel, type ProjectMember } from '../lib/members';
import { formatDate } from '../lib/dashboard';
import { getProject } from '../lib/api';
import { Attachments } from '../components/Attachments';
import { MarkupOverlay, type MarkupTool } from '../components/MarkupOverlay';
import { REDLINE_COLORS, type MarkupShape, type RedlineColor } from '../lib/viewpoints';
import { MentionInput } from '../components/MentionInput';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { AccFilePreview } from '../components/AccFilePreview';
import { addIssueFile, listIssueFiles, removeIssueFile, type IssueFileLink } from '../lib/issueFiles';
import { listAttachments, uploadAttachment } from '../lib/attachments';
import { downloadAccItemProgress, isAccModel } from '../lib/aps';
import { useProjectRole } from '../auth/useProjectRole';

type ViewMode = 'list' | 'board' | 'pins';
type SortMode = 'newest' | 'oldest' | 'due' | 'priority';

const VIEW_KEY = 'mir.issues.view';
const PRIO_ORDER: Record<IssuePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** 이슈 타입 뱃지(아이콘+라벨, 타입별 색). */
function TypeBadge({ type, compact = false }: { type: IssueType; compact?: boolean }) {
  const c = TYPE_COLOR[type];
  return (
    <span className="issue-type-badge" style={{ background: c.bg, color: c.fg }}>
      {TYPE_ICON[type]}{compact ? '' : ` ${TYPE_LABEL[type]}`}
    </span>
  );
}

/** 협업 · 이슈/지적 관리 — 타입 분화(RFI·하자·안전·품질) + 리스트/칸반/핀 3뷰. */
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
  const [typeFilter, setTypeFilter] = useState<IssueType | 'all'>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortMode>('newest');
  const [view, setView] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'board' || v === 'pins' ? v : 'list';
  });
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [draftCount, setDraftCount] = useState(0);
  const [projectName, setProjectName] = useState('');

  const [form, setForm] = useState<{
    title: string;
    description: string;
    type: IssueType;
    meta: Record<string, string>;
    priority: IssuePriority;
    assignee_id: string;
    due_date: string;
  }>({ title: '', description: '', type: 'general', meta: {}, priority: 'normal', assignee_id: '', due_date: '' });

  // 통합모델 이슈 핀 '이슈로 이동' 으로 들어오면 해당 이슈를 펼친다.
  const location = useLocation();
  const focusIssueId = (location.state as { focusIssueId?: string } | null)?.focusIssueId ?? null;

  useEffect(() => {
    refresh();
    getProject(projectId).then((p) => setProjectName(p?.name ?? '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 오프라인 초안(현장 등록) — 진입/온라인 복귀 시 자동 동기화.
  useEffect(() => {
    const trySync = () => {
      setDraftCount(listDrafts(projectId).length);
      syncDrafts(projectId, authorName)
        .then((n) => {
          setDraftCount(listDrafts(projectId).length);
          if (n > 0) {
            setMsg(`오프라인 초안 ${n}건이 동기화되었습니다.`);
            refresh();
          }
        })
        .catch(() => {});
    };
    trySync();
    window.addEventListener('online', trySync);
    return () => window.removeEventListener('online', trySync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, authorName]);

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
      const meta: Record<string, unknown> = {};
      for (const f of TYPE_FIELDS[form.type]) {
        const v = (form.meta[f.key] ?? '').trim();
        if (v) meta[f.key] = v;
      }
      await createIssue(
        projectId,
        {
          title: form.title.trim(),
          description: form.description,
          type: form.type,
          meta,
          priority: form.priority,
          assignee_id: form.assignee_id || null,
          assignee_name: member?.name,
          due_date: form.due_date || null,
        },
        authorName,
      );
      setForm({ title: '', description: '', type: 'general', meta: {}, priority: 'normal', assignee_id: '', due_date: '' });
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

  // ---------- 필터·검색·정렬 파이프라인(3뷰 공용, 엑셀 export 에도 그대로 반영) ----------
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = issues
      .filter((i) => typeFilter === 'all' || i.type === typeFilter)
      .filter(
        (i) =>
          !ql ||
          i.title.toLowerCase().includes(ql) ||
          (i.description ?? '').toLowerCase().includes(ql) ||
          (i.assignee_name ?? '').toLowerCase().includes(ql) ||
          TYPE_FIELDS[i.type].some((f) => metaValue(i.meta, f.key).toLowerCase().includes(ql)),
      );
    // 칸반은 상태가 열이므로 상태 필터는 리스트/핀 뷰에서만 적용.
    if (view !== 'board' && filter !== 'all') list = list.filter((i) => i.status === filter);
    const sorted = [...list];
    if (sort === 'newest') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (sort === 'oldest') sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (sort === 'due')
      sorted.sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'));
    if (sort === 'priority') sorted.sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]);
    return sorted;
  }, [issues, typeFilter, q, filter, sort, view]);

  // 생성 순(오래된→최신) 순차 번호 — 간섭 저장 순서와 무관(#5).
  const numberOf = useMemo(() => {
    const m = new Map<string, number>();
    [...issues]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach((it, i) => m.set(it.id, i + 1));
    return m;
  }, [issues]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 무시 */
    }
  };

  const onExportXlsx = async () => {
    try {
      await exportIssuesXlsx(projectName, shown, issues);
    } catch (e) {
      setMsg(`엑셀 저장 실패: ${errMessage(e)}`);
    }
  };

  const openIssue = (id: string) => {
    setOpenId(id);
    onRead(id);
  };

  const openIssueObj = openId ? issues.find((i) => i.id === openId) ?? null : null;

  const detail = (issue: Issue) => (
    <IssueDetail
      issue={issue}
      allIssues={issues}
      projectName={projectName}
      canEdit={canEdit}
      members={members}
      authorName={authorName}
      onAssign={onAssign}
      onMeta={onMeta}
      onCommented={() => onRead(issue.id)}
      onChanged={refresh}
    />
  );

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">협업 · 이슈</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {draftCount > 0 && (
            <span className="issue-draft-badge" title="네트워크 연결 시 자동 동기화됩니다">
              📥 초안 {draftCount}건 대기
            </span>
          )}
          <button onClick={() => void onExportXlsx()} title="현재 필터·정렬이 반영된 목록을 엑셀로 저장">
            ⬇ 엑셀
          </button>
          {canEdit && (
            <button onClick={() => setQuickOpen(true)} title="사진·GPS 태그로 현장에서 빠르게 등록(오프라인 지원)">
              📷 현장 등록
            </button>
          )}
          {canEdit && (
            <button className="primary" onClick={() => setShowForm((s) => !s)}>
              {showForm ? '취소' : '＋ 이슈 등록'}
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <section className="card dash-edit">
          <h3>새 이슈</h3>
          <div className="dash-edit-row">
            <label>유형
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as IssueType, meta: {} })}
              >
                {ISSUE_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_ICON[t]} {TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
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
          {TYPE_FIELDS[form.type].length > 0 && (
            <div className="dash-edit-row">
              {TYPE_FIELDS[form.type].map((f) => (
                <TypeFieldInput
                  key={f.key}
                  def={f}
                  value={form.meta[f.key] ?? ''}
                  onChange={(v) => setForm({ ...form, meta: { ...form.meta, [f.key]: v } })}
                />
              ))}
            </div>
          )}
          <div className="dash-edit-row">
            <label className="grow">내용<input value={form.description} placeholder={form.type === 'rfi' ? '질의 내용' : '상세 내용'} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <button className="primary" onClick={onCreate}>등록</button>
          </div>
        </section>
      )}

      {/* 툴바 — 뷰 전환 · 타입 필터 · 검색 · 정렬 */}
      <div className="issue-toolbar">
        <div className="issue-view-switch" role="tablist" aria-label="이슈 보기 방식">
          {(
            [
              ['list', '☰ 리스트'],
              ['board', '📋 칸반'],
              ['pins', '📍 핀'],
            ] as [ViewMode, string][]
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setViewMode(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className="issue-type-chips">
          <button className={typeFilter === 'all' ? 'active' : ''} onClick={() => setTypeFilter('all')}>
            전체 {issues.length}
          </button>
          {ISSUE_TYPES.map((t) => (
            <button key={t} className={typeFilter === t ? 'active' : ''} onClick={() => setTypeFilter(t)}>
              {TYPE_ICON[t]} {TYPE_LABEL[t]} {issues.filter((i) => i.type === t).length}
            </button>
          ))}
        </div>
        <input
          className="issue-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 제목·내용·담당자·타입필드 검색"
          aria-label="이슈 검색"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="정렬">
          <option value="newest">최신순</option>
          <option value="oldest">오래된순</option>
          <option value="due">마감임박순</option>
          <option value="priority">우선순위순</option>
        </select>
      </div>

      {view !== 'board' && (
        <div className="issue-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>전체 {issues.length}</button>
          {ISSUE_STATUSES.map((s) => (
            <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
              {STATUS_LABEL[s]} {issues.filter((i) => i.status === s).length}
            </button>
          ))}
        </div>
      )}

      {view === 'list' && (
        <section className="card" style={{ padding: 0 }}>
          <div className="cde-table-wrap" style={{ padding: 0 }}>
            <table className="cde-table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>번호</th>
                  <th style={{ width: 90 }}>유형</th>
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
                    onToggle={() => {
                      const opening = openId !== it.id;
                      setOpenId(opening ? it.id : null);
                      if (opening) onRead(it.id);
                    }}
                    onStatus={onStatus}
                    onDelete={onDelete}
                    detail={detail}
                  />
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={8}><EmptyState compact icon="🗂" title="이슈가 없습니다" desc="새 이슈를 등록하면 여기에 표시됩니다." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'board' && (
        <KanbanBoard
          issues={shown}
          numberOf={numberOf}
          unread={unread}
          canEdit={canEdit}
          myId={myId}
          onStatus={onStatus}
          onOpen={openIssue}
        />
      )}

      {view === 'pins' && (
        <PinBoard
          projectId={projectId}
          issues={shown}
          numberOf={numberOf}
          onOpen={openIssue}
        />
      )}

      {/* 칸반/핀 뷰의 상세 = 모달(리스트 뷰는 기존 행 펼침 유지) */}
      {view !== 'list' && openIssueObj && (
        <div className="modal-backdrop" onClick={() => setOpenId(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TypeBadge type={openIssueObj.type} />
              <h3 style={{ flex: 1, margin: 0 }}>#{numberOf.get(openIssueObj.id)} {openIssueObj.title}</h3>
              <button onClick={() => setOpenId(null)} aria-label="닫기">✕</button>
            </div>
            <div className="modal-body">{detail(openIssueObj)}</div>
          </div>
        </div>
      )}

      {quickOpen && (
        <QuickFieldRegister
          projectId={projectId}
          authorName={authorName}
          onClose={() => setQuickOpen(false)}
          onDone={(offline) => {
            setQuickOpen(false);
            setDraftCount(listDrafts(projectId).length);
            if (offline) setMsg('오프라인 — 초안으로 저장했습니다. 온라인 복귀 시 자동 등록됩니다.');
            else {
              setMsg('현장 이슈 등록됨');
              refresh();
            }
          }}
        />
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

/** 타입별 전용 필드 입력(폼·상세 공용) — 선언 스키마(TYPE_FIELDS) 기반. */
function TypeFieldInput({
  def,
  value,
  onChange,
  grow,
}: {
  def: IssueFieldDef;
  value: string;
  onChange: (v: string) => void;
  grow?: boolean;
}) {
  return (
    <label className={grow || def.kind === 'textarea' ? 'grow' : undefined}>
      {def.label}
      {def.kind === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">선택</option>
          {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : def.kind === 'textarea' ? (
        <textarea value={value} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} rows={2} style={{ resize: 'vertical' }} />
      ) : (
        <input type={def.kind === 'date' ? 'date' : 'text'} value={value} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
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

// =====================================================================
// 칸반 보드 — 상태 열 + 카드 드래그로 상태 이동(HTML5 DnD).
// =====================================================================
function KanbanBoard({
  issues,
  numberOf,
  unread,
  canEdit,
  myId,
  onStatus,
  onOpen,
}: {
  issues: Issue[];
  numberOf: Map<string, number>;
  unread: Set<string>;
  canEdit: boolean;
  myId: string | null;
  onStatus: (issue: Issue, s: IssueStatus) => void;
  onOpen: (id: string) => void;
}) {
  const [overCol, setOverCol] = useState<IssueStatus | null>(null);
  const dragId = useRef<string | null>(null);

  const canDrag = (it: Issue) => canEdit || (!!myId && it.assignee_id === myId);

  const onDrop = (status: IssueStatus) => {
    const id = dragId.current;
    dragId.current = null;
    setOverCol(null);
    if (!id) return;
    const issue = issues.find((i) => i.id === id);
    if (issue && issue.status !== status) onStatus(issue, status);
  };

  return (
    <div className="kanban-board">
      {ISSUE_STATUSES.map((s) => {
        const cols = issues.filter((i) => i.status === s);
        return (
          <div
            key={s}
            className={`kanban-col${overCol === s ? ' is-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(s);
            }}
            onDragLeave={() => setOverCol((c) => (c === s ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(s);
            }}
          >
            <div className="kanban-col__h">
              <span className={`issue-badge issue-${s}`}>{STATUS_LABEL[s]}</span>
              <span className="muted">{cols.length}</span>
            </div>
            <div className="kanban-col__b">
              {cols.map((it) => {
                const ds = it.due_date ? dueState(it.due_date, it.status) : 'none';
                return (
                  <div
                    key={it.id}
                    className="kanban-card"
                    draggable={canDrag(it)}
                    onDragStart={(e) => {
                      dragId.current = it.id;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      dragId.current = null;
                      setOverCol(null);
                    }}
                    onClick={() => onOpen(it.id)}
                    title={canDrag(it) ? '드래그해서 상태 이동 · 클릭해서 상세' : '클릭해서 상세'}
                  >
                    <div className="kanban-card__top">
                      <TypeBadge type={it.type} />
                      <span className="muted">#{numberOf.get(it.id)}</span>
                      {unread.has(it.id) && <span className="issue-unread-dot" title="새 코멘트(안읽음)" />}
                    </div>
                    <div className="kanban-card__title">{it.title}</div>
                    <div className="kanban-card__meta">
                      <span className={`issue-prio issue-prio-${it.priority}`}>{PRIORITY_LABEL[it.priority]}</span>
                      {it.type !== 'general' && (
                        <span className="muted">{statusLabelFor(it.type, it.status, '')}</span>
                      )}
                      {it.assignee_name && <span className="muted">👤 {it.assignee_name}</span>}
                      {it.due_date && (ds === 'overdue' || ds === 'soon') && (
                        <span className={`due-badge due-${ds}`}>{DUE_LABEL[ds]} {dueDeltaLabel(it.due_date)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {cols.length === 0 && <div className="kanban-empty muted">비어 있음</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =====================================================================
// 핀 뷰 — 3D(GlobalId 앵커)·도면(drawing_pins) 위치 기반으로 이슈를 본다.
// 실제 핀 렌더는 통합모델(ApsIssuePins)·도면(DrawingSheet)이 담당 — 여기서
// 위치별로 모아 상호 점프한다.
// =====================================================================
function PinBoard({
  projectId,
  issues,
  numberOf,
  onOpen,
}: {
  projectId: string;
  issues: Issue[];
  numberOf: Map<string, number>;
  onOpen: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [drawPins, setDrawPins] = useState<IssuePinRef[]>([]);

  useEffect(() => {
    listIssuePins(projectId).then(setDrawPins).catch(() => setDrawPins([]));
  }, [projectId]);

  const anchored3d = issues.filter((i) => i.global_id);
  const byId = new Map(issues.map((i) => [i.id, i]));
  // 도면별 그룹
  const byDrawing = new Map<string, { name: string; pins: IssuePinRef[] }>();
  for (const p of drawPins) {
    const g = byDrawing.get(p.drawing_id) ?? { name: p.drawing_name, pins: [] };
    g.pins.push(p);
    byDrawing.set(p.drawing_id, g);
  }

  const issueLine = (it: Issue, extra?: React.ReactNode) => (
    <div className="pinboard-row" key={it.id}>
      <TypeBadge type={it.type} />
      <button className="cde-link" onClick={() => onOpen(it.id)}>
        #{numberOf.get(it.id)} {it.title}
      </button>
      <span className={`issue-badge issue-${it.status}`}>{statusLabelFor(it.type, it.status, STATUS_LABEL[it.status])}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{extra}</span>
    </div>
  );

  return (
    <div className="pinboard">
      <section className="card issue-block">
        <div className="issue-block__h">
          <span>🧊 3D 모델 핀 · {anchored3d.length}</span>
          <button
            className="issue-block__chev"
            onClick={() => navigate(`/project/${projectId}/model`)}
            title="통합모델(3D)에서 전체 이슈 핀 보기"
          >
            3D에서 핀 보기 ›
          </button>
        </div>
        <div className="issue-block__b">
          {anchored3d.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              3D 앵커(부재 GlobalId)가 지정된 이슈가 없습니다. 통합모델(3D)에서 객체 선택 → '＋ 이슈'로 등록하세요.
            </p>
          )}
          {anchored3d.map((it) =>
            issueLine(
              it,
              <button
                onClick={() =>
                  navigate(
                    it.global_id_b
                      ? `/project/${projectId}/clash?focusClashA=${encodeURIComponent(it.global_id!)}&focusClashB=${encodeURIComponent(it.global_id_b)}`
                      : `/project/${projectId}/model?focusGlobalId=${encodeURIComponent(it.global_id!)}`,
                  )
                }
              >
                📍 위치 보기
              </button>,
            ),
          )}
        </div>
      </section>

      <section className="card issue-block">
        <div className="issue-block__h"><span>📐 도면 핀 · {drawPins.length}</span></div>
        <div className="issue-block__b">
          {byDrawing.size === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              도면에 연결된 이슈 핀이 없습니다. 도면(2D)에서 핀을 찍고 이슈를 연결하세요.
            </p>
          )}
          {[...byDrawing.entries()].map(([dId, g]) => (
            <div key={dId} className="pinboard-group">
              <div className="pinboard-group__h">
                <span>📐 {g.name} · {g.pins.length}</span>
                <button onClick={() => navigate(`/project/${projectId}/drawings`, { state: { openDrawingId: dId } })}>
                  도면 열기 ›
                </button>
              </div>
              {g.pins.map((p) => {
                const it = p.issue_id ? byId.get(p.issue_id) : null;
                if (!it) return null;
                return issueLine(
                  it,
                  <span className="muted nowrap">p.{p.page}{p.label ? ` · ${p.label}` : ''}</span>,
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function IssueRow({
  num,
  issue,
  open,
  unread,
  canEdit,
  myId,
  onToggle,
  onStatus,
  onDelete,
  detail,
}: {
  num: number;
  issue: Issue;
  open: boolean;
  unread: boolean;
  canEdit: boolean;
  myId: string | null;
  onToggle: () => void;
  onStatus: (issue: Issue, s: IssueStatus) => void;
  onDelete: (id: string) => void;
  detail: (issue: Issue) => React.ReactNode;
}) {
  // 담당자 본인도 자기 이슈의 상태를 변경할 수 있다(S30 결정).
  const canStatus = canEdit || (!!myId && issue.assignee_id === myId);
  return (
    <>
      <tr>
        <td className="nowrap" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{num}</td>
        <td className="nowrap"><TypeBadge type={issue.type} /></td>
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
        <td><span className={`issue-badge issue-${issue.status}`}>{statusLabelFor(issue.type, issue.status, STATUS_LABEL[issue.status])}</span></td>
        <td><span className={`issue-prio issue-prio-${issue.priority}`}>{PRIORITY_LABEL[issue.priority]}</span></td>
        <td className="nowrap">{issue.assignee_name || '—'}</td>
        <td><DueCell issue={issue} /></td>
        <td className="right nowrap">
          {canStatus ? (
            <select value={issue.status} onChange={(e) => onStatus(issue, e.target.value as IssueStatus)} aria-label="상태 변경">
              {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{statusLabelFor(issue.type, s, STATUS_LABEL[s])}</option>)}
            </select>
          ) : (
            <span className="muted">—</span>
          )}
          {canEdit && <button className="danger" onClick={() => onDelete(issue.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={8}>{detail(issue)}</td>
        </tr>
      )}
    </>
  );
}

function IssueDetail({
  issue,
  allIssues,
  projectName,
  canEdit,
  members,
  authorName,
  onAssign,
  onMeta,
  onCommented,
  onChanged,
}: {
  issue: Issue;
  allIssues: Issue[];
  projectName: string;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
  onAssign: (issue: Issue, assigneeId: string) => void;
  onMeta: (issue: Issue, fields: { priority?: IssuePriority; due_date?: string | null; description?: string | null }) => Promise<void> | void;
  onCommented: () => void;
  onChanged: () => void;
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
  // 타입별 전용 필드 편집 초안(meta jsonb).
  const [typeOpen, setTypeOpen] = useState(false);
  const [metaDraft, setMetaDraft] = useState<Record<string, string>>({});
  // 3D 뷰포인트/마크업 첨부(0038).
  const [viewpoints, setViewpoints] = useState<IssueViewpoint[]>([]);
  const [markupVp, setMarkupVp] = useState<IssueViewpoint | null>(null);
  // 이 이슈에 연결된 도면 핀(상호 점프).
  const [drawPins, setDrawPins] = useState<IssuePinRef[]>([]);
  // 파일별 다운로드 진행률(동시 다운로드 지원 — 다른 파일을 눌러도 기존 것이 이어짐).
  const [dls, setDls] = useState<Record<string, number | null>>({});
  const [previewFile, setPreviewFile] = useState<IssueFileLink | null>(null);
  const [showAllComments, setShowAllComments] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const hasLocation = !!issue.model_id && issue.express_id != null;
  const hasGlobal = !!issue.global_id; // APS/ACC 앵커(S49) — GlobalId→dbId 위치보기

  const assignedMember = members.find((m) => m.id === issue.assignee_id) ?? null;
  const typeFields = TYPE_FIELDS[issue.type];
  const site = siteTagOf(issue.meta);

  useEffect(() => {
    listComments(issue.id).then(setComments).catch(() => setComments([]));
    listEvents(issue.id).then(setEvents).catch(() => setEvents([]));
    listIssueFiles(issue.id).then(setFiles).catch(() => setFiles([]));
    listIssueViewpoints(issue.id).then(setViewpoints).catch(() => setViewpoints([]));
    listPinsForIssue(issue.id).then(setDrawPins).catch(() => setDrawPins([]));
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
        sizeBytes: f.size,
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
      await downloadAccItemProgress(
        f.acc_project_id,
        f.acc_item_id,
        f.name,
        (frac) => setDls((d) => ({ ...d, [f.id]: frac == null ? null : Math.round(frac * 100) })),
        f.size_bytes,
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

  const openTypeEdit = () => {
    const init: Record<string, string> = {};
    for (const f of typeFields) init[f.key] = metaValue(issue.meta, f.key);
    setMetaDraft(init);
    setTypeOpen(true);
  };

  const saveTypeFields = async () => {
    try {
      const patch: Record<string, unknown> = {};
      const changed: string[] = [];
      for (const f of typeFields) {
        const v = (metaDraft[f.key] ?? '').trim();
        if (v !== metaValue(issue.meta, f.key)) {
          patch[f.key] = v || null;
          changed.push(f.label);
        }
      }
      if (changed.length) {
        await updateIssueTypeFields(issue, patch, changed.join('·'), authorName);
        onChanged();
        refreshEvents();
      }
      setTypeOpen(false);
    } catch (e) {
      alert(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onRemoveViewpoint = async (vp: IssueViewpoint) => {
    if (!window.confirm('이 뷰포인트를 삭제할까요?')) return;
    try {
      await removeIssueViewpoint(vp.id);
      setViewpoints((vs) => vs.filter((v) => v.id !== vp.id));
      await logIssueEvent(issue.id, issue.project_id, 'viewpoint_del', vp.title || '뷰포인트', authorName);
      refreshEvents();
    } catch (e) {
      alert(`삭제 실패: ${errMessage(e)}`);
    }
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

  const onFormDocx = () => {
    exportIssueFormDocx(issue, allIssues, projectName, authorName).catch((e) => alert(`양식 저장 실패: ${errMessage(e)}`));
  };
  const onFormPrint = async () => {
    try {
      const atts = await listAttachments('issue', issue.id).catch(() => []);
      await openIssueFormPrint(issue, allIssues, projectName, atts, viewpoints);
    } catch (e) {
      alert(`양식 열기 실패: ${errMessage(e)}`);
    }
  };

  const hasAnyLocation = hasLocation || hasGlobal || !!issue.viewpoint_id || drawPins.length > 0;

  return (
    <div className="issue-detail issue-report">
      {/* 속성 — 요약(유형·상태·우선순위·담당·마감)은 항상, 편집은 펼쳐서 */}
      <section className="issue-block">
        <button className="issue-block__h issue-block__toggle" onClick={() => setPropOpen((o) => !o)} aria-expanded={propOpen}>
          <span>속성</span>
          {canEdit && <span className="issue-block__chev">{propOpen ? '▾ 설정 접기' : '▸ 설정 편집'}</span>}
        </button>
        <div className="issue-block__b">
          <div className="issue-facts">
            <span><b>유형</b> <TypeBadge type={issue.type} /></span>
            <span><b>상태</b> <span className={`issue-badge issue-${issue.status}`}>{statusLabelFor(issue.type, issue.status, STATUS_LABEL[issue.status])}</span></span>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={onFormDocx} title="회사 양식(.docx)으로 저장 — RFI 는 질의서, 그 외 지적통보서">📄 양식(.docx)</button>
            <button onClick={() => void onFormPrint()} title="인쇄 창에서 'PDF로 저장' 선택 시 양식 PDF">🖨 양식 인쇄·PDF</button>
          </div>
        </div>
      </section>

      {/* 타입별 정보 — RFI 상대처/응답기한/응답, 하자 위치/협력사/심각도, 안전 위험요소/조치 … */}
      {typeFields.length > 0 && (
        <section className="issue-block">
          <button
            className="issue-block__h issue-block__toggle"
            onClick={() => { if (!canEdit) return; if (!typeOpen) openTypeEdit(); else setTypeOpen(false); }}
            aria-expanded={typeOpen}
          >
            <span>{TYPE_ICON[issue.type]} {TYPE_LABEL[issue.type]} 정보</span>
            {canEdit && <span className="issue-block__chev">{typeOpen ? '▾ 편집 닫기' : '▸ 편집'}</span>}
          </button>
          <div className="issue-block__b">
            {typeOpen ? (
              <div>
                <div className="dash-edit-row" style={{ flexWrap: 'wrap' }}>
                  {typeFields.map((f) => (
                    <TypeFieldInput
                      key={f.key}
                      def={f}
                      value={metaDraft[f.key] ?? ''}
                      onChange={(v) => setMetaDraft((d) => ({ ...d, [f.key]: v }))}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button className="primary" onClick={() => void saveTypeFields()}>저장</button>
                  <button onClick={() => setTypeOpen(false)}>취소</button>
                </div>
              </div>
            ) : (
              <div className="issue-facts">
                {typeFields.map((f) => {
                  const v = metaValue(issue.meta, f.key);
                  return (
                    <span key={f.key}><b>{f.label}</b> {v || <span className="muted">—</span>}</span>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 내용 (+ 편집 + 위치 보기) — 헤더 토글 양식은 속성과 동일 */}
      <section className="issue-block">
        <button
          className="issue-block__h issue-block__toggle"
          onClick={() => { if (!canEdit) return; if (!editContent) setDescDraft(issue.description ?? ''); setEditContent((o) => !o); }}
          aria-expanded={editContent}
        >
          <span>내용</span>
          {canEdit && <span className="issue-block__chev">{editContent ? '▾ 편집 닫기' : '▸ 편집'}</span>}
        </button>
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
            {site && (
              <> · 📍 GPS {site.lat.toFixed(6)}, {site.lng.toFixed(6)} ({new Date(site.taken_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })})</>
            )}
          </p>
          {hasAnyLocation && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {hasGlobal && (
                <button
                  onClick={() =>
                    navigate(
                      issue.global_id_b
                        ? `/project/${issue.project_id}/clash?focusClashA=${encodeURIComponent(issue.global_id!)}&focusClashB=${encodeURIComponent(issue.global_id_b)}`
                        : `/project/${issue.project_id}/model?focusGlobalId=${encodeURIComponent(issue.global_id!)}`,
                    )
                  }
                >
                  📍 위치 보기 {issue.global_id_b ? '(간섭 뷰)' : '(3D 모델)'}
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
              {drawPins.map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    navigate(`/project/${issue.project_id}/drawings`, { state: { openDrawingId: p.drawing_id } })
                  }
                  title="이 이슈가 핀으로 찍힌 도면 열기"
                >
                  📐 도면에서 보기 — {p.drawing_name} (p.{p.page})
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 3D 뷰포인트/마크업 — 협의 근거 화면(카메라 state + 도형)을 이슈에 잔존 */}
      <section className="issue-block">
        <div className="issue-block__h">3D 뷰포인트 · {viewpoints.length}</div>
        <div className="issue-block__b">
          {viewpoints.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              저장된 3D 뷰가 없습니다. 통합모델(3D)에서 이슈 핀 팝업의 '📌 현재 뷰 저장'으로 추가합니다.
            </p>
          )}
          {viewpoints.length > 0 && (
            <div className="issue-vp-grid">
              {viewpoints.map((vp) => (
                <div className="issue-vp" key={vp.id}>
                  <div className="issue-vp__shot">
                    {vp.snapshot ? (
                      <>
                        <img src={vp.snapshot} alt={vp.title ?? '뷰포인트'} />
                        <MarkupOverlay
                          shapes={vp.markup}
                          onChange={() => {}}
                          active={false}
                          tool="select"
                          color="red"
                          selected={null}
                          onSelect={() => {}}
                        />
                      </>
                    ) : (
                      <span className="muted">스냅샷 없음</span>
                    )}
                  </div>
                  <div className="issue-vp__meta">
                    <span className="issue-vp__title" title={vp.title ?? ''}>{vp.title || '뷰포인트'}</span>
                    <span className="muted">{vp.created_by_name || '—'} · {fmtDateTime(vp.created_at)}</span>
                  </div>
                  <div className="issue-vp__acts">
                    {vp.camera_state != null && (
                      <button
                        onClick={() =>
                          navigate(`/project/${issue.project_id}/model`, { state: { applyApsState: vp.camera_state } })
                        }
                        title="통합모델(3D)에서 이 시점으로 열기"
                      >
                        🧊 3D에서 열기
                      </button>
                    )}
                    {canEdit && vp.snapshot && (
                      <button onClick={() => setMarkupVp(vp)} title="스냅샷 위에 마크업(도형) 그리기">✏ 마크업</button>
                    )}
                    {canEdit && <button className="danger" onClick={() => void onRemoveViewpoint(vp)}>✕</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 사진·이미지 — 간섭검토 자동 캡처 + 현장 등록 사진(읽기전용) */}
      <section className="issue-block">
        <div className="issue-block__h">사진·이미지</div>
        <div className="issue-block__b">
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>간섭 검토·현장 등록 시 자동으로 추가됩니다.</p>
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
      {markupVp && (
        <MarkupEditor
          viewpoint={markupVp}
          onClose={() => setMarkupVp(null)}
          onSaved={(shapes) => {
            setViewpoints((vs) => vs.map((v) => (v.id === markupVp.id ? { ...v, markup: shapes } : v)));
            setMarkupVp(null);
          }}
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

// =====================================================================
// 뷰포인트 스냅샷 마크업 편집기 — MarkupOverlay(정규화 도형) 재사용.
// =====================================================================
function MarkupEditor({
  viewpoint,
  onClose,
  onSaved,
}: {
  viewpoint: IssueViewpoint;
  onClose: () => void;
  onSaved: (shapes: MarkupShape[]) => void;
}) {
  const [shapes, setShapes] = useState<MarkupShape[]>(viewpoint.markup);
  const [tool, setTool] = useState<MarkupTool>('rect');
  const [color, setColor] = useState<RedlineColor>('red');
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateIssueViewpointMarkup(viewpoint.id, shapes);
      onSaved(shapes);
    } catch (e) {
      alert(`마크업 저장 실패: ${errMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const TOOLS: [MarkupTool, string][] = [
    ['select', '☝ 선택'],
    ['line', '─ 선'],
    ['rect', '▭ 사각형'],
    ['arrow', '➜ 화살표'],
    ['text', 'T 텍스트'],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ flex: 1, margin: 0 }}>✏ 마크업 — {viewpoint.title || '뷰포인트'}</h3>
          <button onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            {TOOLS.map(([t, label]) => (
              <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)} aria-pressed={tool === t}>
                {label}
              </button>
            ))}
            <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }}>
              {REDLINE_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`색 ${c}`}
                  style={{
                    width: 22,
                    height: 22,
                    padding: 0,
                    borderRadius: 999,
                    background: `var(--redline-${c})`,
                    outline: color === c ? '2px solid var(--color-brand-solid, #2563eb)' : 'none',
                  }}
                />
              ))}
            </span>
            {selected != null && (
              <button
                className="danger"
                onClick={() => {
                  setShapes((ss) => ss.filter((_, i) => i !== selected));
                  setSelected(null);
                }}
              >
                선택 도형 삭제
              </button>
            )}
          </div>
          <div className="issue-vp-editor">
            <img src={viewpoint.snapshot ?? ''} alt="스냅샷" />
            <MarkupOverlay
              shapes={shapes}
              onChange={setShapes}
              active
              tool={tool}
              color={color}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// 현장(모바일) 빠른 등록 — 사진(GPS·시간 태깅) + 오프라인 초안.
// =====================================================================
function QuickFieldRegister({
  projectId,
  authorName,
  onClose,
  onDone,
}: {
  projectId: string;
  authorName: string | null;
  onClose: () => void;
  onDone: (offline: boolean) => void;
}) {
  const [type, setType] = useState<IssueType>('punch');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [photo, setPhoto] = useState<{ dataUrl: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gpsNote, setGpsNote] = useState('위치는 등록 시 자동 태깅됩니다.');
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await photoToDataUrl(file);
      setPhoto({ dataUrl, name: file.name || `site_${Date.now()}.jpg` });
    } catch (err) {
      alert(errMessage(err));
    }
  };

  const submit = async () => {
    if (!title.trim()) {
      alert('제목을 입력하세요');
      return;
    }
    setBusy(true);
    setGpsNote('GPS 위치 확인 중…');
    const site = await getSiteTag();
    setGpsNote(site ? `GPS ${site.lat.toFixed(5)}, ${site.lng.toFixed(5)}` : 'GPS 미확인(태그 없이 등록)');
    const base = {
      project_id: projectId,
      title: title.trim(),
      description: desc.trim(),
      type,
      priority: 'normal' as IssuePriority,
      meta: {},
      site,
      photo: photo?.dataUrl ?? null,
      photo_name: photo?.name ?? null,
    };
    if (!navigator.onLine) {
      saveDraft(projectId, base);
      setBusy(false);
      onDone(true);
      return;
    }
    try {
      const meta: Record<string, unknown> = {};
      if (site) meta.site = site;
      const issueId = await createIssue(
        projectId,
        { title: base.title, description: base.description || undefined, type, meta, priority: 'normal' },
        authorName,
      );
      if (photo) {
        const f = dataUrlToFile(photo.dataUrl, photo.name);
        await uploadAttachment(projectId, 'issue', issueId, f);
        await logIssueEvent(issueId, projectId, 'file_add', photo.name, authorName);
      }
      onDone(false);
    } catch {
      // 네트워크/일시 오류 — 초안으로 보존해 유실 방지.
      saveDraft(projectId, base);
      onDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ display: 'flex', alignItems: 'center' }}>
          <h3 style={{ flex: 1, margin: 0 }}>📷 현장 등록</h3>
          <button onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="modal-body">
          <label style={{ display: 'block', marginBottom: 8 }}>유형
            <select value={type} onChange={(e) => setType(e.target.value as IssueType)} style={{ width: '100%' }}>
              {ISSUE_TYPES.map((t) => <option key={t} value={t}>{TYPE_ICON[t]} {TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>제목
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 3층 벽체 균열" style={{ width: '100%' }} />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>내용
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} placeholder="현장 상황 설명" />
          </label>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPickPhoto(e)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => fileRef.current?.click()}>📸 사진 {photo ? '다시 찍기' : '촬영/선택'}</button>
            <span className="muted" style={{ fontSize: 12 }}>{gpsNote}</span>
          </div>
          {photo && (
            <img src={photo.dataUrl} alt="현장 사진" style={{ marginTop: 8, maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
          )}
          {!navigator.onLine && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              ⚠ 오프라인 — 초안으로 저장되고 온라인 복귀 시 자동 등록됩니다.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '등록 중…' : '등록'}
          </button>
        </div>
      </div>
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
    case 'meta': return `타입별 정보 수정 — ${ev.to_value ?? ''}`;
    case 'viewpoint_add': return `3D 뷰포인트 추가 — ${ev.to_value ?? ''}`;
    case 'viewpoint_del': return `3D 뷰포인트 삭제 — ${ev.to_value ?? ''}`;
    case 'file_add': return `관련 자료 추가 — ${ev.to_value ?? ''}`;
    case 'file_download': return `자료 다운로드 — ${ev.to_value ?? ''}`;
    case 'comment': return `코멘트 — ${ev.to_value ?? ''}`;
    default: return ev.kind;
  }
}
