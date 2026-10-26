import { useMemo, useState } from 'react';
import { listDailyLogs } from '../../../lib/dashboard';
import { checkSchedule } from '../../../lib/p6/check';
import { accBoqSheet, boqLines, boqSections, guessBoqSection, type BoqLine } from '../../../lib/sim45d/docText';
import { phaseAt, progressAt } from '../../../lib/sim45d/timeline';
import { AiBox, AiStatus, fmtWon, useAi, type StepProps } from './common';
import { confirmedSource } from '../../../lib/sim45d/confirmed';

/**
 * 9단계 검증·질의: 공정표 검토·연결 결과 요약, 그리고 AI 활용 6·7·8 —
 * 작업일보 → 실적일 제안(사람 확인), 내역 항목 분류(A·B·C·D·부위), 자연어 질의(답은 플랫폼 계산값만).
 */
interface Actuals { actuals: { code: string; start: string; finish: string; evidenceDate: string; quote: string; confidence: 'high' | 'medium' | 'low' }[]; unmatched: string[] }
interface Classified { items: { id: string; cls: 'A' | 'B' | 'C' | 'D'; part: string; reason: string }[] }
interface Answer { answer: string; usedFacts: string[]; cannotAnswer: boolean }

const PARTS = ['기초·말뚝', '교각', '코핑', '교대', '받침', '거더', '상판·공동구', '특수 경간', '부대공', '공통'];
const CLS_LABEL = { A: 'A 형상 직접', B: 'B 형상 파생', C: 'C 모델 없음(배분)', D: 'D 간접비' } as const;
const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

export function ReportStep({ projectId, canEdit, data, name, sim, openP6, opening }: StepProps) {
  const s = sim.schedule;
  const confirmed = confirmedSource(data);
  const ai = useAi(projectId);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [actuals, setActuals] = useState<Actuals | null>(null);
  const [section, setSection] = useState('');
  const [sheet, setSheet] = useState<{ rows: unknown[][]; sections: { title: string; lines: number }[] } | null>(null);
  const [boq, setBoq] = useState<BoqLine[] | null>(null);
  const [classes, setClasses] = useState<Classified | null>(null);
  const [note, setNote] = useState('');
  const check = useMemo(() => (s ? checkSchedule(s) : null), [s]);
  const linkCount = (data.links ?? []).reduce((n, l) => n + l.links.length, 0);

  /** 질의에 쓰는 사실: 모두 플랫폼이 계산한 값. */
  const facts = () => {
    if (!s) return {};
    const t = sim.time;
    const p = progressAt(sim.acts, t, sim.cost.size ? sim.cost : undefined);
    const names = new Map(s.activities.map(a => [a.code, a.name]));
    const by = (filter: (a: (typeof sim.acts)[number]) => boolean, limit = 40) => sim.acts.filter(a => !a.summary && filter(a)).slice(0, limit)
      .map(a => ({ code: a.code, name: names.get(a.code), start: ymd(a.start), finish: ymd(a.end - 1) }));
    return {
      공정표: { 이름: s.projectName, 기준일: s.dataDate?.slice(0, 10), 작업수: s.activities.length, 시작: sim.range && ymd(sim.range.start), 종료: sim.range && ymd(sim.range.end) },
      조회일: ymd(t),
      조회일_계획공정률: `${(p.progress * 100).toFixed(1)}%`,
      조회일_진행중_작업수: sim.acts.filter(a => !a.summary && phaseAt(a, t) === 'active').length,
      조회일_진행중_작업: by(a => phaseAt(a, t) === 'active'),
      앞으로_30일_안에_끝나는_작업: by(a => a.end - 1 >= t && a.end - 1 < t + 30 * DAY),
      앞으로_30일_안에_시작하는_작업: by(a => a.start >= t && a.start < t + 30 * DAY),
      ...(sim.cost.size ? { 조회일_누적공사비_계획: fmtWon(p.cost ?? 0), 총공사비_계획: fmtWon(p.costTotal ?? 0) } : {}),
      검토결과_건수: check?.counts ?? {},
      BIM_연결_객체수: linkCount,
    };
  };

  const ask = async () => {
    if (ai.toClaude('qa', question)) return;
    const r = await ai.call<Answer>('qa', { question, facts: facts() }, '질의');
    if (r) setAnswer(r);
  };

  const proposeActuals = async () => {
    if (ai.toClaude('dailyActuals')) return;
    if (!s) return;
    const logs = (await listDailyLogs(projectId, 120)).filter(l => l.content?.trim()).map(l => ({ date: l.log_date, text: l.content!.slice(0, 2000) }));
    if (!logs.length) { setNote('작업일보에 내용이 있는 날이 없습니다.'); return; }
    const acts = s.activities.filter(a => !a.actualFinish && a.taskType === 'TT_Task').slice(0, 2000).map(a => ({ code: a.code, name: a.name, path: a.wbsPath }));
    const r = await ai.call<Actuals>('dailyActuals', { logs, activities: acts }, `작업일보 ${logs.length}일 분석`);
    if (r) { const ok = new Set(acts.map(a => a.code)); setActuals({ ...r, actuals: r.actuals.filter(a => ok.has(a.code)) }); }
  };

  /** 구간 고르기: 내역서는 상·하선을 묶어 공종별로 적는 일이 많아 제목을 목록에서 고르게 한다. */
  const pickSection = (rows: unknown[][], title: string) => {
    setSection(title);
    const lines = boqLines(rows, title);
    setBoq(lines);
    setClasses(null);
    setNote(lines.length ? '' : `'${title}' 구간에 항목이 없습니다.`);
  };

  const loadBoq = async () => {
    const f = data.files.boq?.[0];
    if (!f) return;
    setNote('내역서 읽는 중…');
    try {
      const rows = await accBoqSheet(f.accProjectId, f.accItemId);
      const sections = boqSections(rows);
      setSheet({ rows, sections });
      const guess = guessBoqSection(sections, name);
      if (guess) pickSection(rows, guess);
      else { setBoq(null); setNote(sections.length ? `'${name}' 이(가) 든 제목이 없습니다 — 아래 목록에서 구간을 고르세요.` : '내역서에서 번호 제목(예: 2-1. 연제교)을 찾지 못했습니다.'); }
    } catch (e) {
      setNote(`내역서 읽기 실패: ${(e as Error).message}`);
    }
  };

  const classify = async () => {
    if (ai.toClaude('boqClassify')) return;
    if (!boq?.length) return;
    const merged: Classified = { items: [] };
    let answered = false;
    for (let i = 0; i < boq.length; i += 300) {
      const r = await ai.call<Classified>('boqClassify', { lines: boq.slice(i, i + 300).map(l => ({ id: l.id, name: l.name, spec: l.spec, unit: l.unit })), parts: PARTS }, `내역 분류 ${i + 1}~${Math.min(boq.length, i + 300)}`);
      if (!r) break;
      answered = true;
      merged.items.push(...r.items);
    }
    if (answered) setClasses(merged);
  };

  const classSummary = useMemo(() => {
    if (!classes || !boq) return null;
    const amount = new Map(boq.map(l => [l.id, l.amount]));
    const m = new Map<string, { n: number; won: number }>();
    for (const it of classes.items) {
      for (const k of [`cls:${it.cls}`, `part:${it.part}`]) {
        const v = m.get(k) ?? { n: 0, won: 0 };
        v.n++; v.won += amount.get(it.id) ?? 0;
        m.set(k, v);
      }
    }
    return m;
  }, [classes, boq]);

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <h4>요약</h4>
        <ul className="sim-list">
          <li>공정표: {s ? `${s.projectName} · 작업 ${s.activities.length.toLocaleString()}` : (
            confirmed
              ? <button className="btn btn--sm" disabled={opening} onClick={openP6}>{opening ? '여는 중…' : `확정 공정표 열기 — ${confirmed.label}`}</button>
              : '확정 공정표 없음(4단계에서 안 채택)')}</li>
          {check && <li>검토: 오류 {check.findings.filter(f => f.severity === 'error').length} · 경고 {check.findings.filter(f => f.severity === 'warn').length} (자세히는 5단계)</li>}
          <li>BIM 연결 저장: {linkCount.toLocaleString()}개 객체</li>
        </ul>
        {(data.log?.length ?? 0) > 0 && (
          <details className="sim-step__details">
            <summary>저장 기록 {data.log!.length}건(AI 연결 {data.log!.filter(l => l.who === 'AI 연결').length})</summary>
            <ul className="sim-list">{[...data.log!].reverse().slice(0, 20).map((l, i) => <li key={i}>{l.at.slice(0, 16).replace('T', ' ')} · {l.who} · {l.what}</li>)}</ul>
          </details>
        )}
      </section>

      <section className="sim-step__block">
        <h4>질의(AI 활용 8)</h4>
        <div className="sim-form sim-form--inline">
          <input className="sim-form__grow" value={question} onChange={e => setQuestion(e.target.value)} placeholder="예) 기준일에 진행 중인 교각 작업은? 앞으로 한 달 안에 끝나야 하는 작업은?"
            onKeyDown={e => { if (e.key === 'Enter' && question.trim() && !ai.busy) void ask(); }} aria-label="질문" />
          <button className="btn btn--sm btn--primary" disabled={!canEdit || !s || !question.trim() || !!ai.busy} onClick={() => void ask()}>묻기</button>
        </div>
        <p className="muted">답은 4D/5D 의 조회일({ymd(sim.time)}) 기준으로 플랫폼이 계산한 값만 씁니다.</p>
        {answer && <AiBox title={answer.cannotAnswer ? '이 정보로는 답할 수 없음' : '답'} usage={ai.usage}><p>{answer.answer}</p></AiBox>}
      </section>

      <section className="sim-step__block">
        <h4>작업일보 → 실적 제안(AI 활용 6)</h4>
        <div className="sim-step__actions">
          <button className="btn btn--sm" disabled={!canEdit || !s || !!ai.busy} onClick={() => void proposeActuals()}>최근 일보에서 실적 찾기</button>
          <span className="muted">제안만 합니다 — P6 에 실적을 넣는 것은 사람이 확인한 뒤.</span>
        </div>
        {actuals && (
          <AiBox title={`실적 제안 ${actuals.actuals.length}건 · 작업을 모르는 기록 ${actuals.unmatched.length}건`} usage={ai.usage}>
            <div className="sim-table-wrap">
              <table className="sim-table">
                <thead><tr><th>Activity ID</th><th>실적 시작</th><th>실적 완료</th><th>확신</th><th>일보 근거</th></tr></thead>
                <tbody>{actuals.actuals.map((a, i) => <tr key={i}><td>{a.code}</td><td>{a.start}</td><td>{a.finish}</td><td>{a.confidence}</td><td className="muted sim-table__note">{a.evidenceDate}: {a.quote}</td></tr>)}</tbody>
              </table>
            </div>
          </AiBox>
        )}
      </section>

      <section className="sim-step__block">
        <h4>내역 분류(AI 활용 7)</h4>
        <div className="sim-form sim-form--inline">
          <button className="btn btn--sm" disabled={!data.files.boq?.length} onClick={() => void loadBoq()}>내역서 읽기</button>
          {sheet && (
            <select value={section} aria-label="내역서 구간" onChange={e => pickSection(sheet.rows, e.target.value)}>
              {!section && <option value="">— 구간을 고르세요 —</option>}
              {sheet.sections.map(x => <option key={x.title} value={x.title}>{x.title} ({x.lines})</option>)}
            </select>
          )}
          <button className="btn btn--sm" disabled={!canEdit || !boq?.length || !!ai.busy} onClick={() => void classify()}>AI 로 분류</button>
          {boq && <span className="muted">항목 {boq.length} · 합계 {fmtWon(boq.reduce((n, l) => n + l.amount, 0))} ('식' 묶음 제외)</span>}
        </div>
        {classSummary && (
          <AiBox title={`분류 ${classes!.items.length}/${boq!.length}`} usage={ai.usage}>
            <table className="sim-table">
              <tbody>
                {(['A', 'B', 'C', 'D'] as const).map(c => { const v = classSummary.get(`cls:${c}`); return <tr key={c}><td>{CLS_LABEL[c]}</td><td>{v?.n ?? 0}항목</td><td>{fmtWon(v?.won ?? 0)}</td></tr>; })}
              </tbody>
            </table>
            <p className="muted">부위별: {PARTS.map(p => { const v = classSummary.get(`part:${p}`); return v ? `${p} ${v.n}` : null; }).filter(Boolean).join(' · ')}</p>
          </AiBox>
        )}
      </section>
      <AiStatus busy={ai.busy} error={ai.error} />
      {note && <p className="muted">{note}</p>}
    </div>
  );
}
