import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import { listCdeDocs } from '../lib/cde';
import {
  ACTION_LABEL,
  APPROVER_ACTIONS,
  SUBMITTAL_OPEN_STATUSES,
  SUBMITTAL_STATUS_LABEL,
  allowedActions,
  createSubmittal,
  daysInCourt,
  deleteSubmittal,
  isOverdue,
  listApprovalFlow,
  listSubmittals,
  transitionSubmittal,
  type ApprovalEntry,
  type Submittal,
  type SubmittalAction,
  type SubmittalStatus,
} from '../lib/approvals';

/** R4+R5 — 제출물(Submittals) + ISO19650 승인 워크플로우. 서버측 상태머신 기반. */
export function Submittals() {
  const { projectId = '' } = useParams();
  const { profile, session } = useAuth();
  const { canEdit, canManage } = useProjectRole(projectId);
  const myId = session?.user.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [subs, setSubs] = useState<Submittal[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [files, setFiles] = useState<Array<{ id: string; name: string; folder: string }>>([]);
  const [statusFilter, setStatusFilter] = useState<SubmittalStatus | 'all' | 'ballmine'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const empty = { title: '', type: '', spec_section: '', file_id: '', due_date: '', current_holder: '' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    listCdeDocs(projectId).then(setFiles).catch(() => setFiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () =>
    listSubmittals(projectId)
      .then((list) => {
        setSubs(list);
        setUnavailable(false);
      })
      .catch(() => {
        setSubs([]);
        setUnavailable(true);
      });

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      const holder = members.find((m) => m.id === form.current_holder);
      await createSubmittal(
        projectId,
        {
          title: form.title.trim(),
          type: form.type || null,
          spec_section: form.spec_section || null,
          file_id: form.file_id || null,
          due_date: form.due_date || null,
          current_holder: form.current_holder || null,
          current_holder_name: holder?.name ?? authorName,
        },
        authorName,
      );
      setForm(empty);
      setShowForm(false);
      await refresh();
      setMsg('제출물 등록됨(작성 상태)');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 제출물을 삭제할까요? (감사로그도 함께 삭제됩니다)')) return;
    await deleteSubmittal(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  // Ball-in-court 병목 뷰: 미종결 + 지연일 내림차순.
  const bottleneck = useMemo(
    () =>
      subs
        .filter((s) => SUBMITTAL_OPEN_STATUSES.includes(s.status))
        .map((s) => ({ s, days: daysInCourt(s) ?? 0 }))
        .sort((a, b) => b.days - a.days)
        .slice(0, 5),
    [subs],
  );

  const shown = useMemo(() => {
    if (statusFilter === 'all') return subs;
    if (statusFilter === 'ballmine') return subs.filter((s) => s.current_holder === myId && SUBMITTAL_OPEN_STATUSES.includes(s.status));
    return subs.filter((s) => s.status === statusFilter);
  }, [subs, statusFilter, myId]);

  return (
    <div className="dash">
      <PageHeader
        icon="submittal"
        title="제출물 · 승인"
        subtitle="ISO19650 승인 워크플로우 · Ball-in-Court · 리비전"
        actions={canEdit && !unavailable ? <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 제출물 등록'}</button> : undefined}
      />

      {unavailable && (
        <EmptyState
          icon="📑"
          title="제출물 모듈이 아직 활성화되지 않았습니다"
          desc="데이터베이스 마이그레이션(0035)이 적용되면 제출물·승인 워크플로우를 사용할 수 있습니다."
        />
      )}

      {!unavailable && (
        <>
          {/* Ball-in-court 병목 뷰 */}
          {bottleneck.length > 0 && (
            <section className="card">
              <h3 style={{ marginTop: 0 }}>⚖️ Ball-in-Court — 대기 병목 Top {bottleneck.length}</h3>
              <div className="bic-list">
                {bottleneck.map(({ s, days }) => (
                  <div key={s.id} className="bic-row" onClick={() => setOpenId(s.id)}>
                    <span className={`issue-badge sub-${s.status}`}>{SUBMITTAL_STATUS_LABEL[s.status]}</span>
                    <span className="bic-title">#{s.submittal_no} {s.title}</span>
                    <span className="muted">🖐 {s.current_holder_name || '미지정'}</span>
                    <span className={`bic-days tabular${isOverdue(s) ? ' bic-overdue' : ''}`}>{days}일 보유{isOverdue(s) ? ' · 지연' : ''}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {showForm && (
            <section className="card dash-edit">
              <h3>새 제출물</h3>
              <div className="dash-edit-row">
                <label className="grow">
                  제목
                  <input value={form.title} placeholder="예: 커튼월 샵드로잉 제출" onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <label>
                  유형
                  <input value={form.type} placeholder="샵드로잉/자재/샘플" onChange={(e) => setForm({ ...form, type: e.target.value })} />
                </label>
                <label>
                  스펙 섹션
                  <input value={form.spec_section} placeholder="예: 08 44 00" onChange={(e) => setForm({ ...form, spec_section: e.target.value })} />
                </label>
              </div>
              <div className="dash-edit-row">
                <label>
                  제출 기한
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
                </label>
                <label>
                  검토자(제출 시 볼 넘김)
                  <select value={form.current_holder} onChange={(e) => setForm({ ...form, current_holder: e.target.value })}>
                    <option value="">본인 보유</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  연결 파일(자료관리)
                  <select value={form.file_id} onChange={(e) => setForm({ ...form, file_id: e.target.value })}>
                    <option value="">없음</option>
                    {Object.entries(
                      files.reduce<Record<string, typeof files>>((acc, f) => {
                        (acc[f.folder] ??= []).push(f);
                        return acc;
                      }, {}),
                    ).map(([folder, list]) => (
                      <optgroup key={folder} label={`📁 ${folder}`}>
                        {list.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <button className="primary" onClick={onCreate}>등록</button>
              </div>
            </section>
          )}

          <div className="issue-filters">
            <button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>전체 {subs.length}</button>
            <button className={statusFilter === 'ballmine' ? 'active' : ''} onClick={() => setStatusFilter('ballmine')}>
              🖐 내 차례 {subs.filter((s) => s.current_holder === myId && SUBMITTAL_OPEN_STATUSES.includes(s.status)).length}
            </button>
            {(Object.keys(SUBMITTAL_STATUS_LABEL) as SubmittalStatus[]).map((s) => (
              <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
                {SUBMITTAL_STATUS_LABEL[s]} {subs.filter((x) => x.status === s).length}
              </button>
            ))}
          </div>

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>번호</th>
                    <th>제목</th>
                    <th>유형</th>
                    <th>Rev</th>
                    <th>상태</th>
                    <th>Ball-in-Court</th>
                    <th>기한</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <SubmittalRow
                      key={s.id}
                      sub={s}
                      open={openId === s.id}
                      canEdit={canEdit}
                      canManage={canManage}
                      myId={myId}
                      members={members}
                      authorName={authorName}
                      onToggle={() => setOpenId(openId === s.id ? null : s.id)}
                      onDelete={onDelete}
                      onChanged={refresh}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState compact icon="📑" title="제출물이 없습니다" desc="새 제출물을 등록하면 여기에 표시됩니다." />
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

function SubmittalRow({
  sub,
  open,
  canEdit,
  canManage,
  myId,
  members,
  authorName,
  onToggle,
  onDelete,
  onChanged,
}: {
  sub: Submittal;
  open: boolean;
  canEdit: boolean;
  canManage: boolean;
  myId: string | null;
  members: ProjectMember[];
  authorName: string | null;
  onToggle: () => void;
  onDelete: (id: string) => void;
  onChanged: () => void;
}) {
  const days = daysInCourt(sub);
  return (
    <>
      <tr>
        <td className="nowrap tabular" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{sub.submittal_no}</td>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{sub.title}</button>
        </td>
        <td className="nowrap">{sub.type || '—'}</td>
        <td className="nowrap tabular">R{sub.revision_no}</td>
        <td><span className={`issue-badge sub-${sub.status}`}>{SUBMITTAL_STATUS_LABEL[sub.status]}</span></td>
        <td className="nowrap">
          {sub.current_holder_name || '—'}
          {days != null && <span className="muted tabular"> · {days}일</span>}
        </td>
        <td className="nowrap">
          {sub.due_date ? (
            <span className={`tabular${isOverdue(sub) ? ' bic-overdue' : ''}`}>{formatDate(sub.due_date)}</span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="right nowrap">
          {canEdit && <button className="danger" onClick={() => onDelete(sub.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={8}>
            <SubmittalDetail sub={sub} canEdit={canEdit} canManage={canManage} myId={myId} members={members} authorName={authorName} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function SubmittalDetail({
  sub,
  canEdit,
  canManage,
  myId,
  members,
  authorName,
  onChanged,
}: {
  sub: Submittal;
  canEdit: boolean;
  canManage: boolean;
  myId: string | null;
  members: ProjectMember[];
  authorName: string | null;
  onChanged: () => void;
}) {
  const [flow, setFlow] = useState<ApprovalEntry[]>([]);
  const [comment, setComment] = useState('');
  const [nextHolder, setNextHolder] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listApprovalFlow('submittal', sub.id).then(setFlow).catch(() => setFlow([]));
  }, [sub.id, sub.status, sub.revision_no]);

  const isHolder = sub.current_holder === myId;
  const actions = allowedActions(sub.status);

  const onAction = async (action: SubmittalAction) => {
    // 결정성 액션은 승인권자(관리자) 또는 볼 보유자만 — UI 선제 가드(서버가 최종 검증).
    if (APPROVER_ACTIONS.includes(action) && !(canManage || isHolder)) {
      setMsg('이 전환은 승인권자(프로젝트 관리자) 또는 현재 담당자만 가능합니다.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await transitionSubmittal(sub, action, comment.trim() || null, nextHolder || null, authorName);
      setComment('');
      setNextHolder('');
      onChanged();
    } catch (e) {
      // 서버(RPC)가 거부하면 여기로 — 무단 전환 차단이 사용자에게 노출됨.
      setMsg(`전환 거부됨: ${errMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="issue-detail">
      <p className="muted issue-meta">
        제출물 #{sub.submittal_no} · Rev R{sub.revision_no} · 등록 {sub.created_by_name || '—'} · {formatDate(sub.created_at.slice(0, 10))}
        {sub.spec_section ? ` · 스펙 ${sub.spec_section}` : ''}
      </p>
      <p style={{ margin: '0 0 10px' }}>
        현재 상태 <span className={`issue-badge sub-${sub.status}`}>{SUBMITTAL_STATUS_LABEL[sub.status]}</span>
        {' · '}Ball-in-Court <strong>{sub.current_holder_name || '미지정'}</strong>
        {daysInCourt(sub) != null && <span className="muted"> ({daysInCourt(sub)}일 보유{isOverdue(sub) ? ' · 지연' : ''})</span>}
      </p>

      {/* 전환 UI — 권한자·사유입력 */}
      {canEdit && actions.length > 0 && (
        <div className="sub-transition">
          <div className="dash-edit-row">
            <label className="grow">
              사유·검토의견(감사로그에 기록)
              <input value={comment} placeholder="전환 사유를 입력하세요" onChange={(e) => setComment(e.target.value)} />
            </label>
            <label>
              다음 담당(볼 넘김)
              <select value={nextHolder} onChange={(e) => setNextHolder(e.target.value)}>
                <option value="">기본(자동)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="sub-actions">
            {actions.map((a) => {
              const gated = APPROVER_ACTIONS.includes(a) && !(canManage || isHolder);
              return (
                <button
                  key={a}
                  className={a === 'approve' ? 'primary' : a === 'reject' ? 'danger' : ''}
                  disabled={busy || gated}
                  title={gated ? '승인권자 또는 담당자만 가능' : ''}
                  onClick={() => onAction(a)}
                >
                  {ACTION_LABEL[a]}
                </button>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
            ★ 모든 전환은 서버측 상태머신·권한 검증을 거칩니다. 무단/불법 전환은 거부됩니다.
          </p>
        </div>
      )}

      {/* 감사로그 타임라인(누가·언제·왜) + Revision 이력 */}
      <h4 className="issue-section-h" style={{ marginTop: 14 }}>승인 감사 타임라인</h4>
      <div className="approval-timeline">
        {flow.length === 0 && <p className="muted" style={{ fontSize: 12 }}>기록이 없습니다.</p>}
        {flow.map((e) => (
          <div className="approval-entry" key={e.id}>
            <span className={`approval-dot decision-${e.decision}`} aria-hidden />
            <div className="approval-body">
              <span className="approval-line">
                <strong>{stateLabel(e.from_state)} → {stateLabel(e.to_state)}</strong>
                <span className={`decision-chip decision-${e.decision}`}>{decisionLabel(e.decision)}</span>
              </span>
              {e.comment && <span className="approval-comment">“{e.comment}”</span>}
              <span className="muted approval-when">{e.approver_name || '—'} · {new Date(e.created_at).toLocaleString('ko-KR')}</span>
            </div>
          </div>
        ))}
      </div>

      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}

function stateLabel(s: string | null): string {
  if (!s) return '—';
  return SUBMITTAL_STATUS_LABEL[s as SubmittalStatus] ?? s;
}

const DECISION_LABEL: Record<string, string> = {
  approved: '승인',
  conditional: '조건부',
  rejected: '반려',
  resubmit: '재제출',
  transition: '전환',
};
function decisionLabel(d: string): string {
  return DECISION_LABEL[d] ?? d;
}
