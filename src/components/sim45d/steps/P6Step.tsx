import { useMemo, useState } from 'react';
import { AccFilePicker } from '../../AccFilePicker';
import { accFileBlobUrl } from '../../../lib/aps';
import { CHECK_RULES, checkSchedule, type CheckRule } from '../../../lib/p6/check';
import { diffSchedules, readSchedule, type P6Schedule } from '../../../lib/p6/schedule';
import { decodeXer, parseXer } from '../../../lib/p6/xer';
import { AiBox, AiStatus, useAi, type StepProps } from './common';

/**
 * 5단계 P6 보완: 확정 공정표(XER)를 자료관리에서 골라 4D 로 열고, 방식 3 — 그 공정표를 규칙으로 검토(선후행·구조 순서 역전,
 * 실적 누락, 공단 표준 위반)하고 AI 가 우선 조치를 설명한다. 이전 버전과 비교해 바뀐 점을 AI 가 요약한다.
 */
interface Explain { summary: string; priorities: { title: string; rule: string; why: string; action: string; codes: string[] }[] }
interface DiffSum { summary: string; highlights: { code: string; change: string; impact: string }[]; risks: string[] }

const SEV_LABEL = { error: '오류', warn: '경고', info: '참고' } as const;

export function P6Step({ projectId, canEdit, data, sim, setStatus, renderSlot, onOpenP6, opening }: StepProps & { onOpenP6: () => void; opening: boolean }) {
  const [dataDate, setDataDate] = useState('');
  const [open, setOpen] = useState<CheckRule | null>(null);
  const [explain, setExplain] = useState<Explain | null>(null);
  const [prev, setPrev] = useState<{ name: string; schedule: P6Schedule } | null>(null);
  const [diffAi, setDiffAi] = useState<DiffSum | null>(null);
  const [picker, setPicker] = useState(false);
  const ai = useAi(projectId);
  const s = sim.schedule;
  const result = useMemo(() => (s ? checkSchedule(s, { dataDate: dataDate || null }) : null), [s, dataDate]);
  const diff = useMemo(() => (s && prev ? diffSchedules(prev.schedule, s) : null), [s, prev]);
  const bySev = useMemo(() => {
    const m = { error: 0, warn: 0, info: 0 };
    for (const f of result?.findings ?? []) m[f.severity]++;
    return m;
  }, [result]);
  const rules = useMemo(() => (Object.keys(result?.counts ?? {}) as CheckRule[]).sort((a, b) => {
    const o = ['error', 'warn', 'info'];
    return o.indexOf(CHECK_RULES[a].severity) - o.indexOf(CHECK_RULES[b].severity) || (result!.counts[b]! - result!.counts[a]!);
  }), [result]);

  const askExplain = async () => {
    if (!s || !result) return;
    const examples = rules.flatMap(rule => result.findings.filter(f => f.rule === rule).slice(0, 8).map(f => ({ rule, message: f.message })));
    const r = await ai.call<Explain>('explainCheck', {
      project: s.projectName, dataDate: result.dataDate, checked: result.checked, counts: result.counts,
      rules: Object.fromEntries(rules.map(k => [k, { title: CHECK_RULES[k].title, why: CHECK_RULES[k].why }])), examples: examples.slice(0, 80),
    }, '검토 결과 설명');
    if (r) setExplain(r);
  };

  const loadPrev = async (f: { accProjectId: string; accItemId: string; name: string }) => {
    setPicker(false);
    let url = '';
    try {
      url = await accFileBlobUrl(f.accProjectId, f.accItemId);
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      setPrev({ name: f.name, schedule: readSchedule(parseXer(decodeXer(bytes).text)) });
      setDiffAi(null);
    } catch (e) {
      setStatus(`이전 공정표 읽기 실패: ${(e as Error).message}`);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  const askDiff = async () => {
    if (!s || !prev || !diff) return;
    const pick = (a: { code: string; name: string; start: string | null; finish: string | null; durationDays: number }) => ({ code: a.code, name: a.name, start: a.start, finish: a.finish, days: a.durationDays });
    const crit = (x: P6Schedule) => x.activities.filter(a => a.totalFloatDays != null && a.totalFloatDays <= 0).map(a => a.code).slice(0, 200);
    const r = await ai.call<DiffSum>('diffSummary', {
      before: { name: prev.name, dataDate: prev.schedule.dataDate, activities: prev.schedule.activities.length },
      after: { name: sim.fileName, dataDate: s.dataDate, activities: s.activities.length },
      added: diff.added.slice(0, 150).map(pick), removed: diff.removed.slice(0, 150).map(pick),
      changed: diff.changed.slice(0, 300).map(c => ({ code: c.code, fields: c.fields, before: pick(c.before), after: pick(c.after) })),
      criticalBefore: crit(prev.schedule), criticalAfter: crit(s),
    }, '변경 요약');
    if (r) setDiffAi(r);
  };

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <div className="sim-setup__slots">{renderSlot('p6')}</div>
        <div className="sim-step__actions">
          <button className="btn btn--sm btn--primary" disabled={!data.files.p6?.length || opening} onClick={onOpenP6}>이 공정표로 4D/5D 열기</button>
          {s && <span className="muted">지금 열린 공정표: {s.projectName} (작업 {s.activities.length.toLocaleString()}개)</span>}
        </div>
      </section>

      <section className="sim-step__block">
        <h4>공정표 검토(방식 3)</h4>
        {!s ? <p className="muted">공정표를 4D/5D 로 열면(위 버튼 또는 도구 줄 '공정표 열기') 바로 검토합니다.</p> : result && (
          <>
            <div className="sim-form sim-form--inline">
              <span><strong>{s.projectName}</strong> · 작업 {result.checked.activities.toLocaleString()} · 관계 {result.checked.relations.toLocaleString()}</span>
              <label>검토 기준일<input type="date" value={dataDate || result.dataDate || ''} onChange={e => setDataDate(e.target.value)} /></label>
              <span className="sim-sev is-error">오류 {bySev.error}</span>
              <span className="sim-sev is-warn">경고 {bySev.warn}</span>
              <span className="sim-sev is-info">참고 {bySev.info}</span>
            </div>
            <ul className="sim-rules">
              {rules.map(rule => (
                <li key={rule} className={`is-${CHECK_RULES[rule].severity}`}>
                  <button type="button" className="sim-rules__head" aria-expanded={open === rule} onClick={() => setOpen(open === rule ? null : rule)}>
                    <span className={`sim-sev is-${CHECK_RULES[rule].severity}`}>{SEV_LABEL[CHECK_RULES[rule].severity]}</span>
                    <strong>{CHECK_RULES[rule].title}</strong> <span>{result.counts[rule]!.toLocaleString()}건</span>
                    <span className="muted sim-rules__why">{CHECK_RULES[rule].why}</span>
                  </button>
                  {open === rule && (
                    <ul className="sim-rules__list">
                      {result.findings.filter(f => f.rule === rule).slice(0, 200).map((f, i) => <li key={i}>{f.message}</li>)}
                      {result.counts[rule]! > 200 && <li className="muted">… 외 {result.counts[rule]! - 200}건</li>}
                    </ul>
                  )}
                </li>
              ))}
              {!rules.length && <li className="sim-ok">규칙에 걸린 항목이 없습니다.</li>}
            </ul>
            <div className="sim-step__actions">
              <button className="btn btn--sm" disabled={!canEdit || !rules.length || !!ai.busy} onClick={() => void askExplain()}>AI 로 우선 조치 정리</button>
              <AiStatus busy={ai.busy} error={ai.error} />
            </div>
            {explain && (
              <AiBox title="검토 요약과 우선 조치" usage={ai.usage}>
                <p>{explain.summary}</p>
                <ol className="sim-list">
                  {explain.priorities.map((p, i) => (
                    <li key={i}><strong>{p.title}</strong> — {p.why}<br /><span className="sim-ai__action">조치: {p.action}</span>{p.codes.length > 0 && <span className="muted"> ({p.codes.slice(0, 6).join(', ')}{p.codes.length > 6 ? ' …' : ''})</span>}</li>
                  ))}
                </ol>
              </AiBox>
            )}
          </>
        )}
      </section>

      <section className="sim-step__block">
        <h4>이전 버전과 비교</h4>
        <div className="sim-step__actions">
          <button className="btn btn--sm" disabled={!s} onClick={() => setPicker(true)}>이전 공정표(XER) 고르기</button>
          {prev && <span className="muted">{prev.name} → {sim.fileName}</span>}
        </div>
        {diff && (
          <>
            <p>추가 {diff.added.length} · 삭제 {diff.removed.length} · 변경 {diff.changed.length}</p>
            <div className="sim-table-wrap">
              <table className="sim-table">
                <thead><tr><th>Activity ID</th><th>작업</th><th>바뀐 칸</th><th>이전</th><th>새</th></tr></thead>
                <tbody>
                  {diff.changed.slice(0, 100).map(c => (
                    <tr key={c.code}><td>{c.code}</td><td>{c.after.name}</td><td>{c.fields.join(', ')}</td>
                      <td>{c.before.start?.slice(0, 10)}~{c.before.finish?.slice(0, 10)}</td><td>{c.after.start?.slice(0, 10)}~{c.after.finish?.slice(0, 10)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sim-step__actions">
              <button className="btn btn--sm" disabled={!canEdit || !!ai.busy || (!diff.added.length && !diff.removed.length && !diff.changed.length)} onClick={() => void askDiff()}>AI 로 변경 요약</button>
            </div>
            {diffAi && (
              <AiBox title="변경 요약" usage={ai.usage}>
                <p>{diffAi.summary}</p>
                <ul className="sim-list">{diffAi.highlights.map((h, i) => <li key={i}><strong>{h.code}</strong> {h.change} — {h.impact}</li>)}</ul>
                {diffAi.risks.length > 0 && <><strong>확인할 점</strong><ul className="sim-list">{diffAi.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></>}
              </AiBox>
            )}
          </>
        )}
      </section>

      {picker && (
        <AccFilePicker projectId={projectId} canEdit={canEdit} title="비교할 이전 공정표(XER)" actionLabel="비교" accept={n => /\.xer$/i.test(n)}
          onPick={f => void loadPrev(f)} onClose={() => setPicker(false)} />
      )}
    </div>
  );
}
