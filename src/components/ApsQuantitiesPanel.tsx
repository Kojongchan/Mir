import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { isolateAndFit } from '../lib/apsClashView';
import { groupByCategory, type ApsElement } from '../lib/apsElements';
import type { ApsMapping } from '../lib/apsMapping';
import {
  computeApsQuantities,
  discoverQtyProps,
  normalizeApsQuantities,
  type ApsRawQty,
  type QtyDiagnostics,
} from '../lib/apsQuantities';
import {
  downloadCsv,
  fmtQty,
  type CategoryQty,
  type ElementQty,
  type QtyUnitMode,
} from '../lib/quantities';
import {
  BASIS_LABEL,
  BASIS_UNIT,
  QTY_BASES,
  categoryAmount,
  defaultQtyBasis,
  distributeAmount,
  effectiveQty,
  loadCostRates,
  modelQtyForBasis,
  saveCostRates,
  type CostRate,
  type QtyBasis,
} from '../lib/cost';
import {
  buildSCurve,
  summarizeAt,
  summarizeByCategory,
  totalAmount,
  type Bucket,
  type EvItem,
} from '../lib/earnedValue';
import { loadLocalApsSchedule, type StoredSchedule } from '../lib/localSchedule';
import { MiniChart } from './MiniChart';
import { formatAmount } from '../lib/dashboard';
import { createBillingItem, listBillingItems, updateBillingItem } from '../lib/portal';

/**
 * 5D 적산·기성 패널 — S54. APS(ACC) 통합모델(acc_default) 위에서:
 *   화면1 [적산] 공종별 물량(모델+수동) × 단가 = 금액·총 도급금액 (cost_rates 저장/로드).
 *   화면2 [원가·기성] 기준일의 계획/실적 기성누계·잔여 + 비용 S-curve + 공종별 기성표.
 *
 * 물량은 QTO(apsQuantities, 속성 DB)로 산출하고, 단가/산출기준/수동물량은 cost_rates
 * (0032)에 저장한다. 금액·기성은 저장하지 않고 런타임 계산(물량×단가, 일정 결합).
 * 4D 결합은 localSchedule(공정표 tasks + 작업→GlobalId 매핑)과 객체 GlobalId(apsMapping)
 * 를 조인한다 — 통합모델과 4D 모델이 GlobalId 공간을 공유할 때 동작(보통 같은 통합 NWD).
 */
export function ApsQuantitiesPanel({
  viewer,
  model,
  elements,
  mapping,
  projectId,
  canEdit,
}: {
  viewer: unknown;
  model: unknown;
  elements: ApsElement[];
  mapping: ApsMapping;
  projectId: string;
  /** 단가/산출기준/수동물량·기성 전송 편집 권한(실무자 이상, RLS 0023 is_editor 일치). */
  canEdit: boolean;
}) {
  const navigate = useNavigate();

  const [tab, setTab] = useState<'estimate' | 'progress'>('estimate');
  const [unitMode, setUnitMode] = useState<QtyUnitMode>('auto');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [raw, setRaw] = useState<ApsRawQty[] | null>(null);
  const [status, setStatus] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  // 속성 진단 — 이 모델이 실제로 노출하는 수량 속성명을 확인(미산출 원인 추적).
  const [diag, setDiag] = useState<QtyDiagnostics | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);

  // 공종별 단가/산출기준/수동물량(cost_rates). 편집은 Map 으로 즉시 반영.
  const [rates, setRates] = useState<Map<string, CostRate>>(new Map());
  const [saving, setSaving] = useState(false);

  // 5D 기성: 기준일(기본 오늘) + S-curve 버킷.
  const [baseDate, setBaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [bucket, setBucket] = useState<Bucket>('month');
  const [schedule, setSchedule] = useState<StoredSchedule | null>(null);
  const [sending, setSending] = useState(false);

  // 카테고리(공종) 목록 — 열거된 요소에서(개수 내림차순).
  const cats = useMemo(() => {
    const g = groupByCategory(elements);
    return [...g.entries()].map(([c, ids]) => [c, ids.length] as const).sort((a, b) => b[1] - a[1]);
  }, [elements]);

  // 저장된 단가/공정표를 마운트 시 로드.
  useEffect(() => {
    loadCostRates(projectId)
      .then((rows) => setRates(new Map(rows.map((r) => [r.category, r]))))
      .catch(() => {});
    setSchedule(loadLocalApsSchedule(projectId));
  }, [projectId]);

  const getRate = (cat: string): CostRate =>
    rates.get(cat) ?? { category: cat, qty_basis: defaultQtyBasis(cat), unit_price: 0, manual_qty: null, note: null };

  const patchRate = (cat: string, patch: Partial<CostRate>) =>
    setRates((prev) => {
      const next = new Map(prev);
      const cur = next.get(cat) ?? {
        category: cat,
        qty_basis: defaultQtyBasis(cat),
        unit_price: 0,
        manual_qty: null,
        note: null,
      };
      next.set(cat, { ...cur, ...patch });
      return next;
    });

  // QTO 결과(전체 공종, selCat 필터 없음) — 적산표·기성 모두 사용.
  const qto = useMemo(() => (raw ? normalizeApsQuantities(raw, unitMode) : null), [raw, unitMode]);
  const catQtyMap = useMemo(() => {
    const m = new Map<string, CategoryQty>();
    if (qto) for (const c of qto.categories) m.set(c.category, c);
    return m;
  }, [qto]);
  const rowsByCat = useMemo(() => {
    const m = new Map<string, ElementQty[]>();
    if (qto)
      for (const r of qto.rows) {
        let list = m.get(r.category);
        if (!list) {
          list = [];
          m.set(r.category, list);
        }
        list.push(r);
      }
    return m;
  }, [qto]);

  // 적산표 행(전체 공종) + 총 도급금액.
  const estimateRows = useMemo(
    () =>
      cats.map(([cat, count]) => {
        const rate = getRate(cat);
        const catQty = catQtyMap.get(cat);
        const modelQty = modelQtyForBasis(catQty, rate.qty_basis);
        const eff = effectiveQty(rate, catQty);
        const amount = categoryAmount(eff.qty, rate.unit_price);
        return { cat, count, rate, modelQty, eff, amount };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cats, rates, catQtyMap],
  );
  const grandTotal = useMemo(() => estimateRows.reduce((s, r) => s + r.amount, 0), [estimateRows]);

  // 기준일(선택일 끝 시각) ms.
  const baseMs = useMemo(() => {
    const t = new Date(`${baseDate}T23:59:59`).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }, [baseDate]);

  // ---- 4D 기성 결합: 객체별 (금액, 계획/실적 일정) → EvItem[] ----
  const evItems = useMemo<EvItem[]>(() => {
    if (!qto || !schedule || !schedule.globalMapping) return [];
    // GlobalId → 일정(계획/실적). 한 객체가 여러 작업에 걸리면 합집합 기간.
    const taskById = new Map(schedule.tasks.map((t) => [t.id, t]));
    const gidDates = new Map<
      string,
      { planStart: number; planEnd: number; actualStart: number | null; actualEnd: number | null }
    >();
    const minN = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
    const maxN = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
    for (const [taskId, gids] of Object.entries(schedule.globalMapping)) {
      const t = taskById.get(taskId);
      if (!t || t.isSummary) continue;
      for (const gid of gids) {
        const cur = gidDates.get(gid);
        gidDates.set(gid, {
          planStart: cur ? Math.min(cur.planStart, t.start) : t.start,
          planEnd: cur ? Math.max(cur.planEnd, t.end) : t.end,
          actualStart: minN(cur?.actualStart ?? null, t.actualStart),
          actualEnd: maxN(cur?.actualEnd ?? null, t.actualEnd),
        });
      }
    }

    const items: EvItem[] = [];
    for (const [cat, rows] of rowsByCat) {
      const rate = getRate(cat);
      const eff = effectiveQty(rate, catQtyMap.get(cat));
      const amount = categoryAmount(eff.qty, rate.unit_price);
      if (amount <= 0) continue;
      const dist = distributeAmount(rows, rate.qty_basis, amount);
      for (const row of rows) {
        const objAmount = dist.get(row.expressID) ?? 0;
        if (objAmount <= 0) continue;
        const gid = mapping.dbIdToGlobalId.get(row.expressID) ?? null;
        const dates = gid ? gidDates.get(gid) : undefined;
        items.push({
          key: gid ?? `db:${row.expressID}`,
          category: cat,
          amount: objAmount,
          planStart: dates?.planStart ?? NaN,
          planEnd: dates?.planEnd ?? NaN,
          actualStart: dates?.actualStart ?? null,
          actualEnd: dates?.actualEnd ?? null,
        });
      }
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qto, schedule, rates, rowsByCat, catQtyMap, mapping]);

  const summary = useMemo(() => summarizeAt(evItems, baseMs), [evItems, baseMs]);
  const scurve = useMemo(() => buildSCurve(evItems, bucket), [evItems, bucket]);
  const catRows = useMemo(() => summarizeByCategory(evItems, baseMs), [evItems, baseMs]);
  // 일정에 연결되지 않아 기성에 잡히지 않는 금액(안내용).
  const unscheduled = useMemo(
    () => totalAmount(evItems.filter((it) => !Number.isFinite(it.planStart))),
    [evItems],
  );

  const run = async () => {
    if (!model || elements.length === 0) {
      setStatus('모델 요소가 아직 준비되지 않았습니다.');
      return;
    }
    setRunning(true);
    setProgress(0);
    try {
      const { raw: r, diag: d } = await computeApsQuantities(model, elements, setProgress);
      setRaw(r);
      setDiag(d);
      const recog = d.volumeNames.length + d.areaNames.length + d.lengthNames.length;
      const head = (arr: string[]) => (arr.length ? arr.slice(0, 2).join('·') : '—');
      setStatus(
        recog > 0
          ? `완료 — 인식 수량속성: 체적[${head(d.volumeNames)}] 면적[${head(d.areaNames)}] 길이[${head(d.lengthNames)}]`
          : `수량 속성을 인식하지 못했습니다(요소 ${r.length.toLocaleString('ko-KR')}개). "속성 진단"으로 이 모델의 속성명을 확인하세요.`,
      );
    } catch (e) {
      setStatus(`산출 실패: ${errMessage(e)}`);
    } finally {
      setRunning(false);
    }
  };

  // 속성 진단 — 물량 산출 없이도 샘플 요소의 수량 속성명을 발견해 보여준다.
  const runDiag = async () => {
    if (!model || elements.length === 0) {
      setStatus('모델 요소가 아직 준비되지 않았습니다.');
      return;
    }
    setDiagRunning(true);
    try {
      const d = await discoverQtyProps(model, elements);
      setDiag(d);
      setShowDiag(true);
      setStatus(`속성 진단: 수치형 속성 ${d.samples.length}종 발견(샘플 ${d.sampled}개 요소).`);
    } catch (e) {
      setStatus(`진단 실패: ${errMessage(e)}`);
    } finally {
      setDiagRunning(false);
    }
  };

  // 행 클릭 → 그 공종에서 체적이 가장 큰 대표 요소로 격리+포커스(APS isolate+fit).
  const focusCategory = (cat: string) => {
    const rows = rowsByCat.get(cat);
    if (!rows || rows.length === 0) return;
    const rep = rows.reduce((a, b) => (b.volume > a.volume ? b : a));
    isolateAndFit(viewer as never, model as never, rep.expressID);
    setStatus(`${cat} 대표 요소(dbId ${rep.expressID})로 이동`);
  };

  const saveRates = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      // 표시 중인 모든 공종을 저장(편집 안 한 공종도 기본 산출기준으로 기록).
      const all: CostRate[] = cats.map(([cat]) => getRate(cat));
      await saveCostRates(projectId, all);
      setStatus(`단가/산출기준 저장 완료(공종 ${all.length}개).`);
    } catch (e) {
      setStatus(`저장 실패: ${errMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const onCostCsv = () => {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ['공종,산출기준,적용물량,단위,출처,단가(원/단위),금액(원)'];
    for (const r of estimateRows) {
      lines.push(
        [
          esc(r.cat),
          BASIS_LABEL[r.rate.qty_basis],
          r.eff.qty || 0,
          BASIS_UNIT[r.rate.qty_basis],
          srcLabel(r.eff.source),
          r.rate.unit_price || 0,
          Math.round(r.amount),
        ].join(','),
      );
    }
    lines.push(['합계', '', '', '', '', '', Math.round(grandTotal)].join(','));
    downloadCsv(`cost_${Date.now()}.csv`, lines.join('\n'));
  };

  // 기성내역(0011)으로 보내기 — 공종별 도급액/실적기성을 행으로 생성·갱신(이름 일치 시 갱신).
  const sendToBilling = async () => {
    if (catRows.length === 0) return;
    if (
      !window.confirm(
        `공종 ${catRows.length}개를 기성내역으로 보냅니다.\n` +
          `(도급액=금액 · 당월기성=기준일 실적기성 · 같은 공종명은 갱신)\n계속할까요?`,
      )
    )
      return;
    setSending(true);
    try {
      const existing = await listBillingItems(projectId);
      const byCat = new Map(existing.map((b) => [b.category, b]));
      let order = existing.length;
      let made = 0;
      for (const r of catRows) {
        const payload = {
          category: r.category,
          contract_amount: Math.round(r.amount),
          prev_amount: 0,
          current_amount: Math.round(r.actual),
        };
        const hit = byCat.get(r.category);
        if (hit) await updateBillingItem(hit.id, payload);
        else await createBillingItem(projectId, payload, order++);
        made++;
      }
      setStatus(`기성내역에 ${made}개 공종 반영 완료.`);
    } catch (e) {
      setStatus(`기성내역 전송 실패: ${errMessage(e)}`);
    } finally {
      setSending(false);
    }
  };

  const hasSchedule = !!schedule && !!schedule.globalMapping && Object.keys(schedule.globalMapping).length > 0;

  return (
    <div className="aps-qto-dock">
      <div className="aps-qto-bar">
        <div className="aps-cost-tabs">
          <button className={tab === 'estimate' ? 'is-active' : ''} onClick={() => setTab('estimate')}>
            🧮 적산 (물량·단가)
          </button>
          <button className={tab === 'progress' ? 'is-active' : ''} onClick={() => setTab('progress')}>
            📈 원가·기성 (5D)
          </button>
        </div>

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
          {running ? `산출 중… ${Math.round(progress * 100)}%` : raw ? '물량 재산출' : '물량 산출'}
        </button>

        {tab === 'estimate' && (
          <>
            <span className="aps-qto-sum">
              총 도급금액 <b>{grandTotal > 0 ? `${formatAmount(grandTotal)}원` : '—'}</b>
            </span>
            {canEdit && (
              <button onClick={() => void saveRates()} disabled={saving} title="공종별 산출기준·단가·수동물량 저장">
                {saving ? '저장 중…' : '💾 단가 저장'}
              </button>
            )}
            <button onClick={onCostCsv} title="공종·물량·단가·금액 CSV">
              CSV
            </button>
            <button onClick={() => void runDiag()} disabled={diagRunning} title="이 모델이 노출하는 수량 속성명을 확인(미산출 원인 추적)">
              {diagRunning ? '진단 중…' : '🔍 속성 진단'}
            </button>
          </>
        )}

        {tab === 'progress' && (
          <>
            <label className="aps-qto-field">
              <span>기준일</span>
              <input type="date" value={baseDate} onChange={(e) => setBaseDate(e.target.value)} />
            </label>
            <label className="aps-qto-field">
              <span>구간</span>
              <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)}>
                <option value="month">월</option>
                <option value="week">주</option>
              </select>
            </label>
            {canEdit && evItems.length > 0 && (
              <button onClick={() => void sendToBilling()} disabled={sending} title="공종별 도급액·실적기성을 기성내역으로">
                {sending ? '전송 중…' : '기성내역으로 보내기'}
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

      {!collapsed && tab === 'estimate' && showDiag && (
        <div className="aps-qto-table-wrap">
          <div className="aps-diag-head">
            <strong>🔍 속성 진단 — 이 모델의 수치형 속성 {diag?.samples.length ?? 0}종</strong>
            {diag && (
              <span className="muted">
                인식: 체적[{diag.volumeNames.join(', ') || '—'}] · 면적[{diag.areaNames.join(', ') || '—'}] · 길이[
                {diag.lengthNames.join(', ') || '—'}]
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowDiag(false)}>✕ 닫기</button>
          </div>
          {!diag || diag.samples.length === 0 ? (
            <p className="muted qto-empty">
              샘플 요소에서 수치형 속성을 찾지 못했습니다. 이 NWD 객체들이 속성 DB에 수량을 안 담고 있을 수 있습니다
              (DWG 유래 토공/솔리드). 구조물(Revit) 객체가 포함된 영역에서 다시 시도해 보세요.
            </p>
          ) : (
            <table className="cde-table qto-table">
              <thead>
                <tr>
                  <th>속성명</th>
                  <th>인식 축</th>
                  <th className="right">예시 값</th>
                  <th>단위</th>
                  <th className="right">샘플 수</th>
                </tr>
              </thead>
              <tbody>
                {diag.samples.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.axis === 'volume' ? '체적' : s.axis === 'area' ? '면적' : s.axis === 'length' ? '길이' : '—'}</td>
                    <td className="right">{s.value}</td>
                    <td>{s.units || '—'}</td>
                    <td className="right">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!collapsed && tab === 'estimate' && !showDiag && (
        <div className="aps-qto-table-wrap">
          {cats.length === 0 ? (
            <p className="muted qto-empty">모델 요소가 아직 준비되지 않았습니다.</p>
          ) : (
            <table className="cde-table qto-table">
              <thead>
                <tr>
                  <th>공종 (카테고리)</th>
                  <th className="right">개수</th>
                  <th>산출기준</th>
                  <th className="right">모델 물량</th>
                  <th className="right">적용 물량</th>
                  <th className="right">출처</th>
                  <th className="right">단가 (₩/단위)</th>
                  <th className="right">금액 (₩)</th>
                </tr>
              </thead>
              <tbody>
                {estimateRows.map((r) => (
                  <tr key={r.cat}>
                    <td className="qto-cat" onClick={() => focusCategory(r.cat)} title="클릭 → 대표 요소로 이동">
                      {r.cat}
                    </td>
                    <td className="right">{r.count.toLocaleString('ko-KR')}</td>
                    <td>
                      <select
                        className="aps-cost-basis"
                        value={r.rate.qty_basis}
                        onChange={(e) => patchRate(r.cat, { qty_basis: e.target.value as QtyBasis })}
                        disabled={!canEdit}
                      >
                        {QTY_BASES.map((b) => (
                          <option key={b} value={b}>
                            {BASIS_LABEL[b]} ({BASIS_UNIT[b]})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="right" title={raw ? '' : '물량 산출 필요'}>
                      {!raw ? '—' : r.modelQty > 0 ? fmtQty(r.modelQty) : '미산출'}
                    </td>
                    <td className="right">
                      <input
                        className="aps-cost-input"
                        type="number"
                        min={0}
                        value={r.rate.manual_qty != null ? r.rate.manual_qty : ''}
                        placeholder={r.modelQty > 0 ? fmtQty(r.modelQty) : '수동'}
                        onChange={(e) =>
                          patchRate(r.cat, { manual_qty: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        disabled={!canEdit}
                        title="비우면 모델 물량 사용, 입력하면 수동 물량 우선"
                      />
                    </td>
                    <td className="right">
                      <span className={`aps-src-badge src-${r.eff.source}`}>{srcLabel(r.eff.source)}</span>
                    </td>
                    <td className="right">
                      <input
                        className="aps-cost-input"
                        type="number"
                        min={0}
                        value={r.rate.unit_price || ''}
                        placeholder="0"
                        onChange={(e) => patchRate(r.cat, { unit_price: e.target.value === '' ? 0 : Number(e.target.value) })}
                        disabled={!canEdit}
                      />
                    </td>
                    <td className="right" title={r.amount ? `${Math.round(r.amount).toLocaleString('ko-KR')}원` : ''}>
                      {r.amount > 0 ? formatAmount(r.amount) : '—'}
                    </td>
                  </tr>
                ))}
                <tr className="qto-total-row" style={{ fontWeight: 700 }}>
                  <td>합계</td>
                  <td className="right">{cats.reduce((s, [, n]) => s + n, 0).toLocaleString('ko-KR')}</td>
                  <td colSpan={4} />
                  <td className="right">총 도급금액</td>
                  <td className="right" title={`${Math.round(grandTotal).toLocaleString('ko-KR')}원`}>
                    {grandTotal > 0 ? `${formatAmount(grandTotal)}원` : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {!raw && (
            <p className="muted qto-empty">
              <b>물량 산출</b>을 누르면 APS 속성 DB(BaseQuantities·Revit Volume/Area/Length)에서 공종별 모델 물량을
              읽어옵니다. 토공처럼 모델 물량이 없는 공종은 <b>적용 물량</b>에 수동으로 입력하세요. 산출기준·단가·수동
              물량은 <b>💾 단가 저장</b>으로 프로젝트에 저장됩니다.
            </p>
          )}
        </div>
      )}

      {!collapsed && tab === 'progress' && (
        <div className="aps-qto-table-wrap aps-cost-progress">
          {!raw ? (
            <p className="muted qto-empty">먼저 <b>물량 산출</b>을 실행하고 [적산] 탭에서 단가를 입력하세요.</p>
          ) : !hasSchedule ? (
            <p className="muted qto-empty">
              공정표(4D)가 없습니다. <b>공정관리(4D)</b>에서 공정표를 가져오고 객체 매핑을 하면 그 일정(계획/실적)으로
              기성이 계산됩니다.
            </p>
          ) : evItems.length === 0 ? (
            <p className="muted qto-empty">[적산] 탭에서 공종 단가를 입력하면 기성이 계산됩니다(현재 금액 0).</p>
          ) : (
            <>
              <div className="aps-cost-cards">
                <div className="aps-cost-card">
                  <span className="lbl">계획 기성누계 (기준일)</span>
                  <span className="val" style={{ color: 'var(--accent)' }}>{formatAmount(summary.planned)}원</span>
                  <span className="sub muted">{pct(summary.planned, summary.total)}% / 총 {formatAmount(summary.total)}원</span>
                </div>
                <div className="aps-cost-card">
                  <span className="lbl">실적 기성누계 (기준일)</span>
                  <span className="val" style={{ color: 'var(--redline-green)' }}>{formatAmount(summary.actual)}원</span>
                  <span className="sub muted">{pct(summary.actual, summary.total)}% / 총 {formatAmount(summary.total)}원</span>
                </div>
                <div className="aps-cost-card">
                  <span className="lbl">잔여 (총액 − 실적)</span>
                  <span className="val">{formatAmount(summary.remaining)}원</span>
                  <span className="sub muted">{unscheduled > 0 ? `미연결 ${formatAmount(unscheduled)}원 포함` : ' '}</span>
                </div>
              </div>

              <div className="aps-cost-chart">
                <div className="aps-cost-legend">
                  <span><i style={{ background: 'var(--accent)' }} /> 계획</span>
                  <span><i style={{ background: 'var(--redline-green)' }} /> 실적</span>
                  {scurve.length > 0 && (
                    <span className="muted">{scurve[0].label} ~ {scurve[scurve.length - 1].label}</span>
                  )}
                </div>
                <MiniChart
                  height={150}
                  series={[
                    { values: scurve.map((p) => p.planned), color: 'var(--accent)', fill: true },
                    { values: scurve.map((p) => p.actual), color: 'var(--redline-green)' },
                  ]}
                  labels={scurve.length ? [scurve[0].label, scurve[scurve.length - 1].label] : undefined}
                />
              </div>

              <table className="cde-table qto-table">
                <thead>
                  <tr>
                    <th>공종 (카테고리)</th>
                    <th className="right">도급액 (₩)</th>
                    <th className="right">계획기성</th>
                    <th className="right">실적기성</th>
                    <th className="right">진행률</th>
                    <th className="right">잔여</th>
                  </tr>
                </thead>
                <tbody>
                  {catRows.map((r) => (
                    <tr key={r.category} onClick={() => focusCategory(r.category)} title="클릭 → 대표 요소로 이동">
                      <td>{r.category}</td>
                      <td className="right" title={`${Math.round(r.amount).toLocaleString('ko-KR')}원`}>{formatAmount(r.amount)}</td>
                      <td className="right">{formatAmount(r.planned)}</td>
                      <td className="right">{formatAmount(r.actual)}</td>
                      <td className="right">{Math.round(r.progress * 100)}%</td>
                      <td className="right">{formatAmount(r.remaining)}</td>
                    </tr>
                  ))}
                  <tr className="qto-total-row" style={{ fontWeight: 700 }}>
                    <td>합계</td>
                    <td className="right">{formatAmount(summary.total)}</td>
                    <td className="right">{formatAmount(summary.planned)}</td>
                    <td className="right">{formatAmount(summary.actual)}</td>
                    <td className="right">{pct(summary.actual, summary.total)}%</td>
                    <td className="right">{formatAmount(summary.remaining)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 물량 출처 라벨(수동 입력 / 모델 산출 / 없음). */
function srcLabel(source: 'manual' | 'model' | 'none'): string {
  return source === 'manual' ? '수동' : source === 'model' ? '모델' : '—';
}

/** 백분율(분모 0 보호). */
function pct(v: number, total: number): number {
  return total > 0 ? Math.round((v / total) * 100) : 0;
}
