import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { TrendChart } from '../components/TrendChart';
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

/** Rough width (px) of a timeline label line at 11px semibold: Hangul ≈ 11px, other characters ≈ 6.6px. */
const labelWidth = (text: string) => [...text].reduce((w, c) => w + (/[\u3131-\uD79D]/.test(c) ? 11 : 6.6), 0) + 8;

/**
 * Lanes for the milestone labels so close dates do not overlap: 0 / 2 below the track (first, second row), 1 / 3 above.
 * Labels alternate below / above as before and move to a second row only when the first is taken where they sit.
 */
function labelLanes(spans: [number, number][]): number[] {
  const ends = [-Infinity, -Infinity, -Infinity, -Infinity];
  return spans.map(([a, b], i) => {
    const order = i % 2 === 0 ? [0, 1, 2, 3] : [1, 0, 3, 2];
    const lane = order.find(l => ends[l] + 8 <= a) ?? order.reduce((best, l) => (ends[l] < ends[best] ? l : best), order[0]);
    ends[lane] = b;
    return lane;
  });
}

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
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(1000);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

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
  const placed = markers
    .map((m, i) => ({ m, i, p: pos(m.date) }))
    .filter((x): x is { m: (typeof markers)[number]; i: number; p: number } => x.p !== null)
    .sort((a, b) => a.p - b.p);
  const lanes = labelLanes(placed.map(({ m, i, p }) => {
    const w = Math.max(labelWidth(m.name), labelWidth(`${formatDate(m.date)} · ${ddayLabel(m.date)}`));
    const x = (p / 100) * trackW;
    // First and last labels are anchored inward (CSS is-first / is-last).
    return i === 0 ? [x - 6, x - 6 + w] : i === markers.length - 1 ? [x + 6 - w, x + 6] : [x - w / 2, x + w / 2];
  }));
  const laneOf = new Map(placed.map((x, k) => [x.i, lanes[k]]));
  const timelinePad = {
    '--sched-pad-top': `${lanes.includes(3) ? 64 : 34}px`,
    '--sched-pad-bottom': `${lanes.includes(2) ? 70 : 40}px`,
  } as CSSProperties;

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
          <div className="sched-timeline" style={timelinePad}>
            <div className="sched-track" ref={trackRef}>
              {todayPos !== null && (
                <div className="sched-today" style={{ left: `${todayPos}%` }} title="오늘" />
              )}
              {markers.map((m, i) => {
                const p = pos(m.date);
                if (p === null) return null;
                return (
                  <div className={`sched-marker lane-${laneOf.get(i) ?? 0}${i === 0 ? ' is-first' : ''}${i === markers.length - 1 ? ' is-last' : ''}`} key={i} style={{ left: `${p}%` }}>
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
        <TrendChart
          height={240}
          domain={[0, 100]}
          data={monthly.map((m) => ({ ym: m.ym, 계획: Number(m.planned_pct), 실적: Number(m.actual_pct) }))}
          x="ym"
          series={[
            { key: '계획', color: 'var(--chart-2)', dashed: true },
            { key: '실적', color: 'var(--chart-1)', kind: 'area' },
          ]}
        />
        <div className="dash-chart-legend" aria-hidden>
          <span><i style={{ borderTopColor: 'var(--chart-1)' }} /> 실적</span>
          <span><i style={{ borderTopColor: 'var(--chart-2)', borderTopStyle: 'dashed' }} /> 계획</span>
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
