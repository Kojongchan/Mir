import { useMemo, useState } from 'react';
import { PRESETS, type Rate } from '../../../lib/p6/bridgePlan';
import {
  compareOptions, concurrency, modelSpans, PART_NAME, partDays, startOrder, type DateKind,
} from '../../../lib/sim45d/modelDates';
import { fetchModelObjects, type ModelObject } from '../../../lib/sim45d/modelObjects';
import type { PlanSettings, SetupData } from '../../../lib/sim45d/setup';

/**
 * 4단계: 원본 모델(RVT)의 공정 날짜(A5 실시·계획)와 개략 IPS 안(A/B/C, 채택안)을 개소·부위로 이어 비교한다(D36).
 * 시작일은 모델의 첫 하부 작업일에 맞춰 다시 계산 — 일괄 차이를 빼고 순서·속도·작업 기간만 본다.
 * 결과는 안 고르기·단위공기 보정·크리티컬 포인트(우선 구간)의 근거. 모델 파일은 받지 않고 ACC 변환 속성만 읽는다.
 */
const signed = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}일`);

export function ModelDateCompare({ data, plan, rates, setStatus }: { data: SetupData; plan: PlanSettings; rates: Rate[]; setStatus: (s: string) => void }) {
  const models = data.files.model ?? [];
  const [modelId, setModelId] = useState(models.find(m => /\.rvt$/i.test(m.name))?.accItemId ?? models[0]?.accItemId ?? '');
  const [kind, setKind] = useState<DateKind>('actual');
  const [objects, setObjects] = useState<{ id: string; list: ModelObject[] } | null>(null);
  const [loading, setLoading] = useState('');
  const model = models.find(m => m.accItemId === modelId);
  const site = data.site;

  const load = async () => {
    if (!model?.urn) { setStatus(`${model?.name ?? '모델'}: 변환 URN 없이 골라졌습니다 — 2단계에서 다시 고르세요.`); return; }
    setLoading('모델 속성 읽는 중…');
    try {
      setObjects({ id: model.accItemId, list: await fetchModelObjects(model.urn, n => setLoading(`ACC 가 속성을 준비 중입니다(${n})…`)) });
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setLoading('');
    }
  };

  const view = useMemo(() => {
    if (!objects || objects.id !== modelId || !site || !plan.start) return null;
    const spans = modelSpans(objects.list, kind);
    const opts = PRESETS.map(p => ({ title: p.title, levers: p.levers }));
    if (plan.adopted && !opts.some(o => o.title === plan.adopted!.title)) opts.push({ title: plan.adopted.title, levers: plan.adopted.levers });
    const r = compareOptions(spans, { site, start: plan.start, rates, criticalPoints: plan.criticalPoints }, opts);
    const best = r.options.reduce<(typeof r.options)[number] | null>((b, o) => (o.cmp.sub.finishDiff == null ? b
      : !b || Math.abs(o.cmp.sub.finishDiff) < Math.abs(b.cmp.sub.finishDiff!) ? o : b), null);
    const order = startOrder(spans, 'foundation');
    const planOrder = best ? startOrder(new Map(best.cmp.rows.filter(x => x.part === 'foundation').map(x => [x.key, x.plan])), 'foundation') : [];
    const days = best ? partDays(best.cmp.rows) : [];
    const tips: string[] = [];
    if (best && (best.cmp.order ?? 1) < 0.5 && order[0] && order[0] !== planOrder[0]) {
      tips.push(`현장은 ${order.slice(0, 3).join('·')} 부터 시작했고 ${order.slice(-3).join('·')} 가 마지막 — 엔진은 시점 쪽부터 짓는다고 봅니다. 크리티컬 포인트 '우선 구간'(예: ${order[0]}~)으로 넣으면 순서가 맞아집니다.`);
    }
    for (const d of days) {
      const gap = d.plan - d.model;
      if (d.model > 0 && Math.abs(gap) / d.model >= 0.2) {
        tips.push(`${PART_NAME[d.part]} 작업 기간: 현장 평균 ${d.model}일, 안 ${d.plan}일(${signed(gap)}) — ${d.part === 'pier' && gap < 0 ? '교각 높이(기둥)를 채웠는지, 교각 LOT 단위공기 확인' : '해당 단위공기를 현장 값으로 바꿀지 검토'}.`);
      }
    }
    return { spans, ...r, best, order, days, tips, dated: objects.list.filter(o => (kind === 'actual' ? o.actualStart : o.plannedStart)).length };
  }, [objects, modelId, kind, site, plan, rates]);

  if (!site) return null;
  if (!models.length) return <p className="muted">현장 일정과 비교하려면 2단계에서 BIM 모델(가능하면 원본 RVT)을 고르세요.</p>;

  return (
    <section className="sim-step__block">
      <h4>현장 일정과 비교 <span className="muted">(원본 모델의 공정 날짜 A5 ↔ 개략 IPS 안)</span></h4>
      <p className="muted">
        모델 객체의 A5 날짜를 개소·부위(기초·교각·코핑·교대)로 묶어 안마다 비교합니다. 시작일은 모델의 첫 하부 작업일에 맞춰 다시 계산하므로
        차이는 순서·속도·작업 기간 차이입니다. 상부는 객체에 경간 정보가 없어 전체 구간만 봅니다.
      </p>
      <div className="sim-form sim-form--inline">
        <label>모델
          <select value={modelId} onChange={e => setModelId(e.target.value)}>
            {models.map(m => <option key={m.accItemId} value={m.accItemId}>{m.name}</option>)}
          </select>
        </label>
        <fieldset className="sim-form__radio">
          <label><input type="radio" checked={kind === 'actual'} onChange={() => setKind('actual')} /> 실적(A5 실시공정)</label>
          <label><input type="radio" checked={kind === 'planned'} onChange={() => setKind('planned')} /> 계획(A5 계획공정)</label>
        </fieldset>
        <button className="btn btn--sm" disabled={!!loading || !plan.start} onClick={() => void load()}>{objects?.id === modelId ? '다시 읽기' : '모델 날짜 읽어 비교'}</button>
        {loading && <span className="muted">{loading}</span>}
        {!plan.start && <span className="muted">과업시작일을 먼저 넣으세요.</span>}
      </div>

      {view && !view.aligned && (
        <p className="sim-warn">이 모델에는 {kind === 'actual' ? '실적(A5 실시공정)' : '계획(A5 계획공정)'} 날짜가 든 하부 객체가 없습니다(날짜 있는 객체 {view.dated}개).
          IFC 로 내보내며 사용자 속성이 빠졌을 수 있습니다 — 원본 RVT 를 고르세요.</p>
      )}
      {view?.aligned && view.best && (
        <>
          <p className="muted">
            이은 개소·부위 {view.best.cmp.rows.length}개(모델에만 {view.best.cmp.modelOnly.length} · 안에만 {view.best.cmp.planOnly.length}) ·
            모델 하부 {view.best.cmp.sub.model?.start} ~ {view.best.cmp.sub.model?.finish} · 시작일 맞춤 기준 {view.aligned}
          </p>
          <div className="sim-table-wrap">
            <table className="sim-table">
              <thead><tr><th>안</th><th>하부 완료(안)</th><th>모델 대비</th><th>개소별 평균 차이(시작·종료)</th><th>작업 기간 평균 차이</th><th>순서 일치</th></tr></thead>
              <tbody>
                {view.options.map(o => (
                  <tr key={o.title} className={o === view.best ? 'is-critical' : ''}>
                    <td>{o.title}{o === view.best && <span className="sim-setup__badge">가장 가까움</span>}{plan.adopted?.title === o.title && <span className="sim-setup__badge">채택</span>}</td>
                    <td>{o.cmp.sub.plan?.finish}</td>
                    <td>{signed(o.cmp.sub.finishDiff)}</td>
                    <td>{o.cmp.mae.start}일 · {o.cmp.mae.finish}일</td>
                    <td>{o.cmp.mae.days}일 (치우침 {signed(o.cmp.bias.days)})</td>
                    <td>{o.cmp.order ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sim-table-wrap">
            <table className="sim-table">
              <thead><tr><th>부위</th><th>개소 수</th><th>현장 평균 기간</th><th>안 평균 기간</th><th>동시 진행(현장 최대·평균)</th></tr></thead>
              <tbody>
                {view.days.map(d => {
                  const c = concurrency(view.spans, d.part);
                  return <tr key={d.part}><td>{PART_NAME[d.part]}</td><td>{d.n}</td><td>{d.model}일</td><td>{d.plan}일 ({signed(d.plan - d.model)})</td><td>{c ? `${c.max} · ${c.mean}` : '—'}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">현장 기초 시공 순서: {view.order.slice(0, 10).join(' → ')}{view.order.length > 10 ? ` … ${view.order.slice(-3).join(' → ')}` : ''}</p>
          {view.tips.length > 0 && <ul className="sim-list">{view.tips.map(t => <li key={t}>{t}</li>)}</ul>}
          <details className="sim-step__details">
            <summary>개소·부위별 비교 — {view.best.title}</summary>
            <div className="sim-table-wrap sim-table-wrap--tall">
              <table className="sim-table">
                <thead><tr><th>개소</th><th>부위</th><th>모델</th><th>안</th><th>시작 차이</th><th>종료 차이</th><th>기간(모델→안)</th></tr></thead>
                <tbody>
                  {view.best.cmp.rows.map(r => (
                    <tr key={r.key}>
                      <td>{r.place}</td><td>{PART_NAME[r.part]}</td>
                      <td>{r.model.start} ~ {r.model.finish}</td><td>{r.plan.start} ~ {r.plan.finish}</td>
                      <td>{signed(r.startDiff)}</td><td>{signed(r.finishDiff)}</td><td>{r.modelDays} → {r.planDays}일</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
