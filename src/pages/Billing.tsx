import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MiniChart } from '../components/MiniChart';
import { formatAmount, listMonthlyRecords, type MonthlyRecord } from '../lib/dashboard';
import { getContractAmount, saveContractAmount } from '../lib/portal';

/**
 * 기성내역 — billing detail. 도급액 대비 누적 기성/기성률, 월별 기성 추이.
 * 월별 수치는 사업개요 편집(monthly_records)에서 입력하고, 여기서 도급액과
 * 함께 금액 기준으로 정리한다.
 */
export function Billing() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [monthly, setMonthly] = useState<MonthlyRecord[]>([]);
  const [contract, setContract] = useState(0);
  const [draft, setDraft] = useState('0');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    listMonthlyRecords(projectId).then(setMonthly).catch(() => setMonthly([]));
    getContractAmount(projectId)
      .then((a) => {
        setContract(a);
        setDraft(String(a));
      })
      .catch(() => setContract(0));
  }, [projectId]);

  const onSaveContract = async () => {
    try {
      const amount = Number(draft) || 0;
      await saveContractAmount(projectId, amount);
      setContract(amount);
      setMsg('도급액 저장됨');
    } catch (e) {
      setMsg(`저장 실패: ${(e as Error).message}`);
    }
  };

  const totalBilling = monthly.reduce((s, m) => s + Number(m.billing_amount), 0);
  const rate = contract > 0 ? (totalBilling / contract) * 100 : 0;
  const remaining = Math.max(0, contract - totalBilling);

  // cumulative billing series for the chart
  let acc = 0;
  const cumulative = monthly.map((m) => (acc += Number(m.billing_amount)));

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">기성내역</h1>
        <button onClick={() => navigate(`/project/${projectId}/schedule`)}>공정현황 →</button>
      </div>

      <section className="dash-grid">
        <div className="card dash-stat">
          <h3>도급액</h3>
          <div className="dash-stat-big" style={{ fontSize: 30 }}>{formatAmount(contract)}<small>원</small></div>
          <div className="dash-edit-row" style={{ marginTop: 8 }}>
            <input type="number" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button onClick={onSaveContract}>저장</button>
          </div>
        </div>
        <div className="card dash-stat">
          <h3>누적 기성</h3>
          <div className="dash-stat-big" style={{ fontSize: 30 }}>{formatAmount(totalBilling)}<small>원</small></div>
          <p className="muted">{monthly.length}개월 누계</p>
        </div>
        <div className="card dash-stat">
          <h3>기성률</h3>
          <div className="dash-stat-big" style={{ color: 'var(--accent)' }}>{rate.toFixed(1)}<small>%</small></div>
          <div className="dash-bar" style={{ marginTop: 8 }}><div className="dash-bar-fill" style={{ width: `${Math.min(100, rate)}%` }} /></div>
        </div>
        <div className="card dash-stat">
          <h3>잔여 도급</h3>
          <div className="dash-stat-big" style={{ fontSize: 30 }}>{formatAmount(remaining)}<small>원</small></div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h3>월별 기성 추이 <span className="muted">(누적)</span></h3>
        <MiniChart
          height={180}
          type="bar"
          series={[{ values: monthly.map((m) => Number(m.billing_amount)), color: 'var(--accent)' }]}
          labels={monthly.length ? [monthly[0].ym, monthly[monthly.length - 1].ym] : undefined}
        />
        {monthly.length > 0 ? (
          <div className="cde-table-wrap" style={{ padding: 0, marginTop: 12 }}>
            <table className="cde-table">
              <thead><tr><th>월</th><th className="right">월 기성</th><th className="right">누적 기성</th><th className="right">실적 %</th></tr></thead>
              <tbody>
                {monthly.map((m, i) => (
                  <tr key={m.id}>
                    <td>{m.ym}</td>
                    <td className="right">{formatAmount(Number(m.billing_amount))}</td>
                    <td className="right">{formatAmount(cumulative[i])}</td>
                    <td className="right">{Number(m.actual_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>사업개요 편집에서 월별 기성 금액을 입력하면 표시됩니다.</p>
        )}
      </section>

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
