import { useMemo, useState } from 'react';
import {
  DEFAULT_RATES, PRESETS, fitToDeadline, parseSupportList, proposePlans,
  type CriticalPoint, type PlanResult, type Rate, type RateKey,
} from '../../../lib/p6/bridgePlan';
import { planRates, planXerBytes, planXerName } from '../../../lib/sim45d/confirmed';
import { accPdfPages, chunkPages } from '../../../lib/sim45d/docText';
import { emptyPlan, type PlanSettings } from '../../../lib/sim45d/setup';
import { AiBox, AiStatus, useAi, type StepProps } from './common';

/**
 * 4단계 개략 IPS: 과업시작일(필수) → 방식 1(시작일 기준 3안) 또는 방식 2(시작·종료일 안에 맞춤).
 * 크리티컬 포인트는 문장으로 적으면 AI 가 제약으로 바꾸고(사람 확인), 공기는 엔진이 단위공기 표로 계산한다.
 */
const KIND_LABEL: Record<CriticalPoint['kind'], string> = {
  night: '야간 구간', blocked: '작업 금지 기간', notBefore: '착수 가능일', priority: '우선 구간', deadline: '기한',
};

interface AiPoint { kind: CriticalPoint['kind']; supports: string; from: string; to: string; date: string; name: string; scope: string; note: string; quote: string }
interface AiRates { rates: { key: string; label: string; value: number; unit: string; page: number; quote: string }[]; notes: string[] }

function describe(p: CriticalPoint): string {
  switch (p.kind) {
    case 'night': return `${p.supports.join(', ')} 코핑·거치 야간`;
    case 'blocked': return `${p.supports.join(', ')} ${p.from}~${p.to} 작업 금지`;
    case 'notBefore': return `${p.supports.join(', ')} ${p.date} 이후 착수`;
    case 'priority': return `${p.supports.join(', ')} 먼저 시공`;
    case 'deadline': return `${p.name} ${p.date}까지(${p.scope === 'substructure' ? '하부' : p.scope === 'superstructure' ? '상부' : '전체'})`;
  }
}

const download = (bytes: Uint8Array, name: string) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

export function DraftStep({ projectId, canEdit, data, persist, sim, setStatus }: StepProps) {
  const [plan, setPlan] = useState<PlanSettings>(data.plan ?? emptyPlan());
  const [results, setResults] = useState<{ title: string; result: PlanResult }[] | null>(null);
  const [fitNote, setFitNote] = useState('');
  const [chosen, setChosen] = useState(0);
  const [aiQuestions, setAiQuestions] = useState<string[]>([]);
  const [rateHints, setRateHints] = useState<AiRates | null>(null);
  const [manual, setManual] = useState<{ kind: CriticalPoint['kind']; supports: string; from: string; to: string; date: string; name: string }>({ kind: 'night', supports: '', from: '', to: '', date: '', name: '' });
  const ai = useAi(projectId);
  const site = data.site;
  const ids = useMemo(() => site?.supports.map(s => s.id) ?? [], [site]);
  const rates: Rate[] = useMemo(() => planRates(plan), [plan]);
  const save = (next: PlanSettings) => { setPlan(next); if (canEdit) void persist({ ...data, plan: next }); };

  const toPoint = (p: AiPoint): CriticalPoint | null => {
    const sup = parseSupportList(p.supports, ids);
    switch (p.kind) {
      case 'night': case 'priority': return sup.length ? { kind: p.kind, supports: sup, note: p.quote } : null;
      case 'blocked': return sup.length && p.from && p.to ? { kind: 'blocked', supports: sup, from: p.from, to: p.to, note: p.quote } : null;
      case 'notBefore': return sup.length && p.date ? { kind: 'notBefore', supports: sup, date: p.date, note: p.quote } : null;
      case 'deadline': return p.date ? { kind: 'deadline', name: p.name || '기한', date: p.date, scope: p.scope === 'substructure' || p.scope === 'superstructure' ? p.scope : 'all', note: p.quote } : null;
    }
  };

  const interpret = async () => {
    if (ai.toClaude('criticalPoints', plan.criticalText)) return;
    const r = await ai.call<{ points: AiPoint[]; questions: string[] }>('criticalPoints', { text: plan.criticalText, start: plan.start, supports: ids }, '크리티컬 포인트 해석');
    if (!r) return;
    const pts = r.points.map(toPoint).filter((p): p is CriticalPoint => !!p);
    setAiQuestions([...r.questions, ...(r.points.length > pts.length ? [`${r.points.length - pts.length}개는 개소·날짜를 읽지 못해 빼었습니다 — 직접 추가하세요.`] : [])]);
    save({ ...plan, criticalPoints: [...plan.criticalPoints, ...pts] });
  };

  const addManual = () => {
    const p = toPoint({ ...manual, scope: 'all', note: '', quote: '직접 입력' });
    if (!p) { setStatus('개소·날짜를 확인하세요.'); return; }
    save({ ...plan, criticalPoints: [...plan.criticalPoints, p] });
    setManual({ ...manual, supports: '', from: '', to: '', date: '', name: '' });
  };

  const extractRates = async () => {
    if (ai.toClaude('ratesExtract')) return;
    const doc = data.files.plan?.[0];
    if (!doc) return;
    try {
      const { pages } = await accPdfPages(doc.accProjectId, doc.accItemId, { keep: /공기|가동율|단위공정|소요/ });
      const merged: AiRates = { rates: [], notes: [] };
      let answered = false;
      for (const chunk of chunkPages(pages, 150_000)) {
        const r = await ai.call<AiRates>('ratesExtract', { pages: chunk, keys: DEFAULT_RATES.map(x => ({ key: x.key, label: x.label, unit: x.unit })) }, `단위공기 추출(${chunk.length}쪽)`);
        if (!r) break;
        answered = true;
        merged.rates.push(...r.rates); merged.notes.push(...r.notes);
      }
      if (answered) setRateHints(merged);
    } catch (e) {
      ai.setError(`시공계획 읽기 실패: ${(e as Error).message}`);
    }
  };

  const generate = () => {
    if (!site) return;
    if (!plan.start) { setStatus('과업시작일을 넣으세요.'); return; }
    const input = { site, start: plan.start, rates, criticalPoints: plan.criticalPoints };
    try {
      let list: { title: string; result: PlanResult }[];
      if (plan.mode === 'fit') {
        if (!plan.finish) { setStatus('방식 2 는 과업종료예정일이 필요합니다.'); return; }
        const fit = fitToDeadline(input, plan.finish);
        list = fit.options.map(o => ({ title: o.title, result: o.result }));
        setFitNote(fit.feasible
          ? `종료예정일 ${plan.finish} 안에 끝나는 투입안 ${fit.options.length}개(투입이 적은 순). 작업 일수는 줄이지 않았습니다.`
          : `작업조 6개·런처 2대로도 ${fit.shortfallDays}일 부족합니다 — 단위공기·크리티컬 포인트를 다시 보거나 종료일을 조정해야 합니다.`);
      } else {
        list = proposePlans(input).map(p => ({ title: p.title, result: p.result }));
        setFitNote('');
      }
      setResults(list);
      setChosen(Math.max(0, list.findIndex(x => x.title === plan.adopted?.title)));
    } catch (e) {
      setStatus(`공정표 계산 실패: ${(e as Error).message}`);
    }
  };

  const pick = results?.[chosen]?.result;
  const pickTitle = results?.[chosen]?.title ?? '';
  const xerBytes = () => (pick ? planXerBytes(pick) : null);
  const fileName = () => planXerName(site?.code, pickTitle);
  const adopted = plan.adopted;
  const adoptedHere = !!adopted && !!pick && adopted.title === pickTitle && JSON.stringify(adopted.levers) === JSON.stringify(pick.levers);
  // 채택: 투입안만 저장 — 확정 공정표는 이 안을 지금 입력으로 다시 계산한 것(P6 수정본을 올리지 않는 한, D34).
  const adopt = () => {
    if (!pick) return;
    save({ ...plan, adopted: { title: pickTitle, levers: pick.levers, at: new Date().toISOString() } });
    setStatus(`확정: ${pickTitle} — 공기 ${pick.durationDays.toLocaleString()}일, ${pick.finish} 완료. P6 에서 고치지 않으면 이대로 검토·BIM 연결·4D 에 씁니다.`);
  };

  if (!site) return <p className="sim-step__empty">먼저 3단계 설계현황(개소 표)을 저장하세요.</p>;

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <h4>기간</h4>
        <div className="sim-form">
          <label>과업시작일 *<input type="date" value={plan.start} disabled={!canEdit} onChange={e => save({ ...plan, start: e.target.value })} /></label>
          <fieldset className="sim-form__radio" disabled={!canEdit}>
            <label><input type="radio" checked={plan.mode === 'propose'} onChange={() => save({ ...plan, mode: 'propose' })} /> 방식 1 · 시작일 기준 3안</label>
            <label><input type="radio" checked={plan.mode === 'fit'} onChange={() => save({ ...plan, mode: 'fit' })} /> 방식 2 · 종료일 안에 맞춤</label>
          </fieldset>
          {plan.mode === 'fit' && <label>과업종료예정일 *<input type="date" value={plan.finish} disabled={!canEdit} onChange={e => save({ ...plan, finish: e.target.value })} /></label>}
        </div>
        <p className="muted">방식 3(사람이 이미 짠 공정표 검토)은 이 단계를 건너뛰고 5단계 「P6 검토」에 올립니다 — 1단계 진행 방식 「이미 짠 공정표로」.</p>
      </section>

      <section className="sim-step__block">
        <h4>크리티컬 포인트</h4>
        <textarea className="sim-textarea" rows={3} value={plan.criticalText} disabled={!canEdit}
          placeholder={'예) 하선 P38~종점 코핑·거더는 운행선 근접으로 야간 작업. P20·P21 하천 구간은 매년 6/21~9/20 홍수기 작업 불가. 궤도분야 인계 2026-08-10.'}
          onChange={e => setPlan({ ...plan, criticalText: e.target.value })} onBlur={() => save(plan)} />
        <div className="sim-step__actions">
          <button className="btn btn--sm" disabled={!canEdit || !plan.criticalText.trim() || !!ai.busy} onClick={() => void interpret()}>AI 로 제약 만들기</button>
          <AiStatus busy={ai.busy} error={ai.error} />
        </div>
        {aiQuestions.length > 0 && (
          <AiBox title="확인이 필요한 점" usage={ai.usage}><ul className="sim-list">{aiQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></AiBox>
        )}
        <ul className="sim-chips">
          {plan.criticalPoints.map((p, i) => (
            <li key={i} className={`sim-chip is-${p.kind}`} title={p.note}>
              <span className="sim-chip__kind">{KIND_LABEL[p.kind]}</span> {describe(p)}
              {canEdit && <button type="button" className="sim-setup__x" aria-label="빼기" onClick={() => save({ ...plan, criticalPoints: plan.criticalPoints.filter((_, k) => k !== i) })}>✕</button>}
            </li>
          ))}
          {!plan.criticalPoints.length && <li className="muted">아직 없음</li>}
        </ul>
        {canEdit && (
          <div className="sim-form sim-form--inline">
            <select value={manual.kind} onChange={e => setManual({ ...manual, kind: e.target.value as CriticalPoint['kind'] })} aria-label="종류">
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {manual.kind === 'deadline'
              ? <input value={manual.name} placeholder="이름(예: 궤도분야 인계)" onChange={e => setManual({ ...manual, name: e.target.value })} aria-label="이름" />
              : <input value={manual.supports} placeholder="개소(예: P38~P46)" onChange={e => setManual({ ...manual, supports: e.target.value })} aria-label="개소" />}
            {manual.kind === 'blocked' && <>
              <input type="date" value={manual.from} onChange={e => setManual({ ...manual, from: e.target.value })} aria-label="시작" />
              <input type="date" value={manual.to} onChange={e => setManual({ ...manual, to: e.target.value })} aria-label="끝(미포함)" />
            </>}
            {(manual.kind === 'notBefore' || manual.kind === 'deadline') && <input type="date" value={manual.date} onChange={e => setManual({ ...manual, date: e.target.value })} aria-label="날짜" />}
            <button className="btn btn--sm" onClick={addManual}>＋ 추가</button>
          </div>
        )}
      </section>

      <section className="sim-step__block">
        <details>
          <summary><strong>단위공기 표</strong> <span className="muted">— 기본값 출처: 실시설계 시공계획 11.6.4 · '가정' 은 문서에 수치가 없음</span></summary>
          <div className="sim-table-wrap">
            <table className="sim-table">
              <thead><tr><th>항목</th><th>값</th><th>단위</th><th>출처</th></tr></thead>
              <tbody>
                {rates.map(r => (
                  <tr key={r.key} className={r.assumed ? 'is-assumed' : ''}>
                    <td>{r.label}</td>
                    <td><input type="number" min={0} step={0.1} value={r.value} disabled={!canEdit}
                      onChange={e => save({ ...plan, rates: { ...plan.rates, [r.key]: Number(e.target.value) } })} /></td>
                    <td>{r.unit}</td>
                    <td className="muted sim-table__note">{r.assumed && <span className="sim-tag">가정</span>} {r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sim-step__actions">
            <button className="btn btn--sm" disabled={!canEdit || !data.files.plan?.length || !!ai.busy} onClick={() => void extractRates()}>AI 로 근거 찾기 — 시공계획</button>
            {Object.keys(plan.rates).length > 0 && canEdit && <button className="btn btn--sm" onClick={() => save({ ...plan, rates: {} })}>기본값으로</button>}
          </div>
          {rateHints && (
            <AiBox title={`시공계획에서 찾은 수치 ${rateHints.rates.length}개`} usage={ai.usage}>
              <table className="sim-table">
                <tbody>
                  {rateHints.rates.map((h, i) => (
                    <tr key={i}>
                      <td>{h.label}</td><td>{h.value}{h.unit}</td><td className="muted sim-table__note">{h.page}쪽: {h.quote}</td>
                      <td>{h.key && DEFAULT_RATES.some(r => r.key === h.key) && canEdit && (
                        <button className="btn btn--sm" onClick={() => save({ ...plan, rates: { ...plan.rates, [h.key as RateKey]: h.value } })}>적용</button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rateHints.notes.length > 0 && <ul className="sim-list">{rateHints.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            </AiBox>
          )}
        </details>
      </section>

      <section className="sim-step__block">
        <div className="sim-step__actions">
          <button className="btn btn--sm btn--primary" disabled={!plan.start} onClick={generate}>공정표 만들기</button>
          <span className="muted">작업 {site.supports.length * 3 + site.spans.length}개 안팎 · 투입안: {PRESETS.map(p => p.title.split(' · ')[1]).join(' / ')}</span>
        </div>
        {adopted && !results && <p className="muted">확정 공정표: {adopted.title}({adopted.at.slice(0, 10)} 채택) — 「공정표 만들기」로 지금 입력 기준 일정을 다시 봅니다.</p>}
        {fitNote && <p className={results && results.length && fitNote.includes('부족') ? 'sim-error' : 'muted'}>{fitNote}</p>}
        {results && (
          <>
            <div className="sim-cards" role="radiogroup" aria-label="공정표 안">
              {results.map((r, i) => (
                <button key={i} type="button" role="radio" aria-checked={i === chosen} className={`sim-card${i === chosen ? ' is-chosen' : ''}`} onClick={() => setChosen(i)}>
                  <strong>{r.title}</strong>
                  <span className="sim-card__big">{r.result.finish}</span>
                  <span className="muted">공기 {r.result.durationDays.toLocaleString()}일 · 주공정 작업 {r.result.critical.length}개</span>
                  <span className="muted">장비 {r.result.levers.rigs} · 교각조 {r.result.levers.pierCrews} · 코핑 거푸집 {r.result.levers.copingSets} · 런처 {r.result.levers.launchers}</span>
                  {i > 0 && results.slice(0, i).some(x => x.result.durationDays === r.result.durationDays) && (
                    <span className="sim-warn">앞 안과 공기 같음 — 투입을 늘려도 주공정(교대·특수 경간 등)이 줄지 않음</span>
                  )}
                  {r.result.deadlines.map(d => (
                    <span key={d.name} className={d.slackDays < 0 ? 'sim-error' : 'sim-ok'}>{d.name}: {d.planned} ({d.slackDays >= 0 ? `여유 ${d.slackDays}일` : `${-d.slackDays}일 늦음`})</span>
                  ))}
                </button>
              ))}
            </div>
            {pick && (
              <>
                <div className="sim-step__actions">
                  <button className="btn btn--sm btn--primary" disabled={!canEdit || adoptedHere} onClick={adopt}
                    title="이 안을 확정 공정표로 — 검토·BIM 연결·4D 가 씁니다">{adoptedHere ? '✓ 확정한 안' : '이 안으로 확정'}</button>
                  <button className="btn btn--sm" onClick={() => { const b = xerBytes(); if (b) download(b, fileName()); }}>XER 내려받기(P6)</button>
                  <button className="btn btn--sm" onClick={() => { const b = xerBytes(); if (b) void sim.openXer(new File([b as BlobPart], fileName())).then(() => setStatus('4D/5D 에 열었습니다 — 8단계에서 보세요.')); }}>4D/5D 로 열기</button>
                </div>
                <p className="muted">
                  {adopted ? `확정 공정표: ${adopted.title}(${adopted.at.slice(0, 10)} 채택). ` : '아직 확정한 안이 없습니다. '}
                  그대로 쓰면 올릴 것이 없고, P6 에서 고쳤을 때만 5단계에 수정본을 올립니다. XER 에는 활동마다 '산정근거' UDF 가 함께 갑니다.
                </p>
                <div className="sim-table-wrap sim-table-wrap--tall">
                  <table className="sim-table">
                    <thead><tr><th>Activity ID</th><th>작업</th><th>수량</th><th>일수</th><th>시작</th><th>종료</th><th>여유</th><th>근거</th></tr></thead>
                    <tbody>
                      {pick.basis.map(b => {
                        const d = pick.dates.get(b.code);
                        return (
                          <tr key={b.code} className={d && d.float <= 0 ? 'is-critical' : ''}>
                            <td>{b.code}</td><td>{b.name}</td><td>{b.qty}</td><td>{b.days}</td>
                            <td>{d?.start}</td><td>{d?.finish}</td><td>{d?.float}</td><td className="muted sim-table__note">{b.source}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
