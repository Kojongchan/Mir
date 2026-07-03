import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { ModuleTabs, costTabs } from '../components/ModuleTabs';
import { errMessage } from '../lib/errors';
import { useProjectRole } from '../auth/useProjectRole';
import { MiniChart } from '../components/MiniChart';
import { formatAmount, listMonthlyRecords, type MonthlyRecord } from '../lib/dashboard';
import {
  createBillingItem,
  deleteBillingItem,
  getContractAmount,
  listBillingItems,
  saveContractAmount,
  updateBillingItem,
  type BillingItem,
} from '../lib/portal';

/**
 * 기성내역 — billing detail. 도급액 대비 누적 기성/기성률, 월별 기성 추이.
 * 월별 수치는 사업개요 편집(monthly_records)에서 입력하고, 여기서 도급액과
 * 함께 금액 기준으로 정리한다.
 */
export function Billing() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  // 도급액·기성내역 입력·수정·삭제 = 실무자(editor) 이상. RLS(0023)와 일치.
  const { canEdit } = useProjectRole(projectId);
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
      setMsg(`저장 실패: ${errMessage(e)}`);
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
        <h1 className="dash-h1">원가 · 기성</h1>
        <button onClick={() => navigate(`/project/${projectId}/schedule`)}>공정현황 →</button>
      </div>

      <ModuleTabs tabs={costTabs(projectId)} />

      <section className="dash-grid">
        <div className="card dash-stat">
          <h3>도급액</h3>
          <div className="dash-stat-big" style={{ fontSize: 30 }}>{formatAmount(contract)}<small>원</small></div>
          {canEdit && (
            <div className="dash-edit-row" style={{ marginTop: 8 }}>
              <input type="number" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button onClick={onSaveContract}>저장</button>
            </div>
          )}
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
          <p className="muted" style={{ marginTop: 10 }}>공정현황 또는 사업개요에서 월별 기성 금액을 입력하면 표시됩니다.</p>
        )}
      </section>

      <BillingItemsSection projectId={projectId} canEdit={canEdit} />

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

const EMPTY_ITEM = { category: '', contract_amount: 0, prev_amount: 0, current_amount: 0 };

/** 공종별 기성 명세 — 도급액 / 전월 누계 / 당월 → 누계·기성률. */
function BillingItemsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [items, setItems] = useState<BillingItem[]>([]);
  const [form, setForm] = useState<typeof EMPTY_ITEM>(EMPTY_ITEM);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listBillingItems(projectId).then(setItems).catch(() => setItems([]));

  const onSave = async () => {
    if (!form.category.trim()) {
      setMsg('공종명을 입력하세요');
      return;
    }
    const payload = {
      category: form.category.trim(),
      contract_amount: Number(form.contract_amount) || 0,
      prev_amount: Number(form.prev_amount) || 0,
      current_amount: Number(form.current_amount) || 0,
    };
    try {
      if (editId) await updateBillingItem(editId, payload);
      else await createBillingItem(projectId, payload, items.length);
      setForm(EMPTY_ITEM);
      setEditId(null);
      await refresh();
      setMsg('저장됨');
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onEdit = (it: BillingItem) => {
    setEditId(it.id);
    setForm({
      category: it.category,
      contract_amount: Number(it.contract_amount),
      prev_amount: Number(it.prev_amount),
      current_amount: Number(it.current_amount),
    });
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 공종 행을 삭제할까요?')) return;
    await deleteBillingItem(id);
    if (editId === id) {
      setEditId(null);
      setForm(EMPTY_ITEM);
    }
    await refresh();
  };

  const tot = items.reduce(
    (a, it) => {
      a.contract += Number(it.contract_amount);
      a.cum += Number(it.prev_amount) + Number(it.current_amount);
      a.current += Number(it.current_amount);
      return a;
    },
    { contract: 0, cum: 0, current: 0 },
  );
  const totRate = tot.contract > 0 ? (tot.cum / tot.contract) * 100 : 0;

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <h3>공종별 기성 명세 <span className="muted">(도급액 · 전월누계 · 당월 → 누계 · 기성률)</span></h3>

      {canEdit && (
        <div className="dash-edit-row">
          <label>공종<input value={form.category} placeholder="예: 토공" onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
          <label>도급액<input type="number" value={form.contract_amount} onChange={(e) => setForm({ ...form, contract_amount: Number(e.target.value) })} /></label>
          <label>전월 누계<input type="number" value={form.prev_amount} onChange={(e) => setForm({ ...form, prev_amount: Number(e.target.value) })} /></label>
          <label>당월<input type="number" value={form.current_amount} onChange={(e) => setForm({ ...form, current_amount: Number(e.target.value) })} /></label>
          <button className="primary" onClick={onSave}>{editId ? '수정 저장' : '추가'}</button>
          {editId && <button onClick={() => { setEditId(null); setForm(EMPTY_ITEM); }}>취소</button>}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState icon="🧾" title="등록된 공종별 명세가 없습니다" desc="기성 명세를 등록하면 여기에 표시됩니다." />
      ) : (
        <div className="cde-table-wrap" style={{ padding: 0, marginTop: 8 }}>
          <table className="cde-table">
            <thead>
              <tr>
                <th>공종</th><th className="right">도급액</th><th className="right">전월누계</th>
                <th className="right">당월</th><th className="right">누계</th><th className="right">기성률</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const cum = Number(it.prev_amount) + Number(it.current_amount);
                const rate = Number(it.contract_amount) > 0 ? (cum / Number(it.contract_amount)) * 100 : 0;
                return (
                  <tr key={it.id}>
                    <td>{it.category}</td>
                    <td className="right">{formatAmount(Number(it.contract_amount))}</td>
                    <td className="right">{formatAmount(Number(it.prev_amount))}</td>
                    <td className="right">{formatAmount(Number(it.current_amount))}</td>
                    <td className="right">{formatAmount(cum)}</td>
                    <td className="right">{rate.toFixed(1)}%</td>
                    {canEdit && (
                      <td className="right nowrap">
                        <button onClick={() => onEdit(it)}>수정</button>
                        <button className="danger" onClick={() => onDelete(it.id)}>삭제</button>
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 700 }}>
                <td>합계</td>
                <td className="right">{formatAmount(tot.contract)}</td>
                <td className="right">—</td>
                <td className="right">{formatAmount(tot.current)}</td>
                <td className="right">{formatAmount(tot.cum)}</td>
                <td className="right">{totRate.toFixed(1)}%</td>
                {canEdit && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {msg && <p className="muted dash-msg">{msg}</p>}
    </section>
  );
}
