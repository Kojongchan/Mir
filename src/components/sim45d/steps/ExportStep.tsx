import { useMemo, useState } from 'react';
import { adoptedSchedule, confirmedSource, NO_CONFIRMED } from '../../../lib/sim45d/confirmed';
import { fetchModelObjects, type ModelObject } from '../../../lib/sim45d/modelObjects';
import { buildSync, DYNAMO_SCRIPT, PARAM, syncCsv, type SyncRow } from '../../../lib/sim45d/modelSync';
import type { StepProps } from './common';

/**
 * 7단계 모델 반영((가) 방식, D36): 확정 공정표 + 6단계 연결 → 객체별 A3 코드·A5 계획일 반영 CSV + Dynamo 스크립트.
 * 플랫폼은 모델을 고치지 않는다 — 사람이 원본 RVT 에 적용하고 다시 올리면, 같은 비교(모델 현재 값 ↔ 반영할 값)로 반영을 확인한다.
 */
const download = (text: string, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

const STATUS_LABEL: Record<SyncRow['status'], string> = { same: '같음', change: '바뀜', missing: '모델에 없음', unknown: '비교 전' };

export function ExportStep({ canEdit, data, name, persist, sim, setStatus, openP6, opening }: StepProps) {
  const confirmed = confirmedSource(data);
  // 확정 공정표: 4D 로 연 것, 없으면 채택안은 바로 다시 계산(P6 업로드본은 열어야 함)
  const schedule = useMemo(() => sim.schedule ?? (confirmed?.kind === 'draft' ? adoptedSchedule(data) : null), [sim.schedule, confirmed?.kind, data]);
  const models = useMemo(() => data.files.model ?? [], [data.files.model]);
  const [modelId, setModelId] = useState(models.find(m => /\.rvt$/i.test(m.name))?.accItemId ?? models[0]?.accItemId ?? '');
  const [objects, setObjects] = useState<{ id: string; list: ModelObject[] } | null>(null);
  const [loading, setLoading] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  // 채택안(개략 IPS) 날짜로 현장 일정을 덮어쓰지 않도록, P6 공정표를 올렸을 때만 날짜를 기본으로 넣는다
  const [withDates, setWithDates] = useState(confirmed?.kind === 'p6');
  const model = models.find(m => m.accItemId === modelId);
  const linkSets = useMemo(() => data.links ?? [], [data.links]);

  const sync = useMemo(() => (schedule
    ? buildSync(linkSets, models, schedule.activities.map(a => ({ code: a.code, name: a.name, start: a.start, finish: a.finish })),
      { withDates, objects: objects?.id === modelId ? objects.list : undefined })
    : null), [schedule, linkSets, models, withDates, objects, modelId]);

  const compare = async () => {
    if (!model?.urn) { setStatus(`${model?.name ?? '모델'}: 변환 URN 없이 골라졌습니다 — 2단계에서 다시 고르세요.`); return; }
    setLoading('모델 현재 값 읽는 중…');
    try {
      const list = await fetchModelObjects(model.urn, n => setLoading(`ACC 가 속성을 준비 중입니다(${n}) — 방금 올렸다면 변환에 몇 분 걸립니다…`));
      setObjects({ id: model.accItemId, list });
      if (schedule && canEdit) {
        const r = buildSync(linkSets, models, schedule.activities.map(a => ({ code: a.code, name: a.name, start: a.start, finish: a.finish })), { withDates, objects: list });
        void persist({ ...data, modelSync: { at: new Date().toISOString(), modelItemId: model.accItemId, modelName: model.name, rows: r.counts.total, same: r.counts.same, missing: r.counts.missing, withDates } });
        setStatus(r.counts.change || r.counts.missing
          ? `반영 확인: ${model.name} — 바뀔 것 ${r.counts.change} · 같음 ${r.counts.same} · 모델에 없음 ${r.counts.missing}`
          : `반영 확인 완료: ${model.name} — ${r.counts.same}개 모두 같습니다.`);
      }
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setLoading('');
    }
  };

  if (!confirmed) return <p className="sim-step__empty">{NO_CONFIRMED}</p>;
  if (!schedule) {
    return (
      <div className="sim-step__empty">
        <p>반영할 코드·일자를 만들려면 확정 공정표를 엽니다.</p>
        <button className="btn btn--sm btn--primary" disabled={opening} onClick={openP6}>{opening ? '여는 중…' : `확정 공정표 열기 — ${confirmed.label}`}</button>
      </div>
    );
  }
  if (!linkSets.some(l => l.links.length)) return <p className="sim-step__empty">6단계 BIM 연결 결과가 없습니다 — 객체에 Activity ID 를 먼저 연결하세요.</p>;

  const c = sync!.counts;
  const rows = onlyChanged && objects?.id === modelId ? sync!.rows.filter(r => r.status !== 'same') : sync!.rows;
  // 파일 이름은 영문 — Dynamo(특히 IronPython)·일부 브라우저가 한글 경로·이름을 깨뜨린다
  const base = `${(data.site?.code ?? name ?? 'MIR').replace(/[^\w.-]+/g, '_') || 'MIR'}_model_sync`;
  const exportRows = (changed: boolean) => (changed && objects?.id === modelId ? sync!.rows.filter(r => r.status === 'change') : sync!.rows.filter(r => r.status !== 'missing'));
  const last = data.modelSync;

  return (
    <div className="sim-step">
      <section className="sim-step__block">
        <h4>반영할 값</h4>
        <p className="muted">
          확정 공정표: <strong>{confirmed.label}</strong> · 연결 객체 {c.total.toLocaleString()}개
          {sync!.noActivity.length > 0 && <> · <span className="sim-warn">확정 공정표에 없는 코드 {sync!.noActivity.length}개 제외</span>(예전 공정표로 저장한 연결 — 6단계에서 다시 연결)</>}
        </p>
        <div className="sim-form sim-form--inline">
          <fieldset className="sim-form__radio">
            <label><input type="checkbox" checked readOnly /> {PARAM.code}</label>
            <label title={confirmed.kind === 'draft' ? '모델에 현장 일정이 있으면 개략 IPS 날짜로 덮어쓰게 됩니다' : ''}>
              <input type="checkbox" checked={withDates} onChange={e => setWithDates(e.target.checked)} /> {PARAM.start} · {PARAM.finish}
            </label>
          </fieldset>
          <span className="muted">A5_실시공정(실적)은 넣지 않습니다.</span>
        </div>
        {confirmed.kind === 'draft' && c.overwriteCodes > 0 && (
          <p className="sim-warn">모델에 이미 다른 공정표 코드가 있는 객체 {c.overwriteCodes}개 — 개략 IPS 코드로 바꾸면 기존(현장 IPS) 연결이 끊깁니다.
            현장 IPS 가 있으면 그 P6 를 5단계에 올려 확정 공정표로 쓰고 6단계 연결을 다시 하세요.</p>
        )}
        {withDates && confirmed.kind === 'draft' && c.overwriteDates > 0 && (
          <p className="sim-warn">모델에 이미 계획일이 있는 객체 {c.overwriteDates}개의 날짜가 개략 IPS 날짜로 바뀝니다 — 현장 일정을 덮어쓰지 않으려면 날짜 칸을 끄세요.</p>
        )}
      </section>

      <section className="sim-step__block">
        <h4>모델과 비교 · 반영 확인</h4>
        <div className="sim-form sim-form--inline">
          <label>모델
            <select value={modelId} onChange={e => setModelId(e.target.value)}>
              {models.map(m => <option key={m.accItemId} value={m.accItemId}>{m.name}</option>)}
            </select>
          </label>
          <button className="btn btn--sm btn--primary" disabled={!!loading} onClick={() => void compare()}>{objects?.id === modelId ? '다시 확인' : '모델 현재 값 읽기(비교·반영 확인)'}</button>
          {loading && <span className="muted">{loading}</span>}
        </div>
        {objects?.id === modelId ? (
          <p>
            <span className="sim-sev is-warn">바뀔 것 {c.change}(코드 {c.code}{withDates ? ` · 날짜 ${c.dates}` : ''})</span>{' '}
            <span className="sim-sev is-info">같음 {c.same}</span>{' '}
            {c.missing > 0 && <span className="sim-sev is-error">모델에 없음 {c.missing}</span>}
            {c.change === 0 && c.missing === 0 && c.total > 0 && <strong className="sim-ok"> 모두 반영됨</strong>}
          </p>
        ) : (
          <p className="muted">비교 전에는 연결된 객체 전체를 내보냅니다. 원본 RVT 를 고르면 객체를 UniqueId 로 바로 찾습니다(IFC 로 연결했으면 IfcGUID 로).</p>
        )}
        {last && <p className="muted">마지막 확인: {last.at.slice(0, 16).replace('T', ' ')} · {last.modelName} · 같음 {last.same}/{last.rows}{last.missing ? ` · 모델에 없음 ${last.missing}` : ''}</p>}
      </section>

      <section className="sim-step__block">
        <h4>내려받기와 적용</h4>
        <div className="sim-step__actions">
          <button className="btn btn--sm btn--primary" disabled={!exportRows(true).length}
            onClick={() => download(syncCsv(exportRows(true), withDates), `${base}${objects?.id === modelId ? '_changes' : ''}.csv`, 'text/csv;charset=utf-8')}>
            반영 CSV{objects?.id === modelId ? ` — 바뀐 것 ${exportRows(true).length}개` : ` — ${exportRows(true).length}개`}
          </button>
          {objects?.id === modelId && <button className="btn btn--sm" onClick={() => download(syncCsv(exportRows(false), withDates), `${base}_all.csv`, 'text/csv;charset=utf-8')}>전체 CSV</button>}
          <button className="btn btn--sm" onClick={() => download(DYNAMO_SCRIPT, 'MIR_model_sync_dynamo.py', 'text/x-python;charset=utf-8')}>Dynamo 스크립트</button>
        </div>
        <ol className="sim-list">
          <li>위 두 파일을 받습니다(CSV 는 엑셀로 열어 확인할 수 있습니다).</li>
          <li>Revit 에서 <strong>원본 RVT</strong> 를 열고 Dynamo → Python Script 노드(CPython3)에 스크립트를 붙여 넣은 뒤, IN[0] 에 File Path 노드로 CSV 를 연결해 실행합니다. 처음에는 사본으로 시험하세요.</li>
          <li>결과(넣은 객체·못 찾은 객체)를 확인하고 저장합니다.</li>
          <li>2단계 자료 준비의 BIM 모델 칸에서 <strong>같은 이름으로 다시 올립니다</strong>(새 버전) → ACC 변환이 끝나면 여기서 「다시 확인」 — 모두 같으면 이 단계가 완료됩니다.</li>
        </ol>
        <p className="muted">IFC 만 고치면 원본과 따로 놀게 되므로 원본에 넣고, 성과품 IFC 는 원본에서 속성 세트를 포함해 다시 내보냅니다.</p>
      </section>

      <details className="sim-step__details" open={objects?.id === modelId && c.change > 0}>
        <summary>객체별 값 {rows.length.toLocaleString()}개{objects?.id === modelId && <> · <label onClick={e => e.stopPropagation()}><input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} /> 바뀐 것만</label></>}</summary>
        <div className="sim-table-wrap sim-table-wrap--tall">
          <table className="sim-table">
            <thead><tr><th>객체</th><th>A3 코드(새 값)</th>{withDates && <th>계획일(새 값)</th>}<th>작업</th><th>모델 현재</th><th>상태</th></tr></thead>
            <tbody>
              {rows.slice(0, 400).map(r => (
                <tr key={r.ifcGuid || r.uniqueId || r.code + r.name} className={r.status === 'change' ? 'is-critical' : ''}>
                  <td title={r.uniqueId || r.ifcGuid}>{r.name || (r.uniqueId || r.ifcGuid).slice(0, 12)}</td>
                  <td>{r.code}</td>
                  {withDates && <td>{r.start} ~ {r.finish}</td>}
                  <td>{r.activity}</td>
                  <td className="muted">{r.current ? `${r.current.code || '(빈 값)'}${withDates ? ` · ${r.current.start || '—'} ~ ${r.current.finish || '—'}` : ''}` : '—'}</td>
                  <td>{STATUS_LABEL[r.status]}{r.changes.length ? `(${r.changes.map(x => (x === 'code' ? '코드' : x === 'start' ? '시작' : '종료')).join('·')})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 400 && <p className="muted">처음 400개만 보입니다 — 전체는 CSV 로.</p>}
      </details>
    </div>
  );
}
