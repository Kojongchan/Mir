import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MiniChart } from '../components/MiniChart';
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
  saveMonthlyRecord,
  saveProjectInfo,
  todayISO,
  type DailyLog,
  type Milestone,
  type MonthlyRecord,
  type ProjectInfo,
} from '../lib/dashboard';

/**
 * 사업개요 — the project portal landing. A construction PMIS dashboard:
 * 착공/준공 D-day, 전체 진행률, 마일스톤, 공사일지·기성 현황 차트, 투입인력·
 * 장비현황 stats and a quick link to the 3D model viewer. All figures are
 * editable in-app (toggle 편집) and stored in Supabase.
 */
export function Dashboard() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();

  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRecord[]>([]);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState('');

  // editable draft of project_info
  const [draft, setDraft] = useState({ start_date: '', end_date: '', progress_pct: 0, summary: '' });
  // new milestone / monthly inputs
  const [mName, setMName] = useState('');
  const [mDate, setMDate] = useState('');
  const [rec, setRec] = useState({ ym: todayISO().slice(0, 7), planned_pct: 0, actual_pct: 0, billing_amount: 0 });

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshAll = async () => {
    const [i, m, l, r] = await Promise.all([
      getProjectInfo(projectId).catch(() => null),
      listMilestones(projectId).catch(() => []),
      listDailyLogs(projectId).catch(() => []),
      listMonthlyRecords(projectId).catch(() => []),
    ]);
    setInfo(i);
    setMilestones(m);
    setLogs(l);
    setMonthly(r);
    setDraft({
      start_date: i?.start_date ?? '',
      end_date: i?.end_date ?? '',
      progress_pct: i ? Number(i.progress_pct) : 0,
      summary: i?.summary ?? '',
    });
  };

  const onSaveInfo = async () => {
    try {
      await saveProjectInfo(projectId, {
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        progress_pct: Number(draft.progress_pct) || 0,
        summary: draft.summary || null,
      });
      await refreshAll();
      setMsg('사업 개요 저장됨');
    } catch (e) {
      setMsg(`저장 실패: ${(e as Error).message}`);
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
      setMsg(`마일스톤 추가 실패: ${(e as Error).message}`);
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
      setMsg(`실적 저장 실패: ${(e as Error).message}`);
    }
  };

  // chronological series for charts (lists come newest-first)
  const logsAsc = [...logs].reverse();
  const progress = info ? Number(info.progress_pct) : 0;
  const sinceStart = daysSince(info?.start_date ?? null);
  const latest = logs[0];

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <span className="dash-today">Today {new Date().toLocaleDateString('ko-KR', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })}</span>
          <h1 className="dash-h1">사업개요</h1>
        </div>
        <button className={edit ? 'primary' : ''} onClick={() => setEdit((e) => !e)}>
          {edit ? '편집 완료' : '편집'}
        </button>
      </div>

      {/* ---- 마일스톤 / D-day 띠 ---- */}
      <section className="dash-milestones">
        <MilestoneCard
          label="착공일"
          date={info?.start_date ?? null}
          big={sinceStart !== null ? `D+${sinceStart}` : '—'}
          note={sinceStart !== null ? `${sinceStart}일 경과` : '착공일 미설정'}
        />
        {milestones.map((m) => (
          <MilestoneCard
            key={m.id}
            label={m.name}
            date={m.target_date}
            big={ddayLabel(m.target_date)}
            note={formatDate(m.target_date)}
            onDelete={edit ? () => deleteMilestone(m.id).then(() => listMilestones(projectId).then(setMilestones)) : undefined}
          />
        ))}
        <MilestoneCard
          label="준공 예정"
          date={info?.end_date ?? null}
          big={ddayLabel(info?.end_date ?? null)}
          note={formatDate(info?.end_date ?? null)}
        />
      </section>

      {edit && (
        <section className="dash-edit card">
          <h3>사업 정보 편집</h3>
          <div className="dash-edit-row">
            <label>착공일<input type="date" value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} /></label>
            <label>준공 예정<input type="date" value={draft.end_date} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} /></label>
            <label>전체 진행률(%)<input type="number" min={0} max={100} step={0.1} value={draft.progress_pct} onChange={(e) => setDraft({ ...draft, progress_pct: Number(e.target.value) })} /></label>
            <button className="primary" onClick={onSaveInfo}>저장</button>
          </div>
          <div className="dash-edit-row">
            <label className="grow">개요<input value={draft.summary} placeholder="사업 개요 메모" onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
          </div>
          <div className="dash-edit-row">
            <strong>마일스톤 추가:</strong>
            <input value={mName} placeholder="예: 노반 완료" onChange={(e) => setMName(e.target.value)} />
            <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
            <button onClick={onAddMilestone}>추가</button>
          </div>
        </section>
      )}

      {/* ---- 전체 진행률 ---- */}
      <section className="card dash-progress">
        <div className="dash-progress-head">
          <h3>전체 진행률</h3>
          <span className="dash-progress-pct">{progress.toFixed(0)}%</span>
        </div>
        <div className="dash-bar"><div className="dash-bar-fill" style={{ width: `${Math.min(100, progress)}%` }} /></div>
        {info?.summary && <p className="muted dash-summary">{info.summary}</p>}
      </section>

      {/* ---- 차트 + 스탯 그리드 ---- */}
      <section className="dash-grid">
        <div className="card">
          <h3>공사일지 현황 <span className="muted">(투입 인력 추이)</span></h3>
          <MiniChart
            series={[{ values: logsAsc.map((l) => l.manpower), color: 'var(--accent)', fill: true }]}
            labels={logsAsc.length ? [logsAsc[0].log_date.slice(5), logsAsc[logsAsc.length - 1].log_date.slice(5)] : undefined}
          />
          <p className="muted dash-hint">공사일보 {logs.length}건 · <button className="cde-link" onClick={() => navigate(`/project/${projectId}/logs`)}>일보 입력 →</button></p>
        </div>

        <div className="card">
          <h3>기성 현황 <span className="muted">(계획 vs 실적 %)</span></h3>
          <MiniChart
            series={[
              { values: monthly.map((m) => Number(m.planned_pct)), color: 'var(--muted)' },
              { values: monthly.map((m) => Number(m.actual_pct)), color: 'var(--accent)', fill: true },
            ]}
            labels={monthly.length ? [monthly[0].ym, monthly[monthly.length - 1].ym] : undefined}
          />
          <p className="muted dash-hint">
            누적 기성 {formatAmount(monthly.reduce((s, m) => s + Number(m.billing_amount), 0))}원
          </p>
        </div>

        <button className="card dash-stat dash-link-card" onClick={() => navigate(`/project/${projectId}/viewer`)}>
          <h3>모델뷰어 (3D)</h3>
          <div className="dash-stat-big">🧊</div>
          <p className="muted">3D 실측 공사현황 확인 →</p>
        </button>

        <div className="card dash-stat">
          <h3>투입 인력</h3>
          <div className="dash-stat-big">{latest?.manpower ?? 0}<small>명</small></div>
          <p className="muted">{latest ? formatDate(latest.log_date) + ' 기준' : '일보 없음'}</p>
        </div>

        <div className="card dash-stat">
          <h3>장비 현황</h3>
          <div className="dash-stat-big">{latest?.equipment ?? 0}<small>대</small></div>
          <p className="muted">{latest ? formatDate(latest.log_date) + ' 기준' : '일보 없음'}</p>
        </div>
      </section>

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

function MilestoneCard({
  label,
  big,
  note,
  onDelete,
}: {
  label: string;
  date: string | null;
  big: string;
  note: string;
  onDelete?: () => void;
}) {
  return (
    <div className="dash-ms">
      <span className="dash-ms-label">{label}</span>
      <span className="dash-ms-big">{big}</span>
      <span className="dash-ms-note muted">{note}</span>
      {onDelete && <button className="dash-ms-del danger" onClick={onDelete}>×</button>}
    </div>
  );
}
