import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import {
  SUB_STATUS_LABEL,
  createSubcontract,
  deleteSubcontract,
  listSubcontracts,
  type SubStatus,
  type Subcontract,
} from '../lib/portal';
import { formatAmount } from '../lib/dashboard';

const STATUSES: SubStatus[] = ['active', 'done', 'terminated'];

/** 하도급내역 — 협력사 계약/지급 현황. */
export function Subcontracts() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const [rows, setRows] = useState<Subcontract[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({
    company: '',
    trade: '',
    contract_amount: 0,
    paid_amount: 0,
    start_date: '',
    end_date: '',
    status: 'active' as SubStatus,
    note: '',
  });

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listSubcontracts(projectId).then(setRows).catch(() => setRows([]));

  const onCreate = async () => {
    if (!form.company.trim()) {
      setMsg('협력사명을 입력하세요');
      return;
    }
    try {
      await createSubcontract(projectId, {
        company: form.company.trim(),
        trade: form.trade || null,
        contract_amount: Number(form.contract_amount) || 0,
        paid_amount: Number(form.paid_amount) || 0,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        status: form.status,
        note: form.note || null,
      });
      setForm({ company: '', trade: '', contract_amount: 0, paid_amount: 0, start_date: '', end_date: '', status: 'active', note: '' });
      setShowForm(false);
      await refresh();
      setMsg('하도급 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${(e as Error).message}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 항목을 삭제할까요?')) return;
    await deleteSubcontract(id);
    await refresh();
  };

  const totalContract = rows.reduce((s, r) => s + Number(r.contract_amount), 0);
  const totalPaid = rows.reduce((s, r) => s + Number(r.paid_amount), 0);
  const paidRate = totalContract > 0 ? (totalPaid / totalContract) * 100 : 0;

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">하도급내역</h1>
        {isAdmin && <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 협력사 등록'}</button>}
      </div>

      <section className="dash-grid">
        <div className="card dash-stat"><h3>계약 합계</h3><div className="dash-stat-big" style={{ fontSize: 28 }}>{formatAmount(totalContract)}<small>원</small></div></div>
        <div className="card dash-stat"><h3>기지급 합계</h3><div className="dash-stat-big" style={{ fontSize: 28 }}>{formatAmount(totalPaid)}<small>원</small></div></div>
        <div className="card dash-stat"><h3>지급률</h3><div className="dash-stat-big" style={{ color: 'var(--accent)' }}>{paidRate.toFixed(1)}<small>%</small></div></div>
        <div className="card dash-stat"><h3>협력사 수</h3><div className="dash-stat-big">{rows.length}<small>개사</small></div></div>
      </section>

      {showForm && (
        <section className="card dash-edit" style={{ marginTop: 14 }}>
          <h3>협력사 등록</h3>
          <div className="dash-edit-row">
            <label>협력사<input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></label>
            <label>공종<input value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })} /></label>
            <label>계약금액<input type="number" value={form.contract_amount} onChange={(e) => setForm({ ...form, contract_amount: Number(e.target.value) })} /></label>
            <label>기지급액<input type="number" value={form.paid_amount} onChange={(e) => setForm({ ...form, paid_amount: Number(e.target.value) })} /></label>
          </div>
          <div className="dash-edit-row">
            <label>시작<input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></label>
            <label>종료<input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></label>
            <label>상태
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SubStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{SUB_STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <label className="grow">비고<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            <button className="primary" onClick={onCreate}>등록</button>
          </div>
        </section>
      )}

      <section className="card" style={{ padding: 0, marginTop: 14 }}>
        <div className="cde-table-wrap" style={{ padding: 0 }}>
          <table className="cde-table">
            <thead>
              <tr>
                <th>협력사</th><th>공종</th><th className="right">계약금액</th><th className="right">기지급</th>
                <th className="right">지급률</th><th>기간</th><th>상태</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rate = Number(r.contract_amount) > 0 ? (Number(r.paid_amount) / Number(r.contract_amount)) * 100 : 0;
                return (
                  <tr key={r.id}>
                    <td>{r.company}</td>
                    <td>{r.trade || '—'}</td>
                    <td className="right">{formatAmount(Number(r.contract_amount))}</td>
                    <td className="right">{formatAmount(Number(r.paid_amount))}</td>
                    <td className="right">{rate.toFixed(0)}%</td>
                    <td className="nowrap muted">{r.start_date ?? '—'}~{r.end_date ?? ''}</td>
                    <td><span className={`issue-badge issue-${r.status === 'active' ? 'in_progress' : r.status === 'done' ? 'resolved' : 'closed'}`}>{SUB_STATUS_LABEL[r.status]}</span></td>
                    <td className="right">{isAdmin && <button className="danger" onClick={() => onDelete(r.id)}>삭제</button>}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={8} className="muted empty">등록된 하도급이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
