import { useMemo, useState } from 'react';
import { parseSupportList, spansFromSupports, type BridgeSite, type Span, type Support } from '../../../lib/p6/bridgePlan';
import { accPdfPages, chunkPages } from '../../../lib/sim45d/docText';
import { AiBox, AiStatus, useAi, type StepProps } from './common';

/** 3단계 설계현황: 개소(교대·교각)·말뚝·교각 높이·경간 표. 직접 만들거나 수량산출서에서 AI 로 채운다. */
interface Extracted {
  supports: { id: string; kind: 'abutment' | 'pier'; pileType: 'cast' | 'driven' | 'unknown'; pileCount: number; footing: boolean; heightM: number; page: number; quote: string }[];
  spans: { id: string; kind: 'girder' | 'special'; name: string; lengthM: number; page: number; quote: string }[];
  notes: string[];
}

const ALL_IDS = (text: string) => {
  const ids: string[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([AP])(\d+)(?:\s*[~-]\s*[AP]?(\d+))?$/i.exec(part);
    if (!m) continue;
    const k = m[1].toUpperCase(), a = Number(m[2]), b = Number(m[3] ?? m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ids.push(`${k}${i}`);
  }
  return ids;
};

export function DesignStep({ projectId, canEdit, data, name, persist, setStatus }: StepProps) {
  const [site, setSite] = useState<BridgeSite | null>(data.site ?? null);
  const [layout, setLayout] = useState('A1, P1~P46, A2');
  const [code, setCode] = useState(data.site?.code ?? 'BR01');
  const [pages, setPages] = useState('1-60');
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [progress, setProgress] = useState('');
  const ai = useAi(projectId);
  const qto = data.files.qto?.[0];
  const dirty = JSON.stringify(site) !== JSON.stringify(data.site ?? null);
  const evidence = useMemo(() => new Map(extracted?.supports.map(s => [s.id, `${s.page}쪽: ${s.quote}`]) ?? []), [extracted]);

  const make = () => {
    const ids = ALL_IDS(layout);
    if (!ids.length) { setStatus('개소를 읽지 못했습니다. 예: A1, P1~P46, A2'); return; }
    const supports: Support[] = ids.map(id => (id.startsWith('A')
      ? { id, kind: 'abutment', pileType: 'driven', pileCount: 0 }
      : { id, kind: 'pier', pileType: 'cast', pileCount: 1 }));
    setSite({ name, code: code.trim() || 'BR01', supports, spans: spansFromSupports(supports) });
  };

  const setSupport = (i: number, patch: Partial<Support>) => site && setSite({ ...site, supports: site.supports.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const setSpan = (i: number, patch: Partial<Span>) => site && setSite({ ...site, spans: site.spans.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  const extract = async () => {
    if (!qto) return;
    setProgress('수량산출서 글 읽는 중…');
    try {
      const { pages: found } = await accPdfPages(qto.accProjectId, qto.accItemId, {
        pages, keep: /집계|교각|교대|말뚝|경간|SPAN/i, onProgress: (d, t) => setProgress(`수량산출서 글 읽는 중 ${d}/${t}쪽`),
      });
      setProgress(`${found.length}쪽을 AI 로 보냅니다`);
      const merged: Extracted = { supports: [], spans: [], notes: [] };
      let answered = false;
      for (const chunk of chunkPages(found)) {
        const r = await ai.call<Extracted>('designExtract', { structure: name, pages: chunk }, `설계현황 추출(${chunk[0].page}~${chunk[chunk.length - 1].page}쪽)`);
        if (!r) break;
        answered = true;
        for (const s of r.supports) {
          const k = merged.supports.findIndex(x => x.id === s.id);
          if (k < 0) merged.supports.push(s);
          else merged.supports[k] = { ...merged.supports[k], ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0 && v !== '' && v !== 'unknown')) };
        }
        for (const s of r.spans) if (!merged.spans.some(x => x.id === s.id)) merged.spans.push(s);
        merged.notes.push(...r.notes);
      }
      if (answered) setExtracted(merged);
    } catch (e) {
      ai.setError(`문서 읽기 실패: ${(e as Error).message}`);
    } finally {
      setProgress('');
    }
  };

  const applyExtracted = () => {
    if (!extracted?.supports.length) return;
    const order = (id: string) => (id.startsWith('A') ? (id === 'A1' ? -1 : 1e6) : Number(id.slice(1)));
    const supports: Support[] = [...extracted.supports].sort((a, b) => order(a.id) - order(b.id)).map(s => ({
      id: s.id, kind: s.kind, pileType: s.pileType === 'unknown' ? (s.kind === 'abutment' ? 'driven' : 'cast') : s.pileType,
      pileCount: s.pileCount || (s.kind === 'pier' ? 1 : 0), footing: s.footing, heightM: s.heightM || undefined,
    }));
    const special = Object.fromEntries(extracted.spans.filter(s => s.kind === 'special').map(s => [s.id, { name: s.name || `특수 경간 ${s.id}` }]));
    setSite({ name, code: code.trim() || 'BR01', supports, spans: spansFromSupports(supports, special) });
    setStatus(`AI 추출 반영: 개소 ${supports.length}개 — 표에서 확인·수정 후 저장하세요.`);
  };

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <h4>개소 만들기</h4>
        <div className="sim-form">
          <label>Activity ID 앞머리<input value={code} maxLength={12} onChange={e => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} disabled={!canEdit} /></label>
          <label className="sim-form__wide">개소(노선 순서)<input value={layout} onChange={e => setLayout(e.target.value)} placeholder="A1, P1~P46, A2" disabled={!canEdit} /></label>
          <button className="btn btn--sm" onClick={make} disabled={!canEdit}>표 만들기</button>
        </div>
        <div className="sim-form">
          <label className="sim-form__wide">수량산출서 쪽 범위(비우면 전체)<input value={pages} onChange={e => setPages(e.target.value)} placeholder="9-38, 1179-1210" disabled={!canEdit} /></label>
          <button className="btn btn--sm" disabled={!canEdit || !qto || !!ai.busy || !!progress} onClick={() => void extract()}
            title={qto ? qto.name : '자료 준비에서 수량산출서를 먼저 고르세요'}>AI 로 채우기 — 수량산출서</button>
        </div>
        {progress && <p className="muted" aria-live="polite">{progress}</p>}
        <AiStatus busy={ai.busy} error={ai.error} />
        {extracted && (
          <AiBox title={`설계현황 추출 — 개소 ${extracted.supports.length} · 특수 경간 ${extracted.spans.filter(s => s.kind === 'special').length}`} usage={ai.usage}>
            {extracted.notes.length > 0 && <ul className="sim-list">{extracted.notes.slice(0, 8).map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <button className="btn btn--sm btn--primary" disabled={!canEdit || !extracted.supports.length} onClick={applyExtracted}>표에 반영</button>
          </AiBox>
        )}
      </section>

      {site && (
        <section className="sim-step__block">
          <h4>개소 {site.supports.length} · 경간 {site.spans.length}</h4>
          <div className="sim-table-wrap">
            <table className="sim-table">
              <thead><tr><th>개소</th><th>종류</th><th>말뚝</th><th>본수</th><th>확대기초</th><th>교각 높이(m)</th><th>근거</th></tr></thead>
              <tbody>
                {site.supports.map((s, i) => (
                  <tr key={s.id}>
                    <td><strong>{s.id}</strong></td>
                    <td>{s.kind === 'abutment' ? '교대' : '교각'}</td>
                    <td>
                      <select value={s.pileType} disabled={!canEdit} onChange={e => setSupport(i, { pileType: e.target.value as Support['pileType'] })}>
                        <option value="cast">현장타설</option><option value="driven">기성(PHC·강관)</option>
                      </select>
                    </td>
                    <td><input type="number" min={0} value={s.pileCount} disabled={!canEdit} onChange={e => setSupport(i, { pileCount: Math.max(0, Number(e.target.value)) })} /></td>
                    <td><input type="checkbox" checked={!!s.footing} disabled={!canEdit || s.kind === 'abutment'} onChange={e => setSupport(i, { footing: e.target.checked })} /></td>
                    <td>{s.kind === 'pier'
                      ? <input type="number" min={0} step={0.1} value={s.heightM ?? ''} disabled={!canEdit} onChange={e => setSupport(i, { heightM: e.target.value ? Number(e.target.value) : undefined })} />
                      : '—'}</td>
                    <td className="muted sim-table__note" title={evidence.get(s.id) ?? s.source}>{evidence.get(s.id) ?? s.source ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="sim-step__details">
            <summary>경간 {site.spans.length}개 — 특수 경간(하로교·강사재교 등) 지정</summary>
            <div className="sim-table-wrap">
              <table className="sim-table">
                <thead><tr><th>경간</th><th>구간</th><th>형식</th><th>특수 경간 작업 이름</th><th>일수</th></tr></thead>
                <tbody>
                  {site.spans.map((s, i) => (
                    <tr key={s.id}>
                      <td>{s.id}</td><td>{s.from}~{s.to}</td>
                      <td>
                        <select value={s.kind} disabled={!canEdit} onChange={e => setSpan(i, { kind: e.target.value as Span['kind'] })}>
                          <option value="girder">거더 거치</option><option value="special">특수 경간</option>
                        </select>
                      </td>
                      <td>{s.kind === 'special' && <input value={s.specialName ?? ''} disabled={!canEdit} onChange={e => setSpan(i, { specialName: e.target.value })} />}</td>
                      <td>{s.kind === 'special' && <input type="number" min={1} value={s.specialDays ?? ''} placeholder="가정 60" disabled={!canEdit} onChange={e => setSpan(i, { specialDays: e.target.value ? Number(e.target.value) : undefined })} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="sim-step__actions">
            <button className="btn btn--sm btn--primary" disabled={!canEdit || !dirty} onClick={() => void persist({ ...data, site })}>설계현황 저장</button>
            {dirty && <span className="muted">저장하지 않은 변경이 있습니다.</span>}
            <span className="muted">교각 높이를 모르면 1 LOT(3m)로 계산합니다. 범위 입력 예: {parseSupportList('P38~P46', site.supports.map(s => s.id)).length ? 'P38~P46' : 'P1~P3'}</span>
          </div>
        </section>
      )}
    </div>
  );
}
