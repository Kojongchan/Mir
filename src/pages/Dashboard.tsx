import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { errMessage } from '../lib/errors';
import { useProjectRole } from '../auth/useProjectRole';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/icons/Icon';
import { countOpenIssues } from '../lib/issues';
import {
  addMilestone,
  daysSince,
  ddayLabel,
  deleteMilestone,
  deleteMonthlyRecord,
  formatAmount,
  formatDate,
  getProjectInfo,
  listDailyLogs,
  listMilestones,
  listMonthlyRecords,
  reorderMilestones,
  saveMonthlyRecord,
  saveProjectInfo,
  todayISO,
  type DailyLog,
  type Milestone,
  type MonthlyRecord,
  type ProjectInfo,
} from '../lib/dashboard';
import { projectKey } from '../lib/queryClient';
import { useCachedQuery } from '../lib/useCachedQuery';

// Recharts 툴팁 — 토큰 기반(라이트/다크 자동). 텍스트는 ink 토큰, 마크만 계열색.
const TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-default)',
  borderRadius: '8px',
  fontSize: '12px',
  boxShadow: 'var(--shadow-md)',
};
const TOOLTIP_LABEL = { color: 'var(--color-text-secondary)' };
const TOOLTIP_ITEM = { color: 'var(--color-text-primary)' };

/** D-day 임박도 → KPI 컬러 시맨틱 클래스(DESIGN_SYSTEM §6.3):
 *  D-30 이하 위험 · D-31~180 주의 · 그 외 안전 · 경과(D+)는 기본. */
function ddayKpiClass(date: string | null): string {
  if (!date) return '';
  const d = Math.ceil((new Date(`${date}T00:00:00`).getTime() - Date.now()) / 86_400_000);
  if (d < 0) return '';
  if (d <= 30) return 'kpi--danger';
  if (d <= 180) return 'kpi--warning';
  return 'kpi--success';
}

/**
 * 사업개요 — the project portal landing. A construction PMIS dashboard:
 * 착공/준공 D-day, 전체 진행률, 마일스톤, 공사일지·기성 현황 차트, 투입인력·
 * 장비현황 stats and a quick link to the 3D model viewer. All figures are
 * editable in-app (toggle 편집) and stored in Supabase.
 */
export function Dashboard() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  // 편집 게이팅 = 실무자(editor) 이상. RLS(0023) project_info/milestones/monthly_records
  // 쓰기 정책(is_editor)과 일치 — 기존 시스템관리자(is_admin) 한정은 실무자·프로젝트관리자를
  // 부당하게 막던 회귀(B1)라 canEdit 으로 정정.
  const { canEdit } = useProjectRole(projectId);

  // Cached per project: returning to 사업개요 shows the last figures at once while they refresh.
  // Missing tables (migration not applied) read as empty, as before.
  const [info, , refreshInfo] = useCachedQuery<ProjectInfo | null>(
    projectKey(projectId, 'info'), () => getProjectInfo(projectId).catch(() => null), null);
  const [milestones, setMilestones] = useCachedQuery<Milestone[]>(
    projectKey(projectId, 'milestones'), () => listMilestones(projectId).catch(() => []), []);
  const [logs] = useCachedQuery<DailyLog[]>(
    projectKey(projectId, 'dailyLogs', 60), () => listDailyLogs(projectId, 60).catch(() => []), []);
  const [monthly, setMonthly] = useCachedQuery<MonthlyRecord[]>(
    projectKey(projectId, 'monthly'), () => listMonthlyRecords(projectId).catch(() => []), []);
  const [openIssues] = useCachedQuery<number>(
    projectKey(projectId, 'issues', 'openCount'), () => countOpenIssues(projectId).catch(() => 0), 0);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState('');

  // editable draft of project_info
  const [draft, setDraft] = useState({ start_date: '', end_date: '', progress_pct: 0, summary: '' });
  // new milestone / monthly inputs
  const [mName, setMName] = useState('');
  const [mDate, setMDate] = useState('');
  const [rec, setRec] = useState({ ym: todayISO().slice(0, 7), planned_pct: 0, actual_pct: 0, billing_amount: 0 });

  // The edit form follows the saved values until the user types; a background refresh must not
  // overwrite what is being edited.
  const draftTouched = useRef(false);
  useEffect(() => {
    if (draftTouched.current) return;
    setDraft({
      start_date: info?.start_date ?? '',
      end_date: info?.end_date ?? '',
      progress_pct: info ? Number(info.progress_pct) : 0,
      summary: info?.summary ?? '',
    });
  }, [info]);
  const editDraft = (patch: Partial<typeof draft>) => {
    draftTouched.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  };

  const onSaveInfo = async () => {
    try {
      await saveProjectInfo(projectId, {
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        progress_pct: Number(draft.progress_pct) || 0,
        summary: draft.summary || null,
      });
      draftTouched.current = false;
      await refreshInfo();
      setMsg('사업 개요 저장됨');
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onAddMilestone = async () => {
    if (!mName.trim()) return;
    try {
      await addMilestone(projectId, mName.trim(), mDate || null, milestones.length);
      setMName('');
      setMDate('');
      setMilestones(await listMilestones(projectId));
    } catch (e) {
      setMsg(`마일스톤 추가 실패: ${errMessage(e)}`);
    }
  };

  // 마일스톤 드래그 정렬
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const onDropMilestone = async (toIdx: number) => {
    const from = dragIdx;
    setDragIdx(null);
    if (from === null || from === toIdx) return;
    const next = [...milestones];
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    setMilestones(next);
    try {
      await reorderMilestones(next.map((m) => m.id));
    } catch (e) {
      setMsg(`정렬 저장 실패: ${errMessage(e)}`);
    }
  };

  const onAddRecord = async () => {
    if (!/^\d{4}-\d{2}$/.test(rec.ym)) {
      setMsg('월은 YYYY-MM 형식으로 입력하세요');
      return;
    }
    try {
      await saveMonthlyRecord(projectId, rec.ym, {
        planned_pct: Number(rec.planned_pct) || 0,
        actual_pct: Number(rec.actual_pct) || 0,
        billing_amount: Number(rec.billing_amount) || 0,
      });
      setMonthly(await listMonthlyRecords(projectId));
      setMsg(`${rec.ym} 실적 저장됨`);
    } catch (e) {
      setMsg(`실적 저장 실패: ${errMessage(e)}`);
    }
  };

  // chronological series for charts (lists come newest-first)
  const logsAsc = [...logs].reverse();
  const progress = info ? Number(info.progress_pct) : 0;
  const sinceStart = daysSince(info?.start_date ?? null);
  const latest = logs[0];
  const manpowerData = logsAsc.map((l) => ({ d: l.log_date.slice(5), 인력: l.manpower }));
  const monthlyData = monthly.map((m) => ({
    ym: m.ym,
    계획: Number(m.planned_pct),
    실적: Number(m.actual_pct),
  }));

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <span className="dash-today">Today {new Date().toLocaleDateString('ko-KR', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })}</span>
          <h1 className="dash-h1">사업개요</h1>
        </div>
        {canEdit && (
          <button className={edit ? 'primary' : ''} onClick={() => setEdit((e) => !e)}>
            {edit ? '편집 완료' : '편집'}
          </button>
        )}
      </div>

      {/* ---- Bento 대시보드 (U2) ---- */}
      <section className="bento-grid">
        {/* HERO — 전체 진행률 */}
        <article className="bento-hero">
          <div className="kpi__label">전체 진행률</div>
          <div className="kpi__value tabular">
            {progress.toFixed(0)}<span className="unit">%</span>
          </div>
          <progress className="progress-bar" value={Math.min(100, progress)} max={100} />
          {info?.summary && <div className="kpi__meta">{info.summary}</div>}
        </article>

        {/* SMALL — 준공 D-day (컬러 시맨틱) */}
        <article className={`bento-small kpi-card ${ddayKpiClass(info?.end_date ?? null)}`}>
          <div className="kpi__label">준공까지</div>
          <div className="kpi__value tabular">{ddayLabel(info?.end_date ?? null)}</div>
          <div className="kpi__meta">{formatDate(info?.end_date ?? null)}</div>
        </article>
        {/* SMALL — 착공 후 */}
        <article className="bento-small kpi-card">
          <div className="kpi__label">착공 후</div>
          <div className="kpi__value tabular">{sinceStart !== null ? `D+${sinceStart}` : '—'}</div>
          <div className="kpi__meta">{formatDate(info?.start_date ?? null)}</div>
        </article>
        {/* SMALL — 미해결 이슈 */}
        <button
          className="bento-small kpi-card dash-link-card"
          onClick={() => navigate(`/project/${projectId}/issues`)}
        >
          <div className="kpi__label">미해결 이슈</div>
          <div className="kpi__value tabular">{openIssues}<span className="unit">건</span></div>
          <div className="kpi__meta">협업 · 이슈 관리 →</div>
        </button>
        {/* SMALL — 투입 인력 */}
        <article className="bento-small kpi-card">
          <div className="kpi__label">투입 인력</div>
          <div className="kpi__value tabular">{latest?.manpower ?? 0}<span className="unit">명</span></div>
          <div className="kpi__meta">{latest ? formatDate(latest.log_date) : '일보 없음'}</div>
        </article>
        {/* SMALL — 장비 현황 */}
        <article className="bento-small kpi-card">
          <div className="kpi__label">장비 현황</div>
          <div className="kpi__value tabular">{latest?.equipment ?? 0}<span className="unit">대</span></div>
          <div className="kpi__meta">{latest ? formatDate(latest.log_date) : '일보 없음'}</div>
        </article>
        {/* SMALL — 통합모델 링크 */}
        <button
          className="bento-small kpi-card dash-link-card"
          onClick={() => navigate(`/project/${projectId}/model`)}
        >
          <div className="kpi__label">통합모델 (3D)</div>
          <div className="kpi__value" style={{ color: 'var(--color-brand-primary)' }}>
            <Icon name="model-3d" size={32} />
          </div>
          <div className="kpi__meta">3D 통합모델 · 이슈 →</div>
        </button>

        {/* CHART — 공사일지 인력 추이 (단일 계열: 범례 없음) */}
        <article className="bento-chart card">
          <h3>공사일지 현황 <span className="muted">(투입 인력 추이)</span></h3>
          <div className="dash-chart">
            {manpowerData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={manpowerData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <defs>
                    <linearGradient id="grad-manpower" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="d" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" />
                  <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" width={40} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
                  <Area
                    type="monotone"
                    dataKey="인력"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#grad-manpower)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState compact icon="📈" title="공사일보 데이터가 없습니다" desc="일보를 입력하면 인력 추이가 표시됩니다." />
            )}
          </div>
          <p className="muted dash-hint">
            공사일보 {logs.length}건 · <button className="cde-link" onClick={() => navigate(`/project/${projectId}/logs`)}>일보 입력 →</button>
          </p>
        </article>

        {/* CHART — 기성 계획 vs 실적 (2계열: 범례 + 색+선유형 이중 인코딩) */}
        <article className="bento-chart card">
          <h3>기성 현황 <span className="muted">(계획 vs 실적 %)</span></h3>
          <div className="dash-chart">
            {monthlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="ym" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" />
                  <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" width={40} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
                  <Line type="monotone" dataKey="계획" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                  <Line type="monotone" dataKey="실적" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState compact icon="📊" title="월별 기성 데이터가 없습니다" desc="편집에서 월별 계획·실적을 입력하세요." />
            )}
          </div>
          <div className="dash-chart-legend" aria-hidden>
            <span><i style={{ borderTopColor: 'var(--chart-1)' }} /> 실적</span>
            <span><i style={{ borderTopColor: 'var(--chart-2)', borderTopStyle: 'dashed' }} /> 계획</span>
            <span className="muted">누적 기성 {formatAmount(monthly.reduce((s, m) => s + Number(m.billing_amount), 0))}원</span>
          </div>
        </article>

        {/* WIDE — 마일스톤 타임라인 */}
        {milestones.length > 0 && (
          <article className="bento-wide card">
            <h3>마일스톤</h3>
            <div className="ms-chips">
              {milestones.map((m) => (
                <div key={m.id} className={`ms-chip ${ddayKpiClass(m.target_date)}`}>
                  <span className="ms-chip__d tabular">{ddayLabel(m.target_date)}</span>
                  <span className="ms-chip__name">{m.name}</span>
                  <span className="ms-chip__date">{formatDate(m.target_date)}</span>
                </div>
              ))}
            </div>
          </article>
        )}
      </section>

      {edit && (
        <section className="dash-edit card">
          <h3>사업 정보 편집</h3>
          <div className="dash-edit-row">
            <label>착공일<input type="date" value={draft.start_date} onChange={(e) => editDraft({ start_date: e.target.value })} /></label>
            <label>준공 예정<input type="date" value={draft.end_date} onChange={(e) => editDraft({ end_date: e.target.value })} /></label>
            <label>전체 진행률(%)<input type="number" min={0} max={100} step={0.1} value={draft.progress_pct} onChange={(e) => editDraft({ progress_pct: Number(e.target.value) })} /></label>
            <button className="primary" onClick={onSaveInfo}>저장</button>
          </div>
          <div className="dash-edit-row">
            <label className="grow">개요<input value={draft.summary} placeholder="사업 개요 메모" onChange={(e) => editDraft({ summary: e.target.value })} /></label>
          </div>
          <div className="dash-edit-row">
            <strong>마일스톤 추가:</strong>
            <input value={mName} placeholder="예: 노반 완료" onChange={(e) => setMName(e.target.value)} />
            <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
            <button onClick={onAddMilestone}>추가</button>
          </div>
          {milestones.length > 0 && (
            <div className="ms-reorder">
              <span className="muted" style={{ fontSize: 12 }}>드래그로 순서 변경 · ×로 삭제:</span>
              <ul className="ms-reorder-list">
                {milestones.map((m, i) => (
                  <li
                    key={m.id}
                    draggable
                    onDragStart={() => setDragIdx(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDropMilestone(i)}
                    className={`ms-reorder-item${dragIdx === i ? ' dragging' : ''}`}
                  >
                    <span className="ms-grip">⠿</span>
                    <span className="ms-name">{m.name}</span>
                    <span className="muted">{formatDate(m.target_date)}</span>
                    <button
                      className="ms-del danger"
                      onClick={() => deleteMilestone(m.id).then(() => listMilestones(projectId).then(setMilestones))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ---- 월별 실적 편집 표 ---- */}
      {edit && (
        <section className="dash-edit card">
          <h3>월별 계획·실적·기성 입력</h3>
          <div className="dash-edit-row">
            <label>월(YYYY-MM)<input value={rec.ym} onChange={(e) => setRec({ ...rec, ym: e.target.value })} /></label>
            <label>계획(%)<input type="number" value={rec.planned_pct} onChange={(e) => setRec({ ...rec, planned_pct: Number(e.target.value) })} /></label>
            <label>실적(%)<input type="number" value={rec.actual_pct} onChange={(e) => setRec({ ...rec, actual_pct: Number(e.target.value) })} /></label>
            <label>기성(원)<input type="number" value={rec.billing_amount} onChange={(e) => setRec({ ...rec, billing_amount: Number(e.target.value) })} /></label>
            <button className="primary" onClick={onAddRecord}>저장</button>
          </div>
          {monthly.length > 0 && (
            <table className="cde-table">
              <thead><tr><th>월</th><th className="right">계획%</th><th className="right">실적%</th><th className="right">기성</th><th /></tr></thead>
              <tbody>
                {monthly.map((m) => (
                  <tr key={m.id}>
                    <td>{m.ym}</td>
                    <td className="right">{Number(m.planned_pct)}</td>
                    <td className="right">{Number(m.actual_pct)}</td>
                    <td className="right">{formatAmount(Number(m.billing_amount))}</td>
                    <td className="right"><button className="danger" onClick={() => deleteMonthlyRecord(m.id).then(() => listMonthlyRecords(projectId).then(setMonthly))}>삭제</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
