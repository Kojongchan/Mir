import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Attachments } from '../components/Attachments';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import {
  ACTION_STATUSES,
  ACTION_STATUS_CLASS,
  ACTION_STATUS_LABEL,
  DECISION_TYPES,
  DECISION_TYPE_LABEL,
  addActionItem,
  addDecision,
  createMeeting,
  deleteActionItem,
  deleteDecision,
  deleteMeeting,
  listActionItems,
  listDecisions,
  listMeetings,
  promoteActionToIssue,
  searchMeetings,
  setActionStatus,
  updateMeeting,
  type ActionItem,
  type ActionStatus,
  type DecisionType,
  type Meeting,
  type MeetingDecision,
  type MeetingSearchHit,
} from '../lib/meetings';

/** R2 — 회의록 · 의사결정 로그. 회의록 CRUD + 결정 → 액션아이템(이슈 승격) + 전문검색. */
export function Meetings() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Meeting | null>(null);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MeetingSearchHit[] | null>(null);

  const empty = { title: '', meeting_date: new Date().toISOString().slice(0, 10), attendees: '', body: '' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () =>
    listMeetings(projectId)
      .then((list) => {
        setMeetings(list);
        setUnavailable(false);
      })
      .catch(() => {
        setMeetings([]);
        setUnavailable(true);
      });

  const startCreate = () => {
    setEditing(null);
    setForm(empty);
    setShowForm(true);
  };
  const startEdit = (m: Meeting) => {
    setEditing(m);
    setForm({
      title: m.title,
      meeting_date: m.meeting_date,
      attendees: m.attendees.join(', '),
      body: m.body ?? '',
    });
    setShowForm(true);
  };

  const onSubmit = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    const input = {
      title: form.title.trim(),
      meeting_date: form.meeting_date,
      attendees: form.attendees.split(',').map((s) => s.trim()).filter(Boolean),
      body: form.body,
    };
    try {
      if (editing) await updateMeeting(editing.id, input);
      else await createMeeting(projectId, input, authorName);
      setShowForm(false);
      setEditing(null);
      setForm(empty);
      await refresh();
      setMsg(editing ? '회의록 수정됨' : '회의록 등록됨');
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 회의록을 삭제할까요? (결정·액션아이템도 함께 삭제됩니다)')) return;
    await deleteMeeting(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const onSearch = async () => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    try {
      setHits(await searchMeetings(projectId, query));
    } catch (e) {
      setMsg(`검색 실패: ${errMessage(e)}`);
    }
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">회의록 · 의사결정</h1>
        {canEdit && !unavailable && (
          <button className="primary" onClick={showForm ? () => setShowForm(false) : startCreate}>
            {showForm ? '취소' : '＋ 회의록 작성'}
          </button>
        )}
      </div>

      {unavailable && (
        <EmptyState
          icon="📝"
          title="회의록 모듈이 아직 활성화되지 않았습니다"
          desc="데이터베이스 마이그레이션(0033)이 적용되면 회의록·의사결정을 관리할 수 있습니다."
        />
      )}

      {!unavailable && (
        <>
          {showForm && (
            <section className="card dash-edit">
              <h3>{editing ? '회의록 수정' : '새 회의록'}</h3>
              <div className="dash-edit-row">
                <label className="grow">
                  제목
                  <input value={form.title} placeholder="예: 3주차 공정 점검 회의" onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <label>
                  회의일
                  <input type="date" value={form.meeting_date} onChange={(e) => setForm({ ...form, meeting_date: e.target.value })} />
                </label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">
                  참석자 (쉼표로 구분)
                  <input value={form.attendees} placeholder="예: 홍길동, 김철수, 이영희" onChange={(e) => setForm({ ...form, attendees: e.target.value })} />
                </label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">
                  본문 (마크다운)
                  <textarea value={form.body} rows={6} placeholder="회의 내용을 마크다운으로 작성하세요." onChange={(e) => setForm({ ...form, body: e.target.value })} />
                </label>
              </div>
              <div className="dash-edit-row">
                <button className="primary" onClick={onSubmit}>{editing ? '수정 저장' : '등록'}</button>
              </div>
            </section>
          )}

          <div className="rfi-toolbar">
            <input
              className="rfi-search"
              value={query}
              placeholder="🔍 회의록·결정 전문 검색"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            />
            <button onClick={onSearch}>검색</button>
            {hits !== null && (
              <button onClick={() => { setHits(null); setQuery(''); }}>초기화</button>
            )}
          </div>

          {hits !== null ? (
            <section className="card">
              <h3 style={{ marginTop: 0 }}>검색 결과 ({hits.length})</h3>
              {hits.length === 0 && <p className="muted">일치하는 회의록·결정이 없습니다.</p>}
              {hits.map((h) => (
                <div key={h.meeting.id} className="meeting-decision" style={{ cursor: 'pointer' }} onClick={() => { setHits(null); setOpenId(h.meeting.id); }}>
                  <span className="decision-type">{h.matchedIn}</span>
                  <div className="meeting-decision-text">
                    <strong>{h.meeting.title}</strong>
                    <span className="muted tabular" style={{ marginLeft: 8 }}>{formatDate(h.meeting.meeting_date)}</span>
                    <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>{h.snippet}</p>
                  </div>
                </div>
              ))}
            </section>
          ) : (
            <section className="card" style={{ padding: 0 }}>
              <div className="cde-table-wrap" style={{ padding: 0 }}>
                <table className="cde-table">
                  <thead>
                    <tr>
                      <th>제목</th>
                      <th>회의일</th>
                      <th>참석자</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {meetings.map((m) => (
                      <MeetingRow
                        key={m.id}
                        meeting={m}
                        open={openId === m.id}
                        canEdit={canEdit}
                        members={members}
                        authorName={authorName}
                        onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                        onEdit={() => startEdit(m)}
                        onDelete={onDelete}
                      />
                    ))}
                    {meetings.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <EmptyState compact icon="📝" title="회의록이 없습니다" desc="새 회의록을 작성하면 여기에 표시됩니다." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

function MeetingRow({
  meeting,
  open,
  canEdit,
  members,
  authorName,
  onToggle,
  onEdit,
  onDelete,
}: {
  meeting: Meeting;
  open: boolean;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <tr>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{meeting.title}</button>
        </td>
        <td className="nowrap tabular">{formatDate(meeting.meeting_date)}</td>
        <td className="nowrap">{meeting.attendees.length ? `${meeting.attendees.length}명` : '—'}</td>
        <td className="right nowrap">
          {canEdit && <button onClick={onEdit}>수정</button>}
          {canEdit && <button className="danger" onClick={() => onDelete(meeting.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={4}>
            <MeetingDetail meeting={meeting} canEdit={canEdit} members={members} authorName={authorName} />
          </td>
        </tr>
      )}
    </>
  );
}

function MeetingDetail({
  meeting,
  canEdit,
  members,
  authorName,
}: {
  meeting: Meeting;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
}) {
  const navigate = useNavigate();
  const [decisions, setDecisions] = useState<MeetingDecision[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [decText, setDecText] = useState('');
  const [decType, setDecType] = useState<DecisionType>('decision');
  const [msg, setMsg] = useState('');

  const load = () => {
    listDecisions(meeting.id).then(setDecisions).catch(() => setDecisions([]));
    listActionItems(meeting.id).then(setActions).catch(() => setActions([]));
  };
  useEffect(load, [meeting.id]);

  const actionsByDecision = useMemo(() => {
    const m = new Map<string | null, ActionItem[]>();
    for (const a of actions) {
      const key = a.decision_id;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(a);
    }
    return m;
  }, [actions]);

  const onAddDecision = async () => {
    if (!decText.trim()) return;
    try {
      await addDecision(meeting.project_id, meeting.id, decText.trim(), decType);
      setDecText('');
      load();
    } catch (e) {
      setMsg(`결정 추가 실패: ${errMessage(e)}`);
    }
  };

  return (
    <div className="issue-detail">
      {meeting.attendees.length > 0 && (
        <div style={{ margin: '0 0 8px' }}>
          {meeting.attendees.map((a, i) => (
            <span className="attendee-chip" key={i}>{a}</span>
          ))}
        </div>
      )}
      {meeting.body && <div className="meeting-body">{meeting.body}</div>}
      <p className="muted issue-meta">
        작성 {meeting.created_by_name || '—'} · {formatDate(meeting.created_at.slice(0, 10))}
      </p>

      <h4 className="issue-section-h">의사결정</h4>
      {decisions.length === 0 && <p className="muted" style={{ fontSize: 12 }}>등록된 결정이 없습니다.</p>}
      {decisions.map((d) => (
        <div key={d.id}>
          <div className="meeting-decision">
            <span className="decision-type">{DECISION_TYPE_LABEL[d.decision_type]}</span>
            <div className="meeting-decision-text">{d.text}</div>
            {canEdit && (
              <button className="attach-del" title="삭제" onClick={async () => { await deleteDecision(d.id); load(); }}>×</button>
            )}
          </div>
          <ActionList
            actions={actionsByDecision.get(d.id) ?? []}
            decisionId={d.id}
            meeting={meeting}
            canEdit={canEdit}
            members={members}
            authorName={authorName}
            navigate={navigate}
            reload={load}
          />
        </div>
      ))}
      {canEdit && (
        <div className="dash-edit-row" style={{ marginTop: 8 }}>
          <label className="grow">
            새 결정
            <input value={decText} placeholder="확정된 결정·합의 사항" onChange={(e) => setDecText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddDecision()} />
          </label>
          <label>
            유형
            <select value={decType} onChange={(e) => setDecType(e.target.value as DecisionType)}>
              {DECISION_TYPES.map((t) => (
                <option key={t} value={t}>{DECISION_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
          <button onClick={onAddDecision}>추가</button>
        </div>
      )}

      {/* 결정에 속하지 않은 일반 액션아이템 */}
      <h4 className="issue-section-h" style={{ marginTop: 12 }}>기타 액션아이템</h4>
      <ActionList
        actions={actionsByDecision.get(null) ?? []}
        decisionId={null}
        meeting={meeting}
        canEdit={canEdit}
        members={members}
        authorName={authorName}
        navigate={navigate}
        reload={load}
      />

      <Attachments projectId={meeting.project_id} targetType="meeting" targetId={meeting.id} canEdit={canEdit} label="첨부(자료·사진)" />
      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}

function ActionList({
  actions,
  decisionId,
  meeting,
  canEdit,
  members,
  authorName,
  navigate,
  reload,
}: {
  actions: ActionItem[];
  decisionId: string | null;
  meeting: Meeting;
  canEdit: boolean;
  members: ProjectMember[];
  authorName: string | null;
  navigate: (to: string) => void;
  reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [msg, setMsg] = useState('');

  const onAdd = async () => {
    if (!text.trim()) return;
    const member = members.find((m) => m.id === assignee);
    try {
      await addActionItem(
        meeting.project_id,
        meeting.id,
        { text: text.trim(), assignee: assignee || null, assignee_name: member?.name ?? null, due_date: due || null, decision_id: decisionId },
        authorName,
      );
      setText('');
      setAssignee('');
      setDue('');
      setAdding(false);
      reload();
    } catch (e) {
      setMsg(`추가 실패: ${errMessage(e)}`);
    }
  };

  const onPromote = async (a: ActionItem) => {
    try {
      await promoteActionToIssue(a, authorName);
      reload();
      setMsg('이슈로 승격되었습니다.');
    } catch (e) {
      setMsg(`승격 실패: ${errMessage(e)}`);
    }
  };

  return (
    <div style={{ margin: decisionId ? '0 0 10px 20px' : '0 0 10px' }}>
      {actions.map((a) => (
        <div className="action-item" key={a.id}>
          <span className={`action-status ${ACTION_STATUS_CLASS[a.status]}`}>{ACTION_STATUS_LABEL[a.status]}</span>
          <span className="action-item-text">
            {a.text}
            {a.assignee_name && <span className="muted"> · {a.assignee_name}</span>}
            {a.due_date && <span className="muted tabular"> · {formatDate(a.due_date)}</span>}
          </span>
          {canEdit && (
            <select value={a.status} onChange={async (e) => { await setActionStatus(a.id, e.target.value as ActionStatus); reload(); }} aria-label="상태">
              {ACTION_STATUSES.map((s) => (
                <option key={s} value={s}>{ACTION_STATUS_LABEL[s]}</option>
              ))}
            </select>
          )}
          {a.linked_issue_id ? (
            <button onClick={() => navigate(`/project/${meeting.project_id}/issues`)} title="연결된 이슈로 이동">🔗 이슈</button>
          ) : (
            canEdit && <button onClick={() => onPromote(a)} title="이슈로 승격">↑ 이슈 승격</button>
          )}
          {canEdit && <button className="attach-del" title="삭제" onClick={async () => { await deleteActionItem(a.id); reload(); }}>×</button>}
        </div>
      ))}
      {canEdit && !adding && (
        <button style={{ fontSize: 12 }} onClick={() => setAdding(true)}>＋ 액션아이템</button>
      )}
      {adding && (
        <div className="dash-edit-row">
          <label className="grow">
            액션
            <input value={text} placeholder="담당·기한을 지정할 조치사항" onChange={(e) => setText(e.target.value)} />
          </label>
          <label>
            담당
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">미지정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <label>
            기한
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <button className="primary" onClick={onAdd}>추가</button>
          <button onClick={() => setAdding(false)}>취소</button>
        </div>
      )}
      {msg && <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>{msg}</p>}
    </div>
  );
}
