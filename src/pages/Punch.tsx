import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Attachments } from '../components/Attachments';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import { listDrawings, type Drawing } from '../lib/drawings';
import {
  PUNCH_SEVERITIES,
  PUNCH_SEVERITY_LABEL,
  PUNCH_STATUSES,
  PUNCH_STATUS_LABEL,
  assignPunch,
  createPunch,
  deletePunch,
  listPunches,
  punchProgress,
  setPunchStatus,
  type Punch,
  type PunchSeverity,
  type PunchStatus,
} from '../lib/punch';

/** R3 — Punch List(하자·미완료). 3D/도면 핀·사진·상태전이·준공률 위젯. */
export function PunchPage() {
  const { projectId = '' } = useParams();
  const { profile, session } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const myId = session?.user.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [punches, setPunches] = useState<Punch[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [statusFilter, setStatusFilter] = useState<PunchStatus | 'all'>('all');
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const empty = {
    title: '',
    description: '',
    location_desc: '',
    severity: 'normal' as PunchSeverity,
    assignee_company: '',
    assignee: '',
  };
  const [form, setForm] = useState(empty);

  const location = useLocation();
  const focusPunchId = (location.state as { focusPunchId?: string } | null)?.focusPunchId ?? null;

  useEffect(() => {
    refresh();
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    listDrawings(projectId).then(setDrawings).catch(() => setDrawings([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (focusPunchId) setOpenId(focusPunchId);
  }, [focusPunchId]);

  const refresh = () =>
    listPunches(projectId)
      .then((list) => {
        setPunches(list);
        setUnavailable(false);
      })
      .catch(() => {
        setPunches([]);
        setUnavailable(true);
      });

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      const member = members.find((m) => m.id === form.assignee);
      await createPunch(
        projectId,
        {
          title: form.title.trim(),
          description: form.description,
          location_desc: form.location_desc || null,
          severity: form.severity,
          assignee_company: form.assignee_company || null,
          assignee: form.assignee || null,
          assignee_name: member?.name ?? null,
        },
        authorName,
      );
      setForm(empty);
      setShowForm(false);
      await refresh();
      setMsg('Punch 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onStatus = async (punch: Punch, status: PunchStatus) => {
    try {
      await setPunchStatus(punch, status, authorName);
      await refresh();
    } catch (e) {
      setMsg(`상태 변경 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 Punch 항목을 삭제할까요?')) return;
    await deletePunch(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const companies = useMemo(() => {
    const set = new Set<string>();
    punches.forEach((p) => p.assignee_company && set.add(p.assignee_company));
    return Array.from(set);
  }, [punches]);

  const prog = useMemo(() => punchProgress(punches), [punches]);
  const pct = Math.round(prog.ratio * 100);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return punches.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (sevFilter !== 'all' && p.severity !== sevFilter) return false;
      if (companyFilter !== 'all' && p.assignee_company !== companyFilter) return false;
      if (q) {
        const hay = `#${p.punch_no} ${p.title} ${p.description ?? ''} ${p.location_desc ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [punches, statusFilter, sevFilter, companyFilter, query]);

  return (
    <div className="dash">
      <PageHeader
        icon="punch"
        title="Punch List · 하자/미완료"
        subtitle="3D/도면 위치 · 사진 조치 전후 · 준공률"
        actions={canEdit && !unavailable ? <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ Punch 등록'}</button> : undefined}
      />

      {unavailable && (
        <EmptyState
          icon="🔧"
          title="Punch List 모듈이 아직 활성화되지 않았습니다"
          desc="데이터베이스 마이그레이션(0034)이 적용되면 하자·미완료 항목을 관리할 수 있습니다."
        />
      )}

      {!unavailable && (
        <>
          {/* 준공률 위젯 (closed / total) */}
          <div className="punch-progress">
            <span className="punch-progress-num tabular">{pct}%</span>
            <progress className="progress-bar" value={prog.closed} max={Math.max(prog.total, 1)} />
            <span className="muted tabular">{prog.closed} / {prog.total} 완료</span>
          </div>

          {showForm && (
            <section className="card dash-edit">
              <h3>새 Punch 항목</h3>
              <div className="dash-edit-row">
                <label className="grow">
                  제목
                  <input value={form.title} placeholder="예: 3층 화장실 타일 들뜸" onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <label>
                  심각도
                  <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as PunchSeverity })}>
                    {PUNCH_SEVERITIES.map((s) => (
                      <option key={s} value={s}>{PUNCH_SEVERITY_LABEL[s]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">
                  위치(층·공구)
                  <input value={form.location_desc} placeholder="예: 3층 B구역 화장실" onChange={(e) => setForm({ ...form, location_desc: e.target.value })} />
                </label>
                <label>
                  담당 협력사
                  <input value={form.assignee_company} placeholder="예: OO타일" onChange={(e) => setForm({ ...form, assignee_company: e.target.value })} />
                </label>
                <label>
                  담당자
                  <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                    <option value="">미지정</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">
                  내용
                  <textarea value={form.description} rows={2} placeholder="하자·미완료 상세" onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
              </div>
              <div className="dash-edit-row">
                <button className="primary" onClick={onCreate}>등록</button>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                3D 부재에 핀을 꽂으려면 통합모델(3D)에서 부재 선택 후 "＋ Punch" 를 사용하세요. 사진은 등록 후 상세에서 첨부합니다.
              </p>
            </section>
          )}

          <div className="issue-filters">
            <button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>
              전체 {punches.length}
            </button>
            {PUNCH_STATUSES.map((s) => (
              <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
                {PUNCH_STATUS_LABEL[s]} {punches.filter((p) => p.status === s).length}
              </button>
            ))}
          </div>

          <div className="rfi-toolbar">
            <input className="rfi-search" value={query} placeholder="🔍 제목·위치 검색" onChange={(e) => setQuery(e.target.value)} />
            <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} aria-label="심각도 필터">
              <option value="all">심각도 전체</option>
              {PUNCH_SEVERITIES.map((s) => (
                <option key={s} value={s}>{PUNCH_SEVERITY_LABEL[s]}</option>
              ))}
            </select>
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} aria-label="협력사 필터">
              <option value="all">협력사 전체</option>
              {companies.map((c) => (
                <option key={c} value={c}>{c}</option>
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
                    <th>위치</th>
                    <th>심각도</th>
                    <th>상태</th>
                    <th>담당/협력사</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <PunchRow
                      key={p.id}
                      punch={p}
                      open={openId === p.id}
                      canEdit={canEdit}
                      myId={myId}
                      members={members}
                      drawings={drawings}
                      authorName={authorName}
                      onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                      onStatus={onStatus}
                      onDelete={onDelete}
                      onChanged={refresh}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <EmptyState compact icon="🔧" title="Punch 항목이 없습니다" desc="새 하자·미완료 항목을 등록하면 여기에 표시됩니다." />
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

function PunchRow({
  punch,
  open,
  canEdit,
  myId,
  members,
  drawings,
  authorName,
  onToggle,
  onStatus,
  onDelete,
  onChanged,
}: {
  punch: Punch;
  open: boolean;
  canEdit: boolean;
  myId: string | null;
  members: ProjectMember[];
  drawings: Drawing[];
  authorName: string | null;
  onToggle: () => void;
  onStatus: (punch: Punch, s: PunchStatus) => void;
  onDelete: (id: string) => void;
  onChanged: () => void;
}) {
  const canAct = canEdit || (!!myId && punch.assignee === myId);
  return (
    <>
      <tr>
        <td className="nowrap tabular" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{punch.punch_no}</td>
        <td className="cde-fname">
          <button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{punch.title}</button>
        </td>
        <td className="nowrap">{punch.location_desc || '—'}</td>
        <td><span className={`punch-sev punch-sev-${punch.severity}`}>{PUNCH_SEVERITY_LABEL[punch.severity]}</span></td>
        <td><span className={`issue-badge punch-${punch.status}`}>{PUNCH_STATUS_LABEL[punch.status]}</span></td>
        <td className="nowrap">
          {punch.assignee_name || '—'}
          {punch.assignee_company && <span className="muted"> · {punch.assignee_company}</span>}
        </td>
        <td className="right nowrap">
          {canAct ? (
            <select value={punch.status} onChange={(e) => onStatus(punch, e.target.value as PunchStatus)} aria-label="상태 변경">
              {PUNCH_STATUSES.map((s) => (
                <option key={s} value={s}>{PUNCH_STATUS_LABEL[s]}</option>
              ))}
            </select>
          ) : (
            <span className="muted">—</span>
          )}
          {canEdit && <button className="danger" onClick={() => onDelete(punch.id)}>삭제</button>}
        </td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={7}>
            <PunchDetail
              punch={punch}
              canEdit={canEdit}
              members={members}
              drawings={drawings}
              authorName={authorName}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function PunchDetail({
  punch,
  canEdit,
  members,
  drawings,
  authorName,
  onChanged,
}: {
  punch: Punch;
  canEdit: boolean;
  members: ProjectMember[];
  drawings: Drawing[];
  authorName: string | null;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [company, setCompany] = useState(punch.assignee_company ?? '');
  const drawing = drawings.find((d) => d.id === punch.drawing_id);

  const onAssign = async (assigneeId: string) => {
    const member = members.find((m) => m.id === assigneeId);
    try {
      await assignPunch(punch, assigneeId || null, member?.name ?? null, company || null, authorName);
      onChanged();
    } catch {
      /* noop — 목록 갱신은 다음 액션에서 */
    }
  };

  return (
    <div className="issue-detail">
      {punch.description && <p className="issue-desc">{punch.description}</p>}
      <p className="muted issue-meta">
        Punch #{punch.punch_no} · 등록 {punch.created_by_name || '—'} · {formatDate(punch.created_at.slice(0, 10))}
        {punch.location_desc ? ` · 위치 ${punch.location_desc}` : ''}
      </p>

      {canEdit && (
        <div className="issue-assign-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>담당 협력사
            <input value={company} placeholder="협력사명" onChange={(e) => setCompany(e.target.value)} onBlur={() => onAssign(punch.assignee ?? '')} />
          </label>
          <label>담당자 배정
            <select value={punch.assignee ?? ''} onChange={(e) => onAssign(e.target.value)}>
              <option value="">미지정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {(punch.global_id || drawing) && (
        <p style={{ margin: '0 0 10px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {punch.global_id && (
            <button onClick={() => navigate(`/project/${punch.project_id}/model?focusGlobalId=${encodeURIComponent(punch.global_id!)}`)}>
              📍 위치 보기 (3D 부재)
            </button>
          )}
          {drawing && (
            <button onClick={() => navigate(`/project/${punch.project_id}/drawings`)}>
              📐 연결 도면 열기 ({drawing.name})
            </button>
          )}
        </p>
      )}

      <Attachments
        projectId={punch.project_id}
        targetType="punch"
        targetId={punch.id}
        canEdit={canEdit}
        label="사진(조치 전/후)"
      />
    </div>
  );
}
