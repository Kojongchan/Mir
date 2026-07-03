import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Attachments } from '../components/Attachments';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import { listDrawings, type Drawing } from '../lib/drawings';
import {
  RFI_DISCIPLINES,
  RFI_DUE_LABEL,
  RFI_PARTIES,
  RFI_PRIORITIES,
  RFI_PRIORITY_LABEL,
  RFI_STATUSES,
  RFI_STATUS_LABEL,
  addRfiComment,
  answerRfi,
  assignRfi,
  createRfi,
  deleteRfi,
  listRfiComments,
  listRfiEvents,
  listRfis,
  rfiDueDeltaLabel,
  rfiDueState,
  setRfiStatus,
  type Rfi,
  type RfiComment,
  type RfiEvent,
  type RfiPriority,
  type RfiStatus,
} from '../lib/rfi';

/** R1 — RFI(정보요청서) 관리. 상태 워크플로우·SLA·3D/도면 핀 연동 트래커. */
export function RfiPage() {
  const { projectId = '' } = useParams();
  const { profile, session } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const myId = session?.user.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [rfis, setRfis] = useState<Rfi[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [statusFilter, setStatusFilter] = useState<RfiStatus | 'all'>('all');
  const [discFilter, setDiscFilter] = useState<string>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const emptyForm = {
    title: '',
    question: '',
    discipline: '',
    from_party: '',
    priority: 'normal' as RfiPriority,
    to_assignee: '',
    due_date: '',
    drawing_id: '',
  };
  const [form, setForm] = useState(emptyForm);

  // 3D 뷰어의 "＋ RFI" 로 들어오면 해당 RFI 를 펼친다.
  const location = useLocation();
  const focusRfiId = (location.state as { focusRfiId?: string } | null)?.focusRfiId ?? null;

  useEffect(() => {
    refresh();
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    listDrawings(projectId).then(setDrawings).catch(() => setDrawings([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (focusRfiId) setOpenId(focusRfiId);
  }, [focusRfiId]);

  const refresh = () =>
    listRfis(projectId)
      .then((list) => {
        setRfis(list);
        setUnavailable(false);
      })
      .catch(() => {
        // 0032 미적용 등 — 목록만 비우고 앱은 유지(폴백).
        setRfis([]);
        setUnavailable(true);
      });

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      const member = members.find((m) => m.id === form.to_assignee);
      await createRfi(
        projectId,
        {
          title: form.title.trim(),
          question: form.question,
          discipline: form.discipline || null,
          from_party: form.from_party || null,
          priority: form.priority,
          to_assignee: form.to_assignee || null,
          to_assignee_name: member?.name ?? null,
          due_date: form.due_date || null,
          drawing_id: form.drawing_id || null,
        },
        authorName,
      );
      setForm(emptyForm);
      setShowForm(false);
      await refresh();
      setMsg('RFI 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onStatus = async (rfi: Rfi, status: RfiStatus) => {
    try {
      await setRfiStatus(rfi, status, authorName);
      await refresh();
    } catch (e) {
      setMsg(`상태 변경 실패: ${errMessage(e)}`);
    }
  };

  const onAssign = async (rfi: Rfi, assigneeId: string) => {
    const member = members.find((m) => m.id === assigneeId);
    try {
      await assignRfi(rfi, assigneeId || null, member?.name ?? null, authorName);
      await refresh();
    } catch (e) {
      setMsg(`담당자 배정 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 RFI 를 삭제할까요?')) return;
    await deleteRfi(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const disciplines = useMemo(() => {
    const set = new Set<string>();
    rfis.forEach((r) => r.discipline && set.add(r.discipline));
    return Array.from(set);
  }, [rfis]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rfis.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (discFilter !== 'all' && r.discipline !== discFilter) return false;
      if (assigneeFilter !== 'all') {
        if (assigneeFilter === 'none' ? r.to_assignee : r.to_assignee !== assigneeFilter) return false;
      }
      if (q) {
        const hay = `#${r.rfi_no} ${r.title} ${r.question ?? ''} ${r.answer ?? ''} ${r.from_party ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rfis, statusFilter, discFilter, assigneeFilter, query]);

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">RFI · 정보요청서</h1>
        {canEdit && !unavailable && (
          <button className="primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? '취소' : '＋ RFI 등록'}
          </button>
        )}
      </div>

      {unavailable && (
        <EmptyState
          icon="📨"
          title="RFI 모듈이 아직 활성화되지 않았습니다"
          desc="데이터베이스 마이그레이션(0032)이 적용되면 정보요청서를 관리할 수 있습니다."
        />
      )}

      {!unavailable && (
        <>
          {showForm && (
            <section className="card dash-edit">
              <h3>새 RFI</h3>
              <div className="dash-edit-row">
                <label className="grow">
                  제목
                  <input
                    value={form.title}
                    placeholder="예: 3층 코어 벽체 개구부 위치 확인 요청"
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </label>
                <label>
                  공종
                  <select value={form.discipline} onChange={(e) => setForm({ ...form, discipline: e.target.value })}>
                    <option value="">미지정</option>
                    {RFI_DISCIPLINES.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  상대처
                  <select value={form.from_party} onChange={(e) => setForm({ ...form, from_party: e.target.value })}>
                    <option value="">미지정</option>
                    {RFI_PARTIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <label>
                  우선순위
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as RfiPriority })}>
                    {RFI_PRIORITIES.map((p) => (
                      <option key={p} value={p}>{RFI_PRIORITY_LABEL[p]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  담당자
                  <select value={form.to_assignee} onChange={(e) => setForm({ ...form, to_assignee: e.target.value })}>
                    <option value="">미지정</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  응답 기한(SLA)
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
                </label>
                <label>
                  연결 도면
                  <select value={form.drawing_id} onChange={(e) => setForm({ ...form, drawing_id: e.target.value })}>
                    <option value="">없음</option>
                    {drawings.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">
                  질의 내용
                  <textarea
                    value={form.question}
                    placeholder="요청하는 정보를 구체적으로 기재하세요."
                    rows={3}
                    onChange={(e) => setForm({ ...form, question: e.target.value })}
                  />
                </label>
              </div>
              <div className="dash-edit-row">
                <button className="primary" onClick={onCreate}>등록</button>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                3D 부재에 핀을 꽂으려면 통합모델(3D)에서 부재 선택 후 "＋ RFI" 를 사용하세요.
              </p>
            </section>
          )}

          <div className="issue-filters">
            <button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>
              전체 {rfis.length}
            </button>
            {RFI_STATUSES.map((s) => (
              <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
                {RFI_STATUS_LABEL[s]} {rfis.filter((r) => r.status === s).length}
              </button>
            ))}
          </div>

          <div className="rfi-toolbar">
            <input
              className="rfi-search"
              value={query}
              placeholder="🔍 제목·질의·응답 검색"
              onChange={(e) => setQuery(e.target.value)}
            />
            <select value={discFilter} onChange={(e) => setDiscFilter(e.target.value)} aria-label="공종 필터">
              <option value="all">공종 전체</option>
              {disciplines.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} aria-label="담당 필터">
              <option value="all">담당 전체</option>
              <option value="none">미지정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>번호</th>
                    <th>제목</th>
                    <th>상대처</th>
                    <th>공종</th>
                    <th>상태</th>
                    <th>담당</th>
                    <th>기한(SLA)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <RfiRow
                      key={r.id}
                      rfi={r}
                      open={openId === r.id}
                      canEdit={canEdit}
                      myId={myId}
                      members={members}
                      drawings={drawings}
                      authorName={authorName}
                      onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                      onStatus={onStatus}
                      onAssign={onAssign}
                      onDelete={onDelete}
                      onChanged={refresh}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState compact icon="📨" title="RFI 가 없습니다" desc="새 정보요청서를 등록하면 여기에 표시됩니다." />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

/** 기한(SLA) 셀 — 임박/지연 뱃지 + D-표기. */
function SlaCell({ rfi }: { rfi: Rfi }) {
  if (!rfi.due_date) return <span className="muted">—</span>;
  const state = rfiDueState(rfi.due_date, rfi.status);
  return (
    <span className="nowrap">
      <span className="tabular">{formatDate(rfi.due_date)}</span>
      {(state === 'overdue' || state === 'soon') && (
        <span className={`due-badge due-${state}`}>
          {RFI_DUE_LABEL[state]} <span className="tabular">{rfiDueDeltaLabel(rfi.due_date)}</span>
        </span>
      )}
    </span>
  );
}

function RfiRow({
  rfi,
  open,
  canEdit,
  myId,
  members,
  drawings,
  authorName,
  onToggle,
  onStatus,
  onAssign,
  onDelete,
  onChanged,
}: {
  rfi: Rfi;
  open: boolean;
  canEdit: boolean;
  myId: string | null;
  members: ProjectMember[];
  drawings: Drawing[];
  authorName: string | null;
  onToggle: () => void;
  onStatus: (rfi: Rfi, s: RfiStatus) => void;
  onAssign: (rfi: Rfi, assigneeId: string) => void;
  onDelete: (id: string) => void;
  onChanged: () => void;
}) {
  // 담당자 본인도 자기 RFI 상태 변경/응답 가능(이슈 관례 동일).
  const canAct = canEdit || (!!myId && rfi.to_assignee === myId);
  return (
    <>
      <tr>
        <td className="nowrap tabular" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{rfi.rfi_no}</td>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{rfi.title}</button>
        </td>
        <td className="nowrap">{rfi.from_party || '—'}</td>
        <td className="nowrap">{rfi.discipline || '—'}</td>
        <td><span className={`issue-badge rfi-${rfi.status}`}>{RFI_STATUS_LABEL[rfi.status]}</span></td>
        <td className="nowrap">{rfi.to_assignee_name || '—'}</td>
        <td><SlaCell rfi={rfi} /></td>
        <td className="right nowrap">
          {canAct ? (
            <select value={rfi.status} onChange={(e) => onStatus(rfi, e.target.value as RfiStatus)} aria-label="상태 변경">
              {RFI_STATUSES.map((s) => (
                <option key={s} value={s}>{RFI_STATUS_LABEL[s]}</option>
              ))}
            </select>
          ) : (
            <span className="muted">—</span>
          )}
          {canEdit && <button className="danger" onClick={() => onDelete(rfi.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={8}>
            <RfiDetail
              rfi={rfi}
              canEdit={canEdit}
              canAct={canAct}
              members={members}
              drawings={drawings}
              authorName={authorName}
              onAssign={onAssign}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function RfiDetail({
  rfi,
  canEdit,
  canAct,
  members,
  drawings,
  authorName,
  onAssign,
  onChanged,
}: {
  rfi: Rfi;
  canEdit: boolean;
  canAct: boolean;
  members: ProjectMember[];
  drawings: Drawing[];
  authorName: string | null;
  onAssign: (rfi: Rfi, assigneeId: string) => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [comments, setComments] = useState<RfiComment[]>([]);
  const [events, setEvents] = useState<RfiEvent[]>([]);
  const [body, setBody] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [msg, setMsg] = useState('');
  const drawing = drawings.find((d) => d.id === rfi.drawing_id);

  useEffect(() => {
    listRfiComments(rfi.id).then(setComments).catch(() => setComments([]));
    listRfiEvents(rfi.id).then(setEvents).catch(() => setEvents([]));
  }, [rfi.id, rfi.status, rfi.to_assignee, rfi.answer]);

  const onAddComment = async () => {
    if (!body.trim()) return;
    await addRfiComment(rfi, body.trim(), authorName);
    setBody('');
    setComments(await listRfiComments(rfi.id));
  };

  const onSaveAnswer = async () => {
    if (!answerDraft.trim()) return;
    try {
      await answerRfi(rfi, answerDraft.trim(), authorName);
      setAnswerDraft('');
      setMsg('응답이 등록되었습니다.');
      onChanged();
    } catch (e) {
      setMsg(`응답 실패: ${errMessage(e)}`);
    }
  };

  return (
    <div className="issue-detail">
      {rfi.question && (
        <div className="rfi-thread-block">
          <span className="rfi-thread-tag rfi-thread-q">질의</span>
          <p className="issue-desc">{rfi.question}</p>
        </div>
      )}

      <p className="muted issue-meta">
        RFI #{rfi.rfi_no} · 등록 {rfi.created_by_name || '—'} · {formatDate(rfi.created_at.slice(0, 10))}
        {rfi.from_party ? ` · 상대처 ${rfi.from_party}` : ''}
      </p>

      {rfi.answer && (
        <div className="rfi-thread-block rfi-answer">
          <span className="rfi-thread-tag rfi-thread-a">응답</span>
          <p className="issue-desc">{rfi.answer}</p>
          {rfi.answered_at && (
            <p className="muted" style={{ fontSize: 11, margin: 0 }}>{new Date(rfi.answered_at).toLocaleString('ko-KR')}</p>
          )}
        </div>
      )}

      {canAct && !rfi.answer && (
        <div className="rfi-answer-form">
          <label className="rfi-thread-tag rfi-thread-a" htmlFor={`ans-${rfi.id}`}>응답 작성</label>
          <textarea
            id={`ans-${rfi.id}`}
            value={answerDraft}
            rows={2}
            placeholder="요청에 대한 답변을 작성하세요. 저장 시 상태가 '답변'으로 전환됩니다."
            onChange={(e) => setAnswerDraft(e.target.value)}
          />
          <button className="primary" onClick={onSaveAnswer}>응답 등록</button>
        </div>
      )}

      {canEdit && (
        <div className="issue-assign-row">
          <label>담당자 배정
            <select value={rfi.to_assignee ?? ''} onChange={(e) => onAssign(rfi, e.target.value)}>
              <option value="">미지정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {(rfi.global_id || drawing) && (
        <p style={{ margin: '0 0 10px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {rfi.global_id && (
            <button
              onClick={() =>
                navigate(`/project/${rfi.project_id}/model?focusGlobalId=${encodeURIComponent(rfi.global_id!)}`)
              }
            >
              📍 위치 보기 (3D 부재)
            </button>
          )}
          {drawing && (
            <button onClick={() => navigate(`/project/${rfi.project_id}/drawings`)}>
              📐 연결 도면 열기 ({drawing.name})
            </button>
          )}
        </p>
      )}

      {events.length > 0 && (
        <div className="issue-history">
          <h4 className="issue-section-h">활동 로그</h4>
          {events.map((ev) => (
            <div className="issue-event" key={ev.id}>
              <span className="issue-event-when">{new Date(ev.created_at).toLocaleString('ko-KR')}</span>
              <span className="issue-event-text">{rfiEventText(ev)}</span>
              <span className="muted">{ev.actor_name || '—'}</span>
            </div>
          ))}
        </div>
      )}

      <Attachments
        projectId={rfi.project_id}
        targetType="rfi"
        targetId={rfi.id}
        canEdit={canEdit}
        label="첨부(도면·사진·스냅샷)"
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
      {canEdit && (
        <div className="issue-comment-add">
          <input value={body} placeholder="코멘트 입력" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddComment()} />
          <button onClick={onAddComment}>등록</button>
        </div>
      )}
      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}

function rfiEventText(ev: RfiEvent): string {
  if (ev.kind === 'created') return `RFI 생성 — ${ev.to_value ?? ''}`;
  if (ev.kind === 'status') return `상태 ${ev.from_value} → ${ev.to_value}`;
  if (ev.kind === 'answer') return `응답 등록 — ${ev.to_value ?? ''}`;
  return `담당자 ${ev.from_value} → ${ev.to_value}`;
}
