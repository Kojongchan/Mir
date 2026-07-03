import { useEffect, useMemo, useState } from 'react';
import { groupByCategory, type ApsElement } from '../lib/apsElements';
import { computeApsQuantities, type ApsCategoryQty, type ApsQtyResult } from '../lib/apsQuantities';
import { createBillingItem, listBillingItems } from '../lib/portal';
import { errMessage } from '../lib/errors';

const n2 = (n: number) => (n ? n.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—');

/** APS(ACC) 물량 산출 패널 — 공종별 체적/면적/길이 집계 + 기성 연동. QTO 모드에서 사용. */
export function ApsQtoPanel({
  viewer,
  model,
  elements,
  projectId,
  canEdit,
  onClose,
}: {
  viewer: any;
  model: any;
  elements: ApsElement[];
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const grouped = useMemo(() => groupByCategory(elements), [elements]);
  const categories = useMemo(() => Array.from(grouped.keys()).sort(), [grouped]);
  const [catFilter, setCatFilter] = useState('all');
  const [result, setResult] = useState<ApsQtyResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [msg, setMsg] = useState('');
  const [billingCount, setBillingCount] = useState(0);

  useEffect(() => {
    listBillingItems(projectId).then((b) => setBillingCount(b.length)).catch(() => setBillingCount(0));
  }, [projectId]);

  const onCompute = async () => {
    if (!model) return;
    setComputing(true);
    setMsg('');
    try {
      const dbIds = catFilter === 'all' ? undefined : grouped.get(catFilter);
      const res = await computeApsQuantities(model, elements, dbIds);
      setResult(res);
      if (res.total.count === 0) setMsg('대상 요소가 없습니다.');
      else if (res.total.volCount + res.total.areaCount + res.total.lenCount === 0)
        setMsg('요소는 찾았으나 수량 속성(Volume/Area/Length)이 없어 개수만 집계했습니다. (모델에 수량 속성 포함 필요)');
    } catch (e) {
      setMsg(`산출 실패: ${errMessage(e)}`);
    } finally {
      setComputing(false);
    }
  };

  const focusCategory = (category: string) => {
    const ids = grouped.get(category);
    if (viewer && ids?.length) {
      try {
        viewer.isolate(ids);
        viewer.fitToView(ids);
      } catch {
        /* 뷰어 API 차이 무시 */
      }
    }
  };

  const addToBilling = async (c: ApsCategoryQty) => {
    try {
      await createBillingItem(projectId, { category: c.category, contract_amount: 0, prev_amount: 0, current_amount: 0 }, billingCount);
      setBillingCount((n) => n + 1);
      setMsg(`'${c.category}' 공종을 기성내역에 추가했습니다. (금액은 원가·기성에서 입력)`);
    } catch (e) {
      setMsg(`기성 추가 실패: ${errMessage(e)}`);
    }
  };

  return (
    <div className="aps-qto-panel">
      <div className="aps-qto-head">
        <strong>물량 산출 (QTO) · 5D</strong>
        <button onClick={onClose} title="닫기">✕</button>
      </div>

      <div className="aps-qto-controls">
        <label>
          공종
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="all">전체 카테고리 ({elements.length})</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c} ({grouped.get(c)?.length ?? 0})</option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={onCompute} disabled={computing || !elements.length}>
          {computing ? '산출 중…' : '물량 산출'}
        </button>
      </div>

      {!elements.length && <p className="muted" style={{ fontSize: 12 }}>모델 요소를 열거하는 중입니다…</p>}

      {result && (
        <div className="aps-qto-table-wrap">
          <table className="cde-table aps-qto-table">
            <thead>
              <tr>
                <th>공종</th>
                <th className="col-num">개수</th>
                <th className="col-num">체적(m³)</th>
                <th className="col-num">면적(m²)</th>
                <th className="col-num">길이(m)</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {result.categories.map((c) => (
                <tr key={c.category}>
                  <td><button className="cde-link" onClick={() => focusCategory(c.category)} title="이 공종을 3D 에서 격리·확대">{c.category}</button></td>
                  <td className="col-num tabular">{c.count.toLocaleString('ko-KR')}</td>
                  <td className="col-num tabular">{n2(c.volume)}</td>
                  <td className="col-num tabular">{n2(c.area)}</td>
                  <td className="col-num tabular">{n2(c.length)}</td>
                  {canEdit && <td className="right"><button onClick={() => addToBilling(c)} title="기성내역에 이 공종 추가">→ 기성</button></td>}
                </tr>
              ))}
              <tr className="evm-total-row">
                <td><strong>합계</strong></td>
                <td className="col-num tabular"><strong>{result.total.count.toLocaleString('ko-KR')}</strong></td>
                <td className="col-num tabular"><strong>{n2(result.total.volume)}</strong></td>
                <td className="col-num tabular"><strong>{n2(result.total.area)}</strong></td>
                <td className="col-num tabular"><strong>{n2(result.total.length)}</strong></td>
                {canEdit && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {msg && <p className="muted aps-qto-msg">{msg}</p>}
      <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
        물량 소스: APS 속성(Volume/Area/Length) → 미터법 정규화 · 공종별 합산. 공종 클릭 시 3D 격리·확대.
      </p>
    </div>
  );
}
