import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { isolateAndFit } from '../lib/apsClashView';
import { groupByCategory, type ApsElement } from '../lib/apsElements';
import {
  computeApsQuantities,
  normalizeApsQuantities,
  type ApsRawQty,
} from '../lib/apsQuantities';
import {
  downloadCsv,
  fmtQty,
  quantitiesToCsv,
  type CategoryQty,
  type QtyUnitMode,
} from '../lib/quantities';
import { createBillingItem, listBillingItems } from '../lib/portal';

/**
 * 물량 산출(QTO) 패널 — S51. APS(ACC) 통합모델(acc_default) 위에서 공종별 물량을
 * 산출한다. 옛 web-ifc 경로(Quantities.tsx)의 UI/연계(공종별 물량표·요약·진행바·
 * 단위 토글·CSV·기성 제안)를 그대로 유지하되, 데이터 소스만 APS 속성 DB 로 교체.
 *
 * AccModels(modeQto) 하단에 도크되며, 모델 로드 후 열거된 요소(dbId·이름·카테고리)와
 * 뷰어/모델을 받아 동작한다. 행 클릭 포커스는 APS isolate+fit(dbId).
 */
export function ApsQuantitiesPanel({
  viewer,
  model,
  elements,
  projectId,
  isAdmin,
}: {
  viewer: unknown;
  model: unknown;
  elements: ApsElement[];
  projectId: string;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();

  const [selCat, setSelCat] = useState<'all' | string>('all');
  const [unitMode, setUnitMode] = useState<QtyUnitMode>('auto');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [raw, setRaw] = useState<ApsRawQty[] | null>(null);
  const [status, setStatus] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [proposing, setProposing] = useState(false);

  // 카테고리(공종) 목록 — 열거된 요소에서(개수 내림차순).
  const cats = useMemo(() => {
    const g = groupByCategory(elements);
    return [...g.entries()].map(([c, ids]) => [c, ids.length] as const).sort((a, b) => b[1] - a[1]);
  }, [elements]);

  // 산출 결과: raw 를 선택 카테고리로 거른 뒤 단위 정규화+집계(질의 없이 즉시 재계산).
  const result = useMemo(() => {
    if (!raw) return null;
    const subset = selCat === 'all' ? raw : raw.filter((r) => r.category === selCat);
    return normalizeApsQuantities(subset, unitMode);
  }, [raw, selCat, unitMode]);

  const run = async () => {
    if (!model || elements.length === 0) {
      setStatus('모델 요소가 아직 준비되지 않았습니다.');
      return;
    }
    setRunning(true);
    setProgress(0);
    try {
      const r = await computeApsQuantities(model, elements, setProgress);
      setRaw(r);
      setStatus(`물량 산출 완료: 요소 ${r.length.toLocaleString('ko-KR')}개 (속성 DB 기준)`);
    } catch (e) {
      setStatus(`산출 실패: ${errMessage(e)}`);
    } finally {
      setRunning(false);
    }
  };

  // 행 클릭 → 그 공종에서 체적이 가장 큰 대표 요소로 격리+포커스(APS isolate+fit).
  const focusCategory = (cat: string) => {
    if (!result) return;
    const inCat = result.rows.filter((r) => r.category === cat);
    if (inCat.length === 0) return;
    const rep = inCat.reduce((a, b) => (b.volume > a.volume ? b : a));
    isolateAndFit(viewer as never, model as never, rep.expressID);
    setStatus(`${cat} 대표 요소(dbId ${rep.expressID})로 이동`);
  };

  const onCsv = () => {
    if (result) downloadCsv(`qto_${Date.now()}.csv`, quantitiesToCsv(result.categories, result.total));
  };

  // 기성 연계: 공종별 물량을 기성내역 행으로 제안(자동 채우기, 금액은 0원).
  const proposeBilling = async () => {
    if (!result || result.categories.length === 0) return;
    if (
      !window.confirm(
        `공종 ${result.categories.length}개를 기성내역 행으로 제안합니다.\n` +
          `(공종명에 산출 물량을 함께 기입 · 금액은 0원으로 추가 → 기성내역에서 단가/금액 입력)\n계속할까요?`,
      )
    )
      return;
    setProposing(true);
    try {
      const existing = await listBillingItems(projectId);
      let order = existing.length;
      let made = 0;
      for (const c of result.categories) {
        await createBillingItem(
          projectId,
          { category: `${c.category} · ${billingQtyLabel(c)}`, contract_amount: 0, prev_amount: 0, current_amount: 0 },
          order++,
        );
        made++;
      }
      setStatus(`기성내역에 ${made}개 공종 행 제안 완료 — 기성내역에서 단가·금액을 입력하세요.`);
    } catch (e) {
      setStatus(`기성 제안 실패: ${errMessage(e)}`);
    } finally {
      setProposing(false);
    }
  };

  const t = result?.total;

  return (
    <div className="aps-qto-dock">
      <div className="aps-qto-bar">
        <strong style={{ fontSize: 13 }}>🧮 물량 산출 (QTO) · 5D</strong>

        <label className="aps-qto-field">
          <span>공종</span>
          <select value={selCat} onChange={(e) => setSelCat(e.target.value)}>
            <option value="all">전체 공종</option>
            {cats.map(([c, n]) => (
              <option key={c} value={c}>
                {c} ({n})
              </option>
            ))}
          </select>
        </label>

        <label className="aps-qto-field">
          <span>단위</span>
          <select value={unitMode} onChange={(e) => setUnitMode(e.target.value as QtyUnitMode)}>
            <option value="auto">자동(속성 단위)</option>
            <option value="m">미터(m) 강제</option>
            <option value="mm">밀리미터(mm) 강제</option>
          </select>
        </label>

        <span className="qto-count muted">대상 {elements.length.toLocaleString('ko-KR')}개 요소</span>

        <button className="primary" onClick={() => void run()} disabled={running || elements.length === 0}>
          {running ? `산출 중… ${Math.round(progress * 100)}%` : '물량 산출'}
        </button>

        {result && (
          <>
            <span className="aps-qto-sum">
              요소 <b>{t!.count.toLocaleString('ko-KR')}</b> · 체적 <b>{qtyCell(t!.volume)}</b> m³ · 면적{' '}
              <b>{qtyCell(t!.area)}</b> m² · 길이 <b>{qtyCell(t!.length)}</b> m
            </span>
            <button onClick={onCsv} title="공종별 물량표 CSV">
              CSV
            </button>
            {isAdmin && (
              <button onClick={() => void proposeBilling()} disabled={proposing} title="공종별 물량을 기성내역 행으로 제안">
                {proposing ? '제안 중…' : '기성내역으로 제안'}
              </button>
            )}
            <button onClick={() => navigate(`/project/${projectId}/billing`)} title="기성내역 열기">
              기성내역 →
            </button>
          </>
        )}

        <span style={{ flex: 1 }} />
        {status && <span className="muted aps-qto-status">{status}</span>}
        <button onClick={() => setCollapsed((c) => !c)} title="표 접기/펼치기">
          {collapsed ? '▴ 표' : '▾ 표'}
        </button>
      </div>

      {running && (
        <div className="clash-progress">
          <div className="clash-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      {!collapsed && (
        <div className="aps-qto-table-wrap">
          {!result ? (
            <p className="muted qto-empty">
              공종·단위를 정하고 <b>물량 산출</b>을 누르세요. 물량 소스: APS 속성 DB(BaseQuantities/Qto_* ·
              Revit Volume/Area/Length)에서 Net/Gross 수량을 읽어 m³/m²/m 로 정규화합니다. 수량 속성이 없는
              요소는 개수만 집계되고 체적/면적/길이는 <b>미산출</b>로 표기됩니다. 표의 공종 행을 클릭하면
              대표 요소로 카메라가 이동합니다.
            </p>
          ) : result.categories.length === 0 ? (
            <p className="muted qto-empty">대상에 요소가 없습니다.</p>
          ) : (
            <table className="cde-table qto-table">
              <thead>
                <tr>
                  <th>공종 (카테고리)</th>
                  <th className="right">개수</th>
                  <th className="right">길이 (m)</th>
                  <th className="right">면적 (m²)</th>
                  <th className="right">체적 (m³)</th>
                  <th className="right">소스</th>
                </tr>
              </thead>
              <tbody>
                {result.categories.map((c) => (
                  <tr key={c.category} onClick={() => focusCategory(c.category)} title="클릭 → 대표 요소로 이동">
                    <td>{c.category}</td>
                    <td className="right">{c.count.toLocaleString('ko-KR')}</td>
                    <td className="right">{qtyCell(c.length)}</td>
                    <td className="right">{qtyCell(c.area)}</td>
                    <td className="right">{qtyCell(c.volume)}</td>
                    <td className="right qto-src">{sourceLabel(c)}</td>
                  </tr>
                ))}
                {t && (
                  <tr className="qto-total-row" style={{ fontWeight: 700 }}>
                    <td>합계</td>
                    <td className="right">{t.count.toLocaleString('ko-KR')}</td>
                    <td className="right">{qtyCell(t.length)}</td>
                    <td className="right">{qtyCell(t.area)}</td>
                    <td className="right">{qtyCell(t.volume)}</td>
                    <td className="right" />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** 수량 셀: 값이 있으면 숫자, 없으면(속성 없음/단위 미상) "미산출". */
function qtyCell(v: number): string {
  return v > 0 ? fmtQty(v) : '미산출';
}

/** 카테고리의 대표 물량(체적>면적>길이>개수) 라벨 — 기성 제안용. */
function billingQtyLabel(c: CategoryQty): string {
  if (c.volume > 0) return `${fmtQty(c.volume)} m³`;
  if (c.area > 0) return `${fmtQty(c.area)} m²`;
  if (c.length > 0) return `${fmtQty(c.length)} m`;
  return `${c.count}개`;
}

/** 표의 소스 칸: APS 속성에서 수량을 읽었는지(속성) vs 개수만. */
function sourceLabel(c: CategoryQty): string {
  if (c.ifcCount > 0 && c.ifcCount >= c.countOnly) return '속성';
  if (c.ifcCount > 0) return '혼합';
  return '개수';
}
