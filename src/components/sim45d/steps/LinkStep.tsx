import { useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { autoLink, LINK_PART_LABEL, type LinkActivity, type LinkResult } from '../../../lib/sim45d/autolink';
import type { LinkSet, SetupFile } from '../../../lib/sim45d/setup';
import { wbsScope } from '../../../lib/sim45d/wbsScope';
import { AiBox, AiStatus, useAi, type StepProps } from './common';

/**
 * 6단계 BIM 연결: 확정 IPS(4D 로 연 공정표)의 Activity ID 를 모델 객체에 붙인다. 규칙(부위·개소) → 남는 것만 AI.
 * 모델에 이미 코드가 있으면 비교해 서로 다른 객체(사람 입력 오류 후보)를 보여준다. 결과는 대상별로 저장(객체 키 = Revit UniqueId).
 */
interface ModelObject { id: number; ext: string; name: string; label: string; type: string; comment: string; ifcGuid: string; ifcClass?: string; code: string; level7: string; level8: string; volume: number | null }

async function fetchObjects(urn: string, onWait: (n: number) => void): Promise<ModelObject[]> {
  const { data } = await supabase.auth.getSession();
  const headers = data.session ? { authorization: `Bearer ${data.session.access_token}` } : undefined;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await fetch(`/api/aps-props?urn=${encodeURIComponent(urn)}`, { headers });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `속성 읽기 실패(${r.status})`);
    if (!body.pending) return body.objects as ModelObject[];
    onWait(attempt);
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error('속성이 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하세요.');
}

export function LinkStep({ projectId, canEdit, data, persist, sim, setStatus, openP6, opening }: StepProps) {
  const s = sim.schedule;
  const models = (data.files.model ?? []).filter((f): f is SetupFile => !!f);
  const [modelId, setModelId] = useState(models[0]?.accItemId ?? '');
  const [root, setRoot] = useState('');
  const [objects, setObjects] = useState<ModelObject[] | null>(null);
  const [results, setResults] = useState<LinkResult[] | null>(null);
  const [aiLinks, setAiLinks] = useState<Map<string, { code: string; reason: string }>>(new Map());
  const [loading, setLoading] = useState('');
  const ai = useAi(projectId);
  const model = models.find(m => m.accItemId === modelId);

  // WBS: 이름 경로와 하위 작업 수 — 대상 구조물 WBS 를 고르게
  const wbs = useMemo(() => (s ? wbsScope(s) : { nodes: [], under: () => [] as LinkActivity[] }), [s]);

  const load = async () => {
    if (!model?.urn) return;
    setLoading('모델 속성 읽는 중…');
    try {
      const objs = await fetchObjects(model.urn, n => setLoading(`ACC 가 속성을 준비 중입니다(${n})…`));
      setObjects(objs);
      setResults(null);
      if (!objs.length) setStatus(`${model.name}: 연결할 객체를 찾지 못했습니다 — 변환본에 요소 속성이 없습니다(IFC 는 속성 세트를 포함해 내보내야 함).`);
      setAiLinks(new Map());
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setLoading('');
    }
  };

  const run = () => {
    if (!objects || !root) return;
    setResults(autoLink(objects.map(o => ({ id: String(o.id), label: o.label || undefined, name: o.name, type: o.type || undefined, comment: o.comment || undefined, ifcClass: o.ifcClass || undefined })), wbs.under(root)));
    setAiLinks(new Map());
  };

  const stats = useMemo(() => {
    if (!results || !objects) return null;
    const byId = new Map(objects.map(o => [String(o.id), o]));
    let linked = 0, open = 0, agree = 0, differ = 0, hadCode = 0;
    const diffs: { o: ModelObject; r: LinkResult }[] = [];
    for (const r of results) {
      const o = byId.get(r.id)!;
      const code = r.code ?? aiLinks.get(r.id)?.code ?? null;
      if (code) linked++; else open++;
      if (o.code) {
        hadCode++;
        if (code === o.code) agree++;
        else if (code) { differ++; diffs.push({ o, r: { ...r, code } }); }
      }
    }
    return { linked, open, agree, differ, hadCode, diffs };
  }, [results, objects, aiLinks]);

  const askAi = async () => {
    if (ai.toClaude('linkLeftovers')) return;
    if (!results || !objects) return;
    const byId = new Map(objects.map(o => [String(o.id), o]));
    const open = results.filter(r => !r.code).slice(0, 300).map(r => { const o = byId.get(r.id)!; return { id: r.id, label: o.label, name: o.name, type: o.type, comment: o.comment }; });
    if (!open.length) return;
    const acts = wbs.under(root).slice(0, 600);
    const r = await ai.call<{ links: { id: string; code: string; reason: string }[] }>('linkLeftovers', { objects: open, activities: acts }, `미정 객체 ${open.length}개 연결`);
    if (!r) return;
    const valid = new Set(acts.map(a => a.code));
    setAiLinks(new Map(r.links.filter(l => l.code && valid.has(l.code)).map(l => [l.id, { code: l.code, reason: l.reason }])));
  };

  const save = () => {
    if (!results || !objects || !model) return;
    const byId = new Map(objects.map(o => [String(o.id), o]));
    const links: LinkSet['links'] = results.flatMap(r => {
      const o = byId.get(r.id)!;
      const code = r.code ?? aiLinks.get(r.id)?.code;
      return code && o.ext ? [{ ext: o.ext, ifcGuid: o.ifcGuid, code, by: r.code ? 'rule' as const : 'ai' as const }] : [];
    });
    if (!links.length) { setStatus('저장할 연결이 없습니다.'); return; }
    const set: LinkSet = { modelItemId: model.accItemId, wbsRoot: s?.wbs.find(w => w.id === root)?.name ?? root, at: new Date().toISOString(), links };
    void persist({ ...data, links: [...(data.links ?? []).filter(l => l.modelItemId !== model.accItemId), set] })
      .then(() => setStatus(`연결 ${links.length}개 저장 — ${model.name}`));
  };

  if (!s) {
    return (
      <div className="sim-step__empty">
        <p>연결할 Activity ID 가 있는 확정 공정표를 먼저 엽니다.</p>
        {data.files.p6?.length
          ? <button className="btn btn--sm btn--primary" disabled={opening} onClick={openP6}>{opening ? '여는 중…' : `확정 공정표 열기 — ${data.files.p6[0].name}`}</button>
          : <p className="muted">5단계 'P6 보완' 에서 확정 공정표(XER)를 고르세요.</p>}
      </div>
    );
  }
  if (!models.length) return <p className="sim-step__empty">자료 준비에서 BIM 모델을 고르세요.</p>;

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <div className="sim-form">
          <label>모델
            <select value={modelId} onChange={e => { setModelId(e.target.value); setObjects(null); setResults(null); }}>
              {models.map(m => <option key={m.accItemId} value={m.accItemId}>{m.name}</option>)}
            </select>
          </label>
          <label className="sim-form__wide">대상 WBS(이 아래 작업에만 연결)
            <select value={root} onChange={e => { setRoot(e.target.value); setResults(null); }}>
              <option value="">— 고르세요 —</option>
              {wbs.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </label>
        </div>
        <div className="sim-step__actions">
          <button className="btn btn--sm" disabled={!model?.urn || !!loading} onClick={() => void load()}
            title={model?.urn ? '' : '이 파일은 URN 없이 골라졌습니다 — 자료 준비에서 다시 고르세요'}>모델 객체 읽기</button>
          <button className="btn btn--sm btn--primary" disabled={!objects || !root} onClick={run}>자동 연결</button>
          {loading && <span className="muted" aria-live="polite">{loading}</span>}
          {objects && <span className="muted">객체 {objects.length.toLocaleString()} · 체적 없음 {objects.filter(o => o.volume == null).length.toLocaleString()}</span>}
        </div>
      </section>

      {stats && results && (
        <section className="sim-step__block">
          <h4>연결 {stats.linked.toLocaleString()} / {results.length.toLocaleString()} · 미정 {stats.open}</h4>
          {stats.hadCode > 0 && (
            <p>모델에 이미 들어 있던 코드 {stats.hadCode.toLocaleString()}개와 비교: <span className="sim-ok">같음 {stats.agree.toLocaleString()}</span> · <span className="sim-error">다름 {stats.differ}</span>
              <span className="muted"> — 다른 것은 사람 입력 오류이거나 규칙 오류입니다. 아래에서 객체의 개소(Level7)와 함께 확인하세요.</span></p>
          )}
          {stats.diffs.length > 0 && (
            <details className="sim-step__details" open={stats.diffs.length <= 20}>
              <summary>코드가 다른 객체 {stats.diffs.length}</summary>
              <div className="sim-table-wrap">
                <table className="sim-table">
                  <thead><tr><th>객체</th><th>객체명칭</th><th>Level7</th><th>모델 코드</th><th>자동</th><th>근거</th></tr></thead>
                  <tbody>
                    {stats.diffs.slice(0, 300).map(({ o, r }) => (
                      <tr key={o.id}><td>{o.name}</td><td>{o.label}</td><td>{o.level7}</td><td>{o.code}</td><td>{r.code}</td><td className="muted sim-table__note">{r.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {stats.open > 0 && (
            <details className="sim-step__details">
              <summary>미정 {stats.open} — 부위별</summary>
              <ul className="sim-list">
                {Object.entries(results.filter(r => !r.code && !aiLinks.has(r.id)).reduce<Record<string, number>>((m, r) => { const k = r.part ? LINK_PART_LABEL[r.part] : r.reason; m[k] = (m[k] ?? 0) + 1; return m; }, {}))
                  .map(([k, n]) => <li key={k}>{k}: {n}</li>)}
              </ul>
            </details>
          )}
          <div className="sim-step__actions">
            <button className="btn btn--sm" disabled={!canEdit || !stats.open || !!ai.busy} onClick={() => void askAi()}>AI 로 미정 객체 연결</button>
            <button className="btn btn--sm btn--primary" disabled={!canEdit || !stats.linked} onClick={save}>연결 저장</button>
            <AiStatus busy={ai.busy} error={ai.error} />
          </div>
          {aiLinks.size > 0 && (
            <AiBox title={`AI 가 고른 연결 ${aiLinks.size}개(규칙 미정분)`} usage={ai.usage}>
              <ul className="sim-list">{[...aiLinks].slice(0, 30).map(([id, l]) => <li key={id}>{objects?.find(o => String(o.id) === id)?.name} → {l.code} — {l.reason}</li>)}</ul>
            </AiBox>
          )}
          <p className="muted">체적 속성이 없는 객체 {objects?.filter(o => o.volume == null).length.toLocaleString()}개는 SVF 형상으로 자동 산정할 예정입니다(시험 완료: Revit 체적 대비 92% 가 ±1% — 플랫폼 기능은 준비 중).</p>
        </section>
      )}
    </div>
  );
}
