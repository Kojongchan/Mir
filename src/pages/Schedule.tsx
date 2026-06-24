import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { MiniChart } from '../components/MiniChart';
import { errMessage } from '../lib/errors';
import {
  ddayLabel,
  deleteMonthlyRecord,
  formatDate,
  getProjectInfo,
  listMilestones,
  listMonthlyRecords,
  saveMonthlyRecord,
  todayISO,
  type Milestone,
  type MonthlyRecord,
  type ProjectInfo,
} from '../lib/dashboard';

/**
 * 공정현황 — schedule overview. A milestone timeline (착공→준공) plus the
 * planned/actual S-curve from monthly records, and a jump to the 4D simulation
 * in the model viewer. Reuses the dashboard data model (no new migration).
 */
export function Schedule() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  // 공정(월별 실적) 입력·수정·삭제 = 실무자(editor) 이상. RLS(0023)와 일치.
  const { canEdit } = useProjectRole(projectId);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRecord[]>([]);
  const [rec, setRec] = useState({ ym: todayISO().slice(0, 7), planned_pct: 0, actual_pct: 0, billing_amount: 0 });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getProjectInfo(projectId).then(setInfo).catch(() => setInfo(null));
    listMilestones(projectId).then(setMilestones).catch(() => setMilestones([]));
    listMonthlyRecords(projectId).then(setMonthly).catch(() => setMonthly([]));
  }, [projectId]);

  const refreshMonthly = () => listMonthlyRecords(projectId).then(setMonthly).catch(() => setMonthly([]));

  const onSaveRecord = async () => {
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
      await refreshMonthly();
      setMsg(`${rec.ym} 저장됨`);
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const start = info?.start_date ? new Date(info.start_date + 'T00:00:00').getTime() : null;
  const end = info?.end_date ? new Date(info.end_date + 'T00:00:00').getTime() : null;
  const span = start !== null && end !== null && end > start ? end - start : null;
  const pos = (date: string | null): number | null => {
    if (!date || start === null || span === null) return null;
    const t = new Date(date + 'T00:00:00').getTime();
    return Math.max(0, Math.min(100, ((t - start) / span) * 100));
  };
  const todayPos = (() => {
    if (start === null || span === null) return null;
    return Math.max(0, Math.min(100, ((Date.now() - start) / span) * 100));
  })();

  const markers = [
    info?.start_date ? { name: '착공', date: info.start_date } : null,
    ...milestones.map((m) => ({ name: m.name, date: m.target_date })),
    info?.end_date ? { name: '준공', date: info.end_date } : null,
  ].filter((x): x is { name: string; date: string | null } => !!x && !!x.date);

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">공정현황</h1>
        <button onClick={() => navigate(`/project/${projectId}/viewer`)}>4D 시뮬레이션 열기 →</button>
      </div>

      {/* ---- 마일스톤 타임라인 ---- */}
      <section className="card">
        <h3>마일스톤 타임라인 <span className="muted">(착공 → 준공)</span></h3>
        {span === null ? (
          <p className="muted">착공일·준공 예정일을 사업개요에서 설정하면 타임라인이 표시됩니다.</p>
        ) : (
          <div className="sched-timeline">
            <div className="sched-track">
              {todayPos !== null && (
                <div className="sched-today" style={{ left: `${todayPos}%` }} title="오늘" />
              )}
              {markers.map((m, i) => {
                const p = pos(m.date);
                if (p === null) return null;
                return (
                  <div className="sched-marker" key={i} style={{ left: `${p}%` }}>
                    <span className="sched-dot" />
                    <span className="sched-marker-label">
                      {m.name}<br /><span className="muted">{formatDate(m.date)} · {ddayLabel(m.date)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* ---- 진도 곡선 (S-curve) ---- */}
      <section className="card">
        <h3>진도 곡선 <span className="muted">(월별 계획 vs 실적 %)</span></h3>
        <MiniChart
          height={200}
          series={[
            { values: monthly.map((m) => Number(m.planned_pct)), color: 'var(--muted)' },
            { values: monthly.map((m) => Number(m.actual_pct)), color: 'var(--accent)', fill: true },
          ]}
          labels={monthly.length ? [monthly[0].ym, monthly[monthly.length - 1].ym] : undefined}
        />
        <div className="sched-legend muted">
          <span><i className="legend-swatch" style={{ background: 'var(--muted)' }} /> 계획</span>
          <span><i className="legend-swatch" style={{ background: 'var(--accent)' }} /> 실적</span>
        </div>
        {canEdit && (
          <div className="dash-edit-row" style={{ marginTop: 12 }}>
            <label>월(YYYY-MM)<input value={rec.ym} onChange={(e) => setRec({ ...rec, ym: e.target.value })} /></label>
            <label>계획(%)<input type="number" value={rec.planned_pct} onChange={(e) => setRec({ ...rec, planned_pct: Number(e.target.value) })} /></label>
            <label>실적(%)<input type="number" value={rec.actual_pct} onChange={(e) => setRec({ ...rec, actual_pct: Number(e.target.value) })} /></label>
            <label>기성(원)<input type="number" value={rec.billing_amount} onChange={(e) => setRec({ ...rec, billing_amount: Number(e.target.value) })} /></label>
            <button className="primary" onClick={onSaveRecord}>저장</button>
          </div>
        )}
        {monthly.length > 0 ? (
          <div className="cde-table-wrap" style={{ padding: 0, marginTop: 12 }}>
            <table className="cde-table">
              <thead><tr><th>월</th><th className="right">계획 %</th><th className="right">실적 %</th><th className="right">차이</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {monthly.map((m) => {
                  const diff = Number(m.actual_pct) - Number(m.planned_pct);
                  return (
                    <tr key={m.id}>
                      <td>{m.ym}</td>
                      <td className="right">{Number(m.planned_pct)}</td>
                      <td className="right">{Number(m.actual_pct)}</td>
                      <td className="right" style={{ color: diff < 0 ? 'var(--danger)' : 'var(--accent)' }}>
                        {diff > 0 ? '+' : ''}{diff.toFixed(1)}
                      </td>
                      {canEdit && (
                        <td className="right">
                          <button onClick={() => setRec({ ym: m.ym, planned_pct: Number(m.planned_pct), actual_pct: Number(m.actual_pct), billing_amount: Number(m.billing_amount) })}>수정</button>
                          <button className="danger" onClick={() => deleteMonthlyRecord(m.id).then(refreshMonthly)}>삭제</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            {canEdit ? '위에서 월·계획%·실적%를 입력하면 곡선이 그려집니다.' : '아직 입력된 월별 계획·실적이 없습니다.'}
          </p>
        )}
        {msg && <p className="muted dash-msg">{msg}</p>}
      </section>
    </div>
  );
}
