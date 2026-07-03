import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyState } from '../components/EmptyState';
import { errMessage } from '../lib/errors';
import { useProjectRole } from '../auth/useProjectRole';
import {
  addEvmActual,
  billedToDate,
  buildCurve,
  bulkAddEvmActuals,
  categoryMetrics,
  computeMetrics,
  deleteCostRate,
  deleteEvmActual,
  listCostRates,
  listEvmActuals,
  parseEvmCsv,
  rateBudget,
  upsertCostRate,
  type CostRate,
  type EvmActual,
} from '../lib/evm';

const won = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;
const idxFmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));
/** 지수 색: ≥1 양호(success), 0.95~1 주의, <0.95 위험. */
const idxClass = (v: number | null) => (v == null ? '' : v >= 1 ? 'kpi--success' : v >= 0.95 ? 'kpi--warning' : 'kpi--danger');

/** R6 — EVM 원가관리(5D). PV/EV/AC 3선 + CPI/SPI/EAC + 공종별 지표 + CSV + 기성 대사. */
export function Evm() {
  const { projectId = '' } = useParams();
  const { canEdit } = useProjectRole(projectId);

  const [rates, setRates] = useState<CostRate[]>([]);
  const [actuals, setActuals] = useState<EvmActual[]>([]);
  const [billed, setBilled] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [snap, setSnap] = useState({ as_of_date: new Date().toISOString().slice(0, 10), pv: '', ev: '', ac: '', category: '' });

  useEffect(() => {
    refresh();
    billedToDate(projectId).then(setBilled).catch(() => setBilled(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = async () => {
    try {
      const [r, a] = await Promise.all([listCostRates(projectId), listEvmActuals(projectId)]);
      setRates(r);
      setActuals(a);
      setUnavailable(false);
    } catch {
      setRates([]);
      setActuals([]);
      setUnavailable(true);
    }
  };

  const metrics = useMemo(() => computeMetrics(rates, actuals), [rates, actuals]);
  const curve = useMemo(() => buildCurve(actuals), [actuals]);
  const catMetrics = useMemo(() => categoryMetrics(rates, actuals), [rates, actuals]);

  const onAddRate = async () => {
    try {
      await upsertCostRate(projectId, { category: '신규 공종', unit_price: 0, manual_qty: 0, sort_order: rates.length });
      await refresh();
    } catch (e) {
      setMsg(`추가 실패: ${errMessage(e)}`);
    }
  };
  const onSaveRate = async (r: CostRate) => {
    try {
      await upsertCostRate(projectId, r);
      await refresh();
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onAddSnapshot = async () => {
    if (!snap.as_of_date) {
      setMsg('기준일을 입력하세요');
      return;
    }
    try {
      await addEvmActual(projectId, {
        category: snap.category || null,
        as_of_date: snap.as_of_date,
        pv_amount: Number(snap.pv) || 0,
        ev_amount: Number(snap.ev) || 0,
        ac_amount: Number(snap.ac) || 0,
      });
      setSnap({ ...snap, pv: '', ev: '', ac: '', category: '' });
      await refresh();
      setMsg('스냅샷 추가됨');
    } catch (e) {
      setMsg(`추가 실패: ${errMessage(e)}`);
    }
  };

  const onCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { rows, errors } = parseEvmCsv(text);
      if (rows.length) {
        const n = await bulkAddEvmActuals(projectId, rows);
        await refresh();
        setMsg(`CSV ${n}행 반영${errors.length ? ` (경고 ${errors.length}건: ${errors[0]})` : ''}`);
      } else {
        setMsg(`반영할 행 없음 — ${errors[0] ?? '형식 확인'}`);
      }
    } catch (e2) {
      setMsg(`CSV 실패: ${errMessage(e2)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">EVM · 원가관리 (5D)</h1>
      </div>

      {unavailable && (
        <EmptyState icon="📉" title="EVM 모듈이 아직 활성화되지 않았습니다" desc="마이그레이션(0036) 적용 후 원가·획득가치 관리를 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          {/* KPI 지표 */}
          <div className="evm-kpis">
            <KpiCard label="BAC(총예산)" value={won(metrics.bac)} />
            <KpiCard label="PV(계획)" value={won(metrics.pv)} />
            <KpiCard label="EV(획득)" value={won(metrics.ev)} />
            <KpiCard label="AC(실제)" value={won(metrics.ac)} />
            <KpiCard label="CPI(원가효율)" value={idxFmt(metrics.cpi)} cls={idxClass(metrics.cpi)} meta={metrics.cv >= 0 ? `CV +${won(metrics.cv)}` : `CV ${won(metrics.cv)}`} />
            <KpiCard label="SPI(일정효율)" value={idxFmt(metrics.spi)} cls={idxClass(metrics.spi)} meta={metrics.sv >= 0 ? `SV +${won(metrics.sv)}` : `SV ${won(metrics.sv)}`} />
            <KpiCard label="EAC(완료예측)" value={metrics.eac != null ? won(metrics.eac) : '—'} meta={metrics.vac != null ? (metrics.vac >= 0 ? `VAC +${won(metrics.vac)}` : `VAC ${won(metrics.vac)}`) : undefined} cls={metrics.vac != null && metrics.vac < 0 ? 'kpi--danger' : ''} />
          </div>

          {/* 3선 S-curve */}
          <section className="card">
            <h3 style={{ marginTop: 0 }}>PV · EV · AC S-Curve</h3>
            {curve.length === 0 ? (
              <EmptyState compact icon="📈" title="스냅샷이 없습니다" desc="기준일별 PV/EV/AC 를 입력하거나 CSV 를 업로드하세요." />
            ) : (
              <>
                <div style={{ width: '100%', height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" />
                      <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" width={64} tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}M`} />
                      <Tooltip formatter={((v: number) => won(Number(v))) as never} contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
                      <Legend />
                      <Line type="monotone" dataKey="PV" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                      <Line type="monotone" dataKey="EV" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="AC" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="2 3" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                  PV=계획(teal 파선) · EV=획득(brand 실선) · AC=실제(amber 점선). EV&lt;PV면 일정지연, EV&lt;AC면 원가초과.
                </p>
              </>
            )}
          </section>

          {/* 기성 대사 */}
          {billed != null && (
            <section className="card evm-recon">
              <h3 style={{ marginTop: 0 }}>기성내역 대사</h3>
              <div className="evm-recon-grid">
                <div><span className="muted">누적 기성(billing)</span><strong className="tabular">{won(billed)}</strong></div>
                <div><span className="muted">획득가치 EV</span><strong className="tabular">{won(metrics.ev)}</strong></div>
                <div><span className="muted">차이(EV−기성)</span><strong className={`tabular ${metrics.ev - billed >= 0 ? '' : 'bic-overdue'}`}>{won(metrics.ev - billed)}</strong></div>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>기성 청구액과 획득가치의 괴리를 점검합니다(과청구·미청구 조기 감지).</p>
            </section>
          )}

          {/* cost_rates 예산 편집 */}
          <section className="card" style={{ padding: 0 }}>
            <div className="dash-head" style={{ padding: '12px 14px 0' }}>
              <h3 style={{ margin: 0 }}>공종별 단가·물량 (예산 BAC)</h3>
              {canEdit && <button onClick={onAddRate}>＋ 공종 추가</button>}
            </div>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead>
                  <tr>
                    <th>공종</th>
                    <th>물량근거</th>
                    <th className="col-num">단가</th>
                    <th className="col-num">물량</th>
                    <th className="col-num">예산(단가×물량)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <RateRow key={r.id} rate={r} canEdit={canEdit} onSave={onSaveRate} onDelete={async (id) => { await deleteCostRate(id); await refresh(); }} />
                  ))}
                  {rates.length === 0 && (
                    <tr><td colSpan={6}><EmptyState compact icon="🧮" title="예산 공종이 없습니다" desc="공종을 추가해 단가·물량으로 총예산(BAC)을 구성하세요." /></td></tr>
                  )}
                  {rates.length > 0 && (
                    <tr className="evm-total-row">
                      <td colSpan={4}><strong>합계 (BAC)</strong></td>
                      <td className="col-num"><strong className="tabular">{won(metrics.bac)}</strong></td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* 공종별 EVM 지표표 */}
          {catMetrics.length > 0 && (
            <section className="card" style={{ padding: 0 }}>
              <div className="dash-head" style={{ padding: '12px 14px 0' }}>
                <h3 style={{ margin: 0 }}>공종별 EVM 지표</h3>
              </div>
              <div className="cde-table-wrap" style={{ padding: 0 }}>
                <table className="cde-table">
                  <thead>
                    <tr>
                      <th>공종</th>
                      <th className="col-num">BAC</th>
                      <th className="col-num">PV</th>
                      <th className="col-num">EV</th>
                      <th className="col-num">AC</th>
                      <th className="col-num">CPI</th>
                      <th className="col-num">SPI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catMetrics.map((m) => (
                      <tr key={m.category}>
                        <td>{m.category}</td>
                        <td className="col-num tabular">{won(m.bac)}</td>
                        <td className="col-num tabular">{won(m.pv)}</td>
                        <td className="col-num tabular">{won(m.ev)}</td>
                        <td className="col-num tabular">{won(m.ac)}</td>
                        <td className={`col-num tabular ${idxClass(m.cpi)}`}>{idxFmt(m.cpi)}</td>
                        <td className={`col-num tabular ${idxClass(m.spi)}`}>{idxFmt(m.spi)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 스냅샷 입력 + CSV */}
          {canEdit && (
            <section className="card dash-edit">
              <h3>기준일 PV/EV/AC 스냅샷 입력</h3>
              <div className="dash-edit-row">
                <label>기준일<input type="date" value={snap.as_of_date} onChange={(e) => setSnap({ ...snap, as_of_date: e.target.value })} /></label>
                <label>공종(선택)<input value={snap.category} placeholder="비우면 전체" onChange={(e) => setSnap({ ...snap, category: e.target.value })} /></label>
                <label>PV<input type="number" value={snap.pv} onChange={(e) => setSnap({ ...snap, pv: e.target.value })} /></label>
                <label>EV<input type="number" value={snap.ev} onChange={(e) => setSnap({ ...snap, ev: e.target.value })} /></label>
                <label>AC<input type="number" value={snap.ac} onChange={(e) => setSnap({ ...snap, ac: e.target.value })} /></label>
                <button className="primary" onClick={onAddSnapshot}>추가</button>
              </div>
              <div className="dash-edit-row" style={{ alignItems: 'center' }}>
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onCsv} />
                <button onClick={() => fileRef.current?.click()}>⬆ 실제원가 CSV 업로드</button>
                <span className="muted" style={{ fontSize: 12 }}>헤더: category, as_of_date, pv, ev, ac [, note]</span>
              </div>
              {actuals.length > 0 && (
                <div className="evm-snap-list">
                  {actuals.slice(-8).reverse().map((a) => (
                    <div key={a.id} className="evm-snap-row">
                      <span className="tabular">{a.as_of_date}</span>
                      <span className="muted">{a.category || '전체'}</span>
                      <span className="tabular">PV {won(a.pv_amount)} · EV {won(a.ev_amount)} · AC {won(a.ac_amount)}</span>
                      <button className="attach-del" title="삭제" onClick={async () => { await deleteEvmActual(a.id); await refresh(); }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

function KpiCard({ label, value, meta, cls = '' }: { label: string; value: string; meta?: string; cls?: string }) {
  return (
    <div className={`kpi-card ${cls}`}>
      <span className="kpi-card__label">{label}</span>
      <span className="kpi-card__value tabular">{value}</span>
      {meta && <span className="kpi-card__meta tabular">{meta}</span>}
    </div>
  );
}

function RateRow({
  rate,
  canEdit,
  onSave,
  onDelete,
}: {
  rate: CostRate;
  canEdit: boolean;
  onSave: (r: CostRate) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState(rate);
  useEffect(() => setDraft(rate), [rate]);
  const dirty = draft.category !== rate.category || draft.qty_basis !== rate.qty_basis || draft.unit_price !== rate.unit_price || draft.manual_qty !== rate.manual_qty;

  if (!canEdit) {
    return (
      <tr>
        <td>{rate.category}</td>
        <td>{rate.qty_basis || '—'}</td>
        <td className="col-num tabular">{won(rate.unit_price)}</td>
        <td className="col-num tabular">{rate.manual_qty.toLocaleString('ko-KR')}</td>
        <td className="col-num tabular">{won(rateBudget(rate))}</td>
        <td />
      </tr>
    );
  }
  return (
    <tr>
      <td><input className="evm-cell" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></td>
      <td><input className="evm-cell" value={draft.qty_basis ?? ''} onChange={(e) => setDraft({ ...draft, qty_basis: e.target.value })} /></td>
      <td className="col-num"><input className="evm-cell evm-cell-num" type="number" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: Number(e.target.value) })} /></td>
      <td className="col-num"><input className="evm-cell evm-cell-num" type="number" value={draft.manual_qty} onChange={(e) => setDraft({ ...draft, manual_qty: Number(e.target.value) })} /></td>
      <td className="col-num tabular">{won(rateBudget(draft))}</td>
      <td className="right nowrap">
        {dirty && <button className="primary" onClick={() => onSave(draft)}>저장</button>}
        <button className="danger" onClick={() => onDelete(rate.id)}>삭제</button>
      </td>
    </tr>
  );
}
