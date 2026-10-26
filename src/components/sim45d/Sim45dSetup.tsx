import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccFilePicker, type PickedAccFile } from '../AccFilePicker';
import { UiIcon } from '../icons/UiIcon';
import { accFileBlobUrl } from '../../lib/aps';
import { errMessage } from '../../lib/errors';
import {
  NEED_LABEL, STEPS, STRUCTURE_KIND_LABEL, acceptsFile, addFile, emptySetup, removeFile, setSkipped, slotDef, stepDef, stepStatus,
  type SetupData, type SlotDef, type SlotKey, type StepKey, type StructureKind,
} from '../../lib/sim45d/setup';
import { createSetup, deleteSetup, listSetups, saveSetup, type SetupRecord, type SetupWhere } from '../../lib/sim45d/setupStore';
import type { Sim45d } from './useSim45d';
import { DesignStep } from './steps/DesignStep';
import { DraftStep } from './steps/DraftStep';
import { LinkStep } from './steps/LinkStep';
import { P6Step } from './steps/P6Step';
import { ReportStep } from './steps/ReportStep';
import { ExportStep } from './steps/ExportStep';
import type { StepProps } from './steps/common';
import { McpConnect } from './McpConnect';
import { ClaudeAssistant } from './ClaudeAssistant';
import { AiConnectContext, claudeAsk, type AiConnect } from './steps/aiConnect';
import { openClaude } from '../../lib/claudePopup';
import { adoptedPlan, confirmedSource, NO_CONFIRMED, planXerBytes, planXerName } from '../../lib/sim45d/confirmed';
import { buildXer, readSchedule, type P6Schedule } from '../../lib/p6/schedule';
import { decodeXer, parseXer } from '../../lib/p6/xer';
import { fetchModelObjects } from '../../lib/sim45d/modelObjects';
import { actualsFromModel } from '../../lib/sim45d/modelActuals';
import { wbsScope } from '../../lib/sim45d/wbsScope';

/**
 * 「공정·공사비 (4D/5D)」 단계형 진행(D30): 위쪽 단계 바 + 3D 위에 펼치는 단계 시트.
 * 4D/5D 단계를 누르면 시트를 접고 3D(+하단 도크)를 본다 — 3D 는 내내 열려 있어 다시 불러오지 않는다.
 * 자료는 자료관리(ACC)에서 고르거나 그 자리에서 올린다(폴더 선택·새 폴더). 진행 상태는 대상별로 DB(0040)에.
 */
const UI_KEY = (projectId: string) => `mir.sim45d.setup-ui.${projectId}`;
type UiState = { setupId: string | null; step: StepKey };

function readUi(projectId: string): UiState | null {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY(projectId)) ?? 'null');
    return v && STEPS.some(s => s.key === v.step) ? { setupId: typeof v.setupId === 'string' ? v.setupId : null, step: v.step } : null;
  } catch { return null; }
}
function writeUi(projectId: string, ui: UiState) {
  try { localStorage.setItem(UI_KEY(projectId), JSON.stringify(ui)); } catch { /* 비공개 창 */ }
}

const FILE_GROUPS: { title: string; slots: SlotKey[] }[] = [
  { title: '설계 보고서·도면', slots: ['overview', 'plan', 'bridgeDesign', 'drawings'] },
  { title: '수량·내역', slots: ['qto', 'qtoSummary', 'boq'] },
  { title: 'BIM 모델', slots: ['model'] },
  { title: '기준 자료', slots: ['ipsStandard'] },
];

const fmtSize = (n: number | null) => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function Sim45dSetup({ projectId, canEdit, sim }: { projectId: string; canEdit: boolean; sim: Sim45d }) {
  const [records, setRecords] = useState<SetupRecord[]>([]);
  const [where, setWhere] = useState<SetupWhere>('db');
  const [loaded, setLoaded] = useState(false);
  const [ui, setUi] = useState<UiState>(() => readUi(projectId) ?? { setupId: null, step: 'target' });
  const [status, setStatus] = useState('');
  const [picker, setPicker] = useState<{ slot: SlotKey; upload: boolean } | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<StructureKind>('bridge');
  const [busy, setBusy] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  /** 다른 곳(다른 창·AI 연결)에서 바뀐 것을 다시 불러오면 올려 단계 화면을 새로 그린다. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    listSetups(projectId)
      .then(r => {
        if (!alive) return;
        setRecords(r.records);
        setWhere(r.where);
        setUi(u => {
          const keep = r.records.some(x => x.id === u.setupId) ? u.setupId : r.records[0]?.id ?? null;
          return { setupId: keep, step: keep ? u.step : 'target' };
        });
      })
      .catch(e => alive && setStatus(errMessage(e)))
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => { writeUi(projectId, ui); }, [projectId, ui]);

  // 창으로 돌아오거나 AI 도우미가 Claude 의 저장을 보면 다시 읽는다 — AI 연결(MCP)·다른 사람이 저장한 것이 보이게.
  // 내용이 같으면 그대로 둔다.
  const recordsRef = useRef(records);
  useEffect(() => { recordsRef.current = records; }, [records]);
  const refresh = useCallback(() => {
    listSetups(projectId).then(r => {
      const cur = recordsRef.current;
      const changed = r.records.length !== cur.length || r.records.some(x => cur.find(c => c.id === x.id)?.updatedAt !== x.updatedAt);
      if (!changed) return;
      setRecords(r.records);
      setReload(n => n + 1);
    }).catch(() => { /* 다음 기회에 */ });
  }, [projectId]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const rec = records.find(r => r.id === ui.setupId) ?? null;
  const data = rec?.data ?? emptySetup();
  const name = rec?.name ?? '';
  const sheetOpen = ui.step !== 'sim';
  const go = (step: StepKey) => setUi(u => ({ ...u, step }));

  // 단계 화면의 AI 버튼 → 내 Claude 창(팝업) + AI 도우미 패널(D32). 보기 권한만 있으면 넘기지 않는다(저장 못 함).
  const aiConnect = useMemo<AiConnect | null>(() => (canEdit ? {
    askClaude: (task, extra) => { openClaude(claudeAsk(task, name, extra)); setAssistOpen(true); },
    openConnect: () => setMcpOpen(true),
  } : null), [canEdit, name]);

  const persist = useCallback(async (next: SetupData) => {
    if (!rec) return;
    setRecords(rs => rs.map(r => (r.id === rec.id ? { ...r, data: next } : r)));
    try {
      const saved = await saveSetup(projectId, { ...rec, data: next }, where);
      setRecords(rs => rs.map(r => (r.id === saved.id ? saved : r)));
    } catch (e) {
      setStatus(`저장 실패: ${errMessage(e)}`);
    }
  }, [projectId, rec, where]);

  /** 고른(또는 한 번에 올린) 파일을 칸에 넣는다 — 한 번에 저장해야 여러 개가 서로를 덮어쓰지 않는다. */
  const onPick = (slot: SlotKey, files: PickedAccFile[]) => {
    setPicker(null);
    const def = slotDef(slot);
    const ok = files.filter(f => acceptsFile(slot, f.name));
    const wrong = files.filter(f => !acceptsFile(slot, f.name));
    if (!ok.length) { setStatus(`${def.label} 칸에 넣을 수 없는 형식입니다: ${wrong.map(f => f.name).join(', ')}`); return; }
    const take = def.multiple ? ok : ok.slice(-1);
    const pickedAt = new Date().toISOString();
    void persist(take.reduce((d, f) => addFile(d, slot, {
      accProjectId: f.accProjectId, accItemId: f.accItemId, name: f.name, folderNames: f.folderNames, size: f.size, pickedAt,
      ...(f.accUrn ? { urn: f.accUrn } : {}),
    }), data));
    setStatus([
      `${def.label}: ${take.map(f => f.name).join(', ')}`,
      ok.length > take.length ? `한 개만 넣는 칸이라 마지막 파일만 넣음(나머지는 자료관리에 있음)` : '',
      wrong.length ? `형식이 안 맞는 ${wrong.length}개는 자료관리에만 올라감` : '',
    ].filter(Boolean).join(' · '));
  };

  const create = async () => {
    const n = newName.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const r = await createSetup(projectId, n, { ...emptySetup(), kind: newKind }, where);
      setRecords(rs => [r, ...rs]);
      setUi({ setupId: r.id, step: 'files' });
      setNewName('');
      setStatus(`대상 추가: ${r.name}`);
    } catch (e) {
      setStatus(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: SetupRecord) => {
    if (!window.confirm(`'${r.name}' 진행 상태를 지울까요? (자료관리의 파일은 그대로 둡니다)`)) return;
    try {
      await deleteSetup(projectId, r.id, where);
      setRecords(rs => rs.filter(x => x.id !== r.id));
      setUi(u => (u.setupId === r.id ? { setupId: null, step: 'target' } : u));
    } catch (e) {
      setStatus(errMessage(e));
    }
  };

  // 6단계 연결은 4D 색칠에 쓴다(3D 뷰어가 화면 모델 객체로 찾음).
  const { setSavedLinks, setModelActuals } = sim;
  const allLinks = useMemo(() => (data.links ?? []).flatMap(l => l.links), [data.links]);
  useEffect(() => { setSavedLinks(allLinks); }, [allLinks, setSavedLinks]);

  /**
   * 모델의 현장 실적(A5 실시)을 연 공정표에 넣는다(3번 결정) — 모델 속성을 읽어(1~2초) 6단계 연결 → 모델 코드 → (개략 IPS 면) 규칙 연결로
   * 작업에 잇는다. 실패해도 공정표는 그대로 쓴다.
   */
  const loadActuals = async (d: SetupData, s: P6Schedule) => {
    const models = (d.files.model ?? []).filter(m => m.urn);
    if (!models.length) return;
    try {
      const objects = (await Promise.all(models.map(m => fetchModelObjects(m.urn!, () => {})))).flat();
      const top = s.wbs.find(w => !w.parentId);
      const rule = confirmedSource(d)?.kind === 'draft' && top ? wbsScope(s).under(top.id) : undefined;
      const m = actualsFromModel(objects, new Set(s.activities.map(a => a.code)), { links: (d.links ?? []).flatMap(l => l.links), rule });
      setModelActuals(m.byCode.size ? m : null);
      if (m.byCode.size) setStatus(st => `${st} · 모델 실적(A5 실시) ${m.byCode.size}개 작업에 반영(객체 ${m.linked}/${m.dated})`);
    } catch (e) {
      setStatus(st => `${st} · 모델 실적은 읽지 못함(${errMessage(e)})`);
    }
  };

  // 확정 공정표 열기: P6 수정본을 올렸으면 그것, 아니면 채택한 개략 IPS 를 지금 입력으로 다시 만들어 연다(D34). `next`: 방금 저장한 상태.
  const openP6 = async (next?: SetupData) => {
    const d = next ?? data;
    const f = d.files.p6?.[0];
    if (!f) {
      try {
        const r = adoptedPlan(d);
        if (!r || !d.plan?.adopted) { setStatus(NO_CONFIRMED); return; }
        const xer = planXerBytes(r);
        await sim.openXer(new File([xer as BlobPart], planXerName(d.site?.code, d.plan.adopted.title)));
        setStatus(`열었습니다: 채택한 개략 IPS(${d.plan.adopted.title}) — 아래 결과를 확인하세요. 3D 는 8 '4D/5D'.`);
        await loadActuals(d, readSchedule(buildXer(r.draft)));
      } catch (e) {
        setStatus(`공정표 만들기 실패: ${errMessage(e)}`);
      }
      return;
    }
    if (!/\.xer$/i.test(f.name)) { setStatus('P6 엑셀 내보내기 읽기는 준비 중입니다. 지금은 XER 파일로 열어 주세요.'); return; }
    setBusy(true);
    setStatus(`공정표 여는 중: ${f.name}`);
    let url = '';
    try {
      url = await accFileBlobUrl(f.accProjectId, f.accItemId);
      const blob = await (await fetch(url)).blob();
      await sim.openXer(new File([blob], f.name));
      // 시트를 접지 않는다 — 바로 아래에 검토 결과가 나온다(3D 는 '4D/5D' 단계에서).
      setStatus(`열었습니다: ${f.name} — 아래 검토 결과를 확인하세요. 3D 는 8 '4D/5D'.`);
      await loadActuals(d, readSchedule(parseXer(decodeXer(new Uint8Array(await blob.arrayBuffer())).text)));
    } catch (e) {
      setStatus(`공정표 열기 실패: ${errMessage(e)}`);
    } finally {
      if (url) URL.revokeObjectURL(url);
      setBusy(false);
    }
  };

  const statuses = useMemo(() => new Map(STEPS.map(s => [s.key, stepStatus(data, s.key, name)])), [data, name]);
  const idx = STEPS.findIndex(s => s.key === ui.step);
  const step = stepDef(ui.step);
  const cur = statuses.get(ui.step);
  // 이전·다음은 건너뛴 단계를 넘어간다(단계 바에서는 언제든 열 수 있음).
  const nextStep = STEPS.slice(idx + 1).find(s => statuses.get(s.key)?.state !== 'skipped');
  const prevStep = [...STEPS.slice(0, Math.max(0, idx))].reverse().find(s => statuses.get(s.key)?.state !== 'skipped');
  const skip = (steps: StepKey[], on: boolean) => void persist(setSkipped(data, steps, on));
  /** 진행 방식: 새로 만들기(3·4단계 진행) / 이미 짠 공정표로(3·4단계 건너뛰고 5단계에 올려 검토). */
  const existingPath = !!data.skipped?.includes('design') && !!data.skipped?.includes('draft');
  const choosePath = (existing: boolean) => {
    void persist(setSkipped(data, ['design', 'draft'], existing));
    setStatus(existing
      ? '이미 짠 공정표로 진행 — 자료(모델 등)를 고른 뒤 5단계 「P6 검토」에서 공정표(XER)를 올리면 AI 가 검토합니다. 3·4단계는 언제든 다시 할 수 있습니다.'
      : '새로 만들기 — 자료 → 설계현황 → 개략 IPS(안 채택 = 확정 공정표) 순서로 진행합니다.');
    go('files');
  };
  const needRecord = !rec && ui.step !== 'target' && ui.step !== 'sim';
  const editable = canEdit && !!rec;

  const slotCard = (def: SlotDef) => {
    const files = data.files[def.key] ?? [];
    return (
      <div key={def.key} className={`sim-setup__slot${files.length ? ' is-filled' : ''}`}>
        <div className="sim-setup__slot-head">
          <strong>{def.label}</strong>
          <span className={`sim-setup__need is-${def.need}`}>{NEED_LABEL[def.need]}</span>
          {def.multiple && <span className="muted sim-setup__multi">여러 개</span>}
        </div>
        <div className="muted sim-setup__hint">{def.hint}</div>
        <div className="muted sim-setup__ext">형식: {def.accept.join(', ')}</div>
        {files.length > 0 && (
          <ul className="sim-setup__files">
            {files.map(f => (
              <li key={f.accItemId}>
                <span className="sim-setup__fmeta">
                  <span className="sim-setup__fname" title={f.name}>{f.name}</span>
                  <span className="muted sim-setup__fpath" title={f.folderNames.join(' / ')}>{f.folderNames.join(' / ')}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}</span>
                </span>
                {editable && (
                  <button type="button" className="sim-setup__x" aria-label={`${f.name} 빼기`} title="이 칸에서 빼기(자료관리 파일은 그대로)"
                    onClick={() => void persist(removeFile(data, def.key, f.accItemId))}>✕</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="sim-setup__slot-actions">
          <button className="btn btn--sm" disabled={!editable} title={editable ? '자료관리에 있는 파일 고르기' : '실무자 이상만 바꿀 수 있습니다'}
            onClick={() => setPicker({ slot: def.key, upload: false })}>
            <UiIcon name="folder" size={14} /> 자료관리에서 선택
          </button>
          <button className="btn btn--sm" disabled={!editable} title={editable ? '폴더를 고르거나 새로 만들어 지금 올리기' : '실무자 이상만 올릴 수 있습니다'}
            onClick={() => setPicker({ slot: def.key, upload: true })}>
            ⬆ 지금 업로드
          </button>
          {!def.multiple && files.length > 0 && <span className="muted">다시 고르면 바뀝니다</span>}
        </div>
      </div>
    );
  };

  const needsList = (key: StepKey) => {
    const def = stepDef(key);
    if (!def.needs.length) return null;
    return (
      <ul className="sim-setup__needs">
        {def.needs.map(k => {
          const d = slotDef(k), ok = (data.files[k]?.length ?? 0) > 0;
          if (k === 'p6') { // 확정 공정표 = 채택한 개략 IPS 또는 P6 수정본(D34)
            const c = confirmedSource(data);
            return (
              <li key={k} className={c ? 'is-ok' : 'is-missing'}>
                <span aria-hidden>{c ? '✓' : '○'}</span> 확정 공정표 <span className="muted">({c ? c.label : '4단계에서 안 채택 또는 P6 수정본'})</span>
              </li>
            );
          }
          return (
            <li key={k} className={ok ? 'is-ok' : d.need === 'required' ? 'is-missing' : ''}>
              <span aria-hidden>{ok ? '✓' : '○'}</span> {d.label} <span className="muted">({NEED_LABEL[d.need]}{ok ? ` · ${data.files[k]!.length}개` : ''})</span>
            </li>
          );
        })}
      </ul>
    );
  };

  const stepProps: StepProps = {
    projectId, canEdit: editable, data, name, persist, sim, setStatus,
    renderSlot: k => slotCard(slotDef(k)),
    openP6: () => void openP6(), reopenP6: next => void openP6(next), opening: busy,
  };

  const body = () => {
    if (!loaded) return <p className="muted">불러오는 중…</p>;
    if (needRecord) {
      return (
        <div className="sim-setup__empty">
          <p>먼저 대상(구조물)을 고르거나 추가하세요.</p>
          <button className="btn btn--sm btn--primary" onClick={() => go('target')}>대상 선택으로</button>
        </div>
      );
    }
    switch (ui.step) {
      case 'target':
        return (
          <div className="sim-setup__target">
            {records.length > 0 && (
              <ul className="sim-setup__records" role="radiogroup" aria-label="대상">
                {records.map(r => (
                  <li key={r.id} className={r.id === ui.setupId ? 'is-current' : ''}>
                    <label>
                      <input type="radio" name="sim-setup-target" checked={r.id === ui.setupId} onChange={() => setUi(u => ({ ...u, setupId: r.id }))} />
                      <strong>{r.name}</strong>
                      <span className="muted">{STRUCTURE_KIND_LABEL[r.data.kind]} · 자료 {Object.values(r.data.files).reduce((n, l) => n + (l?.length ?? 0), 0)}개</span>
                    </label>
                    {canEdit && <button type="button" className="sim-setup__x" aria-label={`${r.name} 지우기`} title="진행 상태 지우기" onClick={() => void remove(r)}>✕</button>}
                  </li>
                ))}
              </ul>
            )}
            {canEdit ? (
              <form className="sim-setup__new" onSubmit={e => { e.preventDefault(); void create(); }}>
                <input value={newName} maxLength={80} placeholder="새 대상 이름 (예: 연제교 상선)" aria-label="새 대상 이름" onChange={e => setNewName(e.target.value)} />
                <select value={newKind} aria-label="구조물 종류" onChange={e => setNewKind(e.target.value as StructureKind)}>
                  <option value="bridge">교량</option>
                  <option value="tunnel" disabled>터널(준비 중)</option>
                  <option value="earthwork" disabled>토공(준비 중)</option>
                </select>
                <button type="submit" className="btn btn--sm btn--primary" disabled={!newName.trim() || busy}>＋ 대상 추가</button>
              </form>
            ) : (
              records.length === 0 && <p className="muted">아직 대상이 없습니다. 실무자 이상이 추가할 수 있습니다.</p>
            )}
            {rec && (
              <section className="sim-setup__paths" aria-label="진행 방식">
                <h4>진행 방식 — {rec.name}</h4>
                <div className="sim-cards" role="radiogroup" aria-label="진행 방식">
                  <button type="button" role="radio" aria-checked={!existingPath} className={`sim-card${!existingPath ? ' is-chosen' : ''}`} disabled={!canEdit} onClick={() => choosePath(false)}>
                    <strong>공정표 새로 만들기</strong>
                    <span className="muted">자료 → 설계현황 → 개략 IPS(안 채택 = 확정) → P6 검토 → BIM 연결</span>
                    <span className="muted">아직 공정표가 없을 때. 채택안을 P6 에서 고쳤을 때만 5단계에 올립니다.</span>
                  </button>
                  <button type="button" role="radio" aria-checked={existingPath} className={`sim-card${existingPath ? ' is-chosen' : ''}`} disabled={!canEdit} onClick={() => choosePath(true)}>
                    <strong>이미 짠 공정표로</strong>
                    <span className="muted">자료 → P6 공정표 올리기·AI 검토 → BIM 연결 (설계현황·개략 IPS 건너뜀)</span>
                    <span className="muted">사람이 짠 P6(XER)가 있을 때. 3·4단계는 나중에 언제든 할 수 있습니다.</span>
                  </button>
                </div>
              </section>
            )}
          </div>
        );
      case 'files':
        return (
          <div className="sim-setup__groups">
            {FILE_GROUPS.map(g => (
              <section key={g.title}>
                <h4>{g.title}</h4>
                <div className="sim-setup__slots">{g.slots.map(k => slotCard(slotDef(k)))}</div>
              </section>
            ))}
          </div>
        );
      case 'design': return <DesignStep key={`${rec?.id}:${reload}`} {...stepProps} />;
      case 'draft': return <DraftStep key={`${rec?.id}:${reload}`} {...stepProps} />;
      case 'p6': return <P6Step key={`${rec?.id}:${reload}`} {...stepProps} />;
      case 'link': return <LinkStep key={`${rec?.id}:${reload}`} {...stepProps} />;
      case 'export': return <ExportStep key={`${rec?.id}:${reload}`} {...stepProps} />;
      case 'report': return <ReportStep key={`${rec?.id}:${reload}`} {...stepProps} />;
      default: {
        const st = statuses.get(ui.step)!;
        return (
          <div className="sim-setup__planned">
            <p className="sim-setup__soon">이 단계 기능은 준비 중입니다. 지금은 필요한 자료가 갖춰졌는지만 확인합니다.</p>
            {needsList(ui.step)}
            {st.missing.length > 0 && (
              <button className="btn btn--sm" onClick={() => go(st.missing.some(m => m.step === 'p6') && !st.missing.some(m => m.step === 'files') ? 'p6' : 'files')}>
                빠진 자료 채우러 가기
              </button>
            )}
          </div>
        );
      }
    }
  };

  const pickerSlot = picker ? slotDef(picker.slot) : null;

  return (
    <>
      <nav className="sim-setup__bar" aria-label="공정·공사비 진행 단계">
        <button type="button" className="sim-setup__target-chip" onClick={() => go('target')} title="대상 바꾸기">
          {name || '대상 없음'} <UiIcon name="chevron-down" size={12} />
        </button>
        <ol className="sim-setup__steps">
          {STEPS.map((s, i) => {
            const st = statuses.get(s.key)!;
            return (
              <li key={s.key}>
                <button type="button" className={`sim-setup__step is-${st.state}${s.key === ui.step ? ' is-active' : ''}`}
                  aria-current={s.key === ui.step ? 'step' : undefined} onClick={() => go(s.key)}
                  title={`${i + 1}. ${s.title}${st.state === 'planned' ? ' (준비 중)' : st.state === 'done' ? ' (완료)' : st.state === 'skipped' ? ' (건너뜀)' : ''}`}>
                  <span className="sim-setup__num" aria-hidden>{st.state === 'done' ? '✓' : st.state === 'skipped' ? '–' : i + 1}</span>
                  <span className="sim-setup__label">{s.short}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {sheetOpen && (
        <section className="sim-setup__sheet" aria-label={`${idx + 1}. ${step.title}`}>
          <header className="sim-setup__head">
            <div>
              <h3>
                {idx + 1}. {step.title}{!step.built && <span className="sim-setup__badge">준비 중</span>}
                {cur?.state === 'skipped' && <span className="sim-setup__badge">건너뜀</span>}
              </h3>
              <p className="muted">{step.desc}</p>
              <p className="sim-setup__guide">
                {step.guide}
                {step.skippable && <span className="muted"> · 건너뛰어도 되는 경우: {step.skippable}.</span>}
              </p>
            </div>
            <span className="spacer" />
            {canEdit && (
              <button className={`btn btn--sm${assistOpen ? ' is-on' : ''}`} aria-pressed={assistOpen} onClick={() => setAssistOpen(o => !o)}
                title="내 Claude(각자 로그인·구독)로 이 단계 일을 시키고 진행을 봅니다">AI 도우미</button>
            )}
            <button className="btn btn--sm" onClick={() => go('sim')} title="시트를 접고 3D 보기"><UiIcon name="cube" size={14} /> 3D 보기</button>
          </header>
          {where === 'local' && (
            <div className="sim-setup__warn" role="status">
              DB 설정 전이라 진행 상태를 이 브라우저에만 저장합니다. 관리자가 Supabase 에서 <code>0040_sim45d_setup.sql</code> 을 실행하면 팀과 공유됩니다.
            </div>
          )}
          <div className="sim-setup__main">
            {assistOpen && canEdit && (
              <ClaudeAssistant mode="dock" projectId={projectId} target={name} step={ui.step} onSaved={refresh}
                onOpenConnect={() => setMcpOpen(true)} onClose={() => setAssistOpen(false)} />
            )}
            <AiConnectContext.Provider value={aiConnect}>
              <div className="sim-setup__body">{body()}</div>
            </AiConnectContext.Provider>
          </div>
          <footer className="sim-setup__foot">
            <button className="btn btn--sm" disabled={!prevStep} onClick={() => prevStep && go(prevStep.key)}>‹ 이전</button>
            <span className="muted sim-setup__status" aria-live="polite">{status}</span>
            {canEdit && rec && step.skippable && cur?.state !== 'done' && (cur?.state === 'skipped'
              ? <button className="btn btn--sm" onClick={() => skip([ui.step], false)} title="이 단계를 다시 진행할 단계로">건너뛰기 취소</button>
              : <button className="btn btn--sm" onClick={() => { skip([ui.step], true); if (nextStep) go(nextStep.key); }} title={`건너뛰어도 되는 경우: ${step.skippable}`}>건너뛰기 ›</button>)}
            <button className="btn btn--sm btn--primary" disabled={!nextStep} onClick={() => nextStep && go(nextStep.key)}>
              {nextStep ? `다음 · ${nextStep.short} ›` : '마지막 단계'}
            </button>
          </footer>
        </section>
      )}

      {assistOpen && canEdit && !sheetOpen && (
        <ClaudeAssistant mode="float" projectId={projectId} target={name} step={ui.step} onSaved={refresh}
          onOpenConnect={() => setMcpOpen(true)} onClose={() => setAssistOpen(false)} />
      )}
      {mcpOpen && <McpConnect projectId={projectId} onClose={() => setMcpOpen(false)} />}

      {picker && pickerSlot && (
        <AccFilePicker
          projectId={projectId}
          canEdit={canEdit}
          title={picker.upload ? `올릴 폴더 선택 — ${pickerSlot.label}` : `자료관리에서 선택 — ${pickerSlot.label}`}
          actionLabel="이 칸에 넣기"
          accept={n => acceptsFile(pickerSlot.key, n)}
          pickUploaded
          allowNewFolder
          hint={picker.upload
            ? `폴더를 열거나 '＋ 새 폴더' 로 만든 뒤 '⬆ 이 폴더에 업로드'(여러 개 선택 가능) 또는 파일을 이 창에 끌어놓기 — 올린 파일이 바로 이 칸에 들어갑니다. 형식: ${pickerSlot.accept.join(', ')}`
            : `형식: ${pickerSlot.accept.join(', ')} · 없으면 이 창에서 바로 올릴 수 있습니다(여러 개·끌어놓기).`}
          onPick={f => onPick(pickerSlot.key, [f])}
          onPickMany={fs => onPick(pickerSlot.key, fs)}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

