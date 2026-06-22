import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { IfcViewer, type ElementMeta, type UpAxis } from '../viewer/IfcViewer';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { useStore } from '../store/useStore';
import { downloadModelBytes, listModels, type ModelRecord } from '../lib/api';
import { createBillingItem, listBillingItems } from '../lib/portal';
import {
  computeQuantities,
  downloadCsv,
  fmtQty,
  quantitiesToCsv,
  type CategoryQty,
  type QtyResult,
  type QtyUnitMode,
} from '../lib/quantities';

/**
 * 5D 물량 산출(QTO) — BIM 요소 물량을 공종/카테고리별로 집계하고 기성내역과
 * 연계한다(설계 §12). 모델 풀은 다른 3D 모듈과 공유(자동 로드). 대상 집합은
 * 간섭체크와 동일한 (모델→카테고리) 2단계로 선택. 물량 소스: IFC 수량셋 →
 * 메시 근사 → 개수. 단위는 IFC 에서 자동 감지(실패 시 m/mm 수동 토글).
 */
export function Quantities() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const { setSelected } = useStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);

  const [models, setModels] = useState<ModelRecord[]>([]);
  const [meta, setMeta] = useState<ElementMeta[]>([]);
  const loadedAllRef = useRef(false);

  // 대상 집합(모델 → 카테고리) + 단위 + 결과.
  const [selModel, setSelModel] = useState<'all' | number>('all');
  const [selCat, setSelCat] = useState('all');
  const [unitMode, setUnitMode] = useState<QtyUnitMode>('auto');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<QtyResult | null>(null);
  const [status, setStatus] = useState('');

  // --- 뷰어 생성 + 모델 자동 로드 -------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    (window as unknown as { __mirUpAxis?: (a: UpAxis) => void }).__mirUpAxis = (a) => v.setUpAxis(a);
    setViewer(v);
    return () => v.dispose();
  }, [setSelected]);

  useEffect(() => {
    listModels(projectId).then(setModels).catch(() => setModels([]));
  }, [projectId]);

  useEffect(() => {
    if (!viewer || models.length === 0 || loadedAllRef.current) return;
    loadedAllRef.current = true;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, models]);

  const loadAll = async () => {
    if (!viewer) return;
    let ok = 0;
    for (const m of models) {
      setStatus(`불러오는 중: ${m.name} (${ok + 1}/${models.length})`);
      try {
        const bytes = await downloadModelBytes(m.storage_path);
        const saved = loadUpAxisPref(m.id);
        await viewer.loadIfc(bytes, { label: m.name, ...(saved ? { upAxis: saved } : {}) });
        ok++;
      } catch (e) {
        setStatus(`불러오기 실패: ${m.name} — ${errMessage(e)}`);
      }
    }
    setMeta(viewer.getElementMeta());
    setStatus(ok ? `불러옴: 모델 ${ok}개 · 요소 ${viewer.getElementMeta().length}개. 대상을 정하고 물량 산출.` : '표시할 모델이 없습니다. 통합모델(3D)에서 IFC를 업로드하세요.');
  };

  // --- 대상 선택기(모델 → 카테고리) ----------------------------------
  const loadedModels = useMemo(() => viewer?.getLoadedModels() ?? [], [viewer, meta]);
  const categoriesFor = (model: 'all' | number) => {
    const cats = new Map<string, number>();
    for (const e of meta) {
      if (model !== 'all' && e.modelID !== model) continue;
      cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
    }
    return [...cats.entries()].sort((a, b) => b[1] - a[1]);
  };
  const cats = useMemo(() => categoriesFor(selModel), [meta, selModel]);
  const items = useMemo(
    () =>
      meta.filter(
        (e) => (selModel === 'all' || e.modelID === selModel) && (selCat === 'all' || e.category === selCat),
      ),
    [meta, selModel, selCat],
  );

  const run = async () => {
    if (!viewer || items.length === 0) {
      setStatus('대상 요소가 없습니다. 모델을 불러오고 대상을 선택하세요.');
      return;
    }
    setRunning(true);
    setProgress(0);
    setResult(null);
    try {
      const res = await computeQuantities(viewer, items, unitMode, setProgress);
      setResult(res);
      const undetected = res.modelScale.filter((m) => unitMode === 'auto' && !m.detected);
      setStatus(
        `물량 산출 완료: ${res.total.count}개 요소 · ${res.categories.length}개 공종` +
          (undetected.length > 0 ? ` ⚠ 단위 자동감지 실패 ${undetected.length}개 모델 — m/mm 수동 토글 권장` : ''),
      );
    } catch (e) {
      setStatus(`산출 실패: ${errMessage(e)}`);
    } finally {
      setRunning(false);
    }
  };

  // 카테고리 행 클릭 → 그 공종에서 체적이 가장 큰 대표 요소로 포커스.
  const focusCategory = (cat: string) => {
    if (!viewer || !result) return;
    const inCat = result.rows.filter((r) => r.category === cat);
    if (inCat.length === 0) return;
    const rep = inCat.reduce((a, b) => (b.volume > a.volume ? b : a));
    const ok = viewer.focusElement(rep.modelID, rep.expressID);
    setStatus(ok ? `${cat} 대표 요소 #${rep.expressID} 로 이동` : '대표 요소를 찾지 못했습니다(모델 변경).');
  };

  const onCsv = () => {
    if (result) downloadCsv(`qto_${Date.now()}.csv`, quantitiesToCsv(result.categories, result.total));
  };

  // --- 기성 연계: 공종별 물량을 기성내역 행으로 제안(자동 채우기) -------
  const [proposing, setProposing] = useState(false);
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
        const label = `${c.category} · ${billingQtyLabel(c)}`;
        await createBillingItem(
          projectId,
          { category: label, contract_amount: 0, prev_amount: 0, current_amount: 0 },
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
    <div className="mod-fill viewer-fill">
      <aside className="mod-subtree qto-side">
        <div className="sidebar-head">
          <h2>물량 산출 (QTO)</h2>
        </div>

        <div className="qto-controls">
          <label className="clash-field">
            <span>모델</span>
            <select
              value={selModel === 'all' ? 'all' : String(selModel)}
              onChange={(e) => {
                setSelModel(e.target.value === 'all' ? 'all' : Number(e.target.value));
                setSelCat('all');
              }}
            >
              <option value="all">전체 모델</option>
              {loadedModels.map((m) => (
                <option key={m.modelID} value={m.modelID}>
                  {m.label} ({m.count})
                </option>
              ))}
            </select>
          </label>
          <label className="clash-field">
            <span>카테고리(공종)</span>
            <select value={selCat} onChange={(e) => setSelCat(e.target.value)}>
              <option value="all">전체 카테고리</option>
              {cats.map(([c, n]) => (
                <option key={c} value={c}>
                  {c} ({n})
                </option>
              ))}
            </select>
          </label>
          <div className="qto-count muted">대상 {items.length}개 요소</div>

          <label className="clash-field">
            <span>단위(길이)</span>
            <select value={unitMode} onChange={(e) => setUnitMode(e.target.value as QtyUnitMode)}>
              <option value="auto">자동 감지 (IFC 단위)</option>
              <option value="m">미터(m) 강제</option>
              <option value="mm">밀리미터(mm) 강제</option>
            </select>
          </label>

          <button className="primary qto-run" onClick={run} disabled={running || !viewer}>
            {running ? `산출 중… ${Math.round(progress * 100)}%` : '물량 산출'}
          </button>
          {running && (
            <div className="clash-progress">
              <div className="clash-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>

        {result && (
          <div className="qto-summary">
            <div className="qto-sum-row">
              <span className="muted">요소</span>
              <b>{result.total.count.toLocaleString('ko-KR')}</b>
            </div>
            <div className="qto-sum-row">
              <span className="muted">체적</span>
              <b>{fmtQty(result.total.volume)} m³</b>
            </div>
            <div className="qto-sum-row">
              <span className="muted">면적</span>
              <b>{fmtQty(result.total.area)} m²</b>
            </div>
            <div className="qto-sum-row">
              <span className="muted">길이</span>
              <b>{fmtQty(result.total.length)} m</b>
            </div>
            <div className="qto-source muted">
              IFC수량 {result.total.ifcCount} · 메시근사 {result.total.meshCount} · 개수만 {result.total.countOnly}
            </div>
            <div className="qto-actions">
              <button onClick={onCsv} title="카테고리별 물량표 CSV">CSV 내보내기</button>
              {isAdmin && (
                <button onClick={proposeBilling} disabled={proposing} title="공종별 물량을 기성내역 행으로 제안">
                  {proposing ? '제안 중…' : '기성내역으로 제안'}
                </button>
              )}
              <button onClick={() => navigate(`/project/${projectId}/billing`)} title="기성내역 열기">
                기성내역 →
              </button>
            </div>
          </div>
        )}

        {result && result.modelScale.length > 0 && (
          <div className="qto-scales">
            <div className="muted qto-scales-h">적용 단위(미터 환산)</div>
            {result.modelScale.map((m) => (
              <div key={m.modelID} className="qto-scale-row muted" title={m.label}>
                <span className="qto-scale-name">{m.label}</span>
                <span>
                  ×{m.scale} {m.detected ? '(자동)' : '(수동/기본)'}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="mod-main viewer-main">
        <div className="viewer-bar">
          <span className="viewer-mode-title">물량 산출 (QTO) · 5D</span>
          <div className="spacer" />
          <span className="muted">{status}</span>
          <span className="muted">· 모델 {viewer?.modelCount ?? 0}개</span>
        </div>
        <div className="viewport-wrap qto-viewport">
          <div className="viewport" ref={containerRef} />
        </div>

        <div className="qto-table-panel">
          {!result ? (
            <p className="muted qto-empty">
              대상(모델→카테고리)과 단위를 정하고 <b>물량 산출</b>을 누르세요. 물량 소스 우선순위:
              ① IFC 수량셋(IfcElementQuantity) → ② 메시 근사(체적·면적·bbox) → ③ 개수.
              표의 공종 행을 클릭하면 대표 요소로 카메라가 이동합니다.
            </p>
          ) : result.categories.length === 0 ? (
            <p className="muted qto-empty">대상에 요소가 없습니다.</p>
          ) : (
            <div className="cde-table-wrap" style={{ padding: 0 }}>
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
                      <td className="right">{fmtQty(c.length)}</td>
                      <td className="right">{fmtQty(c.area)}</td>
                      <td className="right">{fmtQty(c.volume)}</td>
                      <td className="right qto-src">{sourceLabel(c)}</td>
                    </tr>
                  ))}
                  {t && (
                    <tr className="qto-total-row" style={{ fontWeight: 700 }}>
                      <td>합계</td>
                      <td className="right">{t.count.toLocaleString('ko-KR')}</td>
                      <td className="right">{fmtQty(t.length)}</td>
                      <td className="right">{fmtQty(t.area)}</td>
                      <td className="right">{fmtQty(t.volume)}</td>
                      <td className="right" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <PropertiesPanel />
      </div>
    </div>
  );
}

/** 카테고리의 대표 물량(체적>면적>길이>개수) 라벨 — 기성 제안용. */
function billingQtyLabel(c: CategoryQty): string {
  if (c.volume > 0) return `${fmtQty(c.volume)} m³`;
  if (c.area > 0) return `${fmtQty(c.area)} m²`;
  if (c.length > 0) return `${fmtQty(c.length)} m`;
  return `${c.count}개`;
}

/** 표의 소스 칸: 우세한 물량 출처를 간단 표기. */
function sourceLabel(c: CategoryQty): string {
  if (c.ifcCount >= c.meshCount && c.ifcCount >= c.countOnly && c.ifcCount > 0) return 'IFC';
  if (c.meshCount >= c.countOnly && c.meshCount > 0) return '메시';
  return '개수';
}

const UP_AXIS_KEY = (modelId: string) => `mir.upaxis.${modelId}`;
function loadUpAxisPref(modelId: string): UpAxis | null {
  const v = localStorage.getItem(UP_AXIS_KEY(modelId));
  return v === 'x' || v === 'y' || v === 'z' ? v : null;
}
