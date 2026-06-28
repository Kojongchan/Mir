import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  readCsv,
  buildSchedule,
  formatDate,
  TASK_KIND_LABEL,
  DAY,
  type ScheduleTask,
  type ScheduleSource,
  type CsvDoc,
  type ColumnMap,
} from '../lib/schedule';
import {
  mapByName,
  mapSequential,
  mappingStats,
  computeStates,
  type TaskMapping,
  type ElementRef,
  type FourDViewer,
} from '../lib/fourd';
import {
  listSchedules,
  saveSchedule,
  saveApsSchedule,
  loadSchedule,
  deleteSchedule,
  saveActiveSchedule,
  saveActiveApsSchedule,
  loadActiveSchedule,
  resolveApsTaskMapping,
  ACTIVE_SCHEDULE_NAME,
  type SavedScheduleMeta,
  type LoadedSchedule,
} from '../lib/scheduleApi';
import type { ApsMapping } from '../lib/apsMapping';
import {
  saveLocalApsSchedule,
  loadLocalApsSchedule,
  resolveLocalMapping,
} from '../lib/localSchedule';
import { useAuth } from '../auth/AuthProvider';
import { ColumnMapModal } from './ColumnMapModal';

interface Props {
  viewer: FourDViewer | null;
  projectId: string;
  /** 런타임 modelID → DB 모델 uuid (여러 모델을 동시에 로드 — 매핑 영속화·복원용). IFC 경로용. */
  modelIdMap: Map<number, string>;
  /**
   * APS(ACC) 모드: dbId 는 세션마다 휘발성이라 GlobalId 경로(task_elements.global_id)
   * 로 영속화한다(S50). 지정 시 이름/순서 매핑 UI 는 숨기고(속성 매핑은 호출측 책임),
   * 저장/복원도 이 경로를 쓴다. null/undefined 면 기존 IFC express_id 경로 사용.
   */
  apsMode?: { modelDbId: string | null; apsMapping: ApsMapping | null } | null;
}

/**
 * 하단 4D 타임라인. 공정표 CSV(Navisworks/Fuzor)를 임포트(열 매핑 모달)하고,
 * 타임슬라이더로 현재 시점을 옮기면 그 시점의 시공 상태(시공/철거/임시)를 유형별
 * 색상·반투명으로 뷰어에 반영한다. 작업 테이블(헤더/열)과 간트를 함께 표시.
 */
export function Timeline({ viewer, projectId, modelIdMap, apsMode = null }: Props) {
  // DB 모델 uuid → 런타임 modelID (불러온 매핑을 현재 세션 모델로 재해석). IFC 경로용.
  const dbToRuntime = useMemo(() => {
    const m = new Map<string, number>();
    for (const [rid, db] of modelIdMap.entries()) m.set(db, rid);
    return m;
  }, [modelIdMap]);
  // 자동복원 트리거 키: IFC 경로는 모델이 모두 로드됐는지, APS 경로는 모델 미러행+
  // dbId↔GlobalId 매핑이 준비됐는지로 판단한다.
  const loadedKey = useMemo(() => [...modelIdMap.values()].sort().join('|'), [modelIdMap]);
  const restoreKey = apsMode
    ? apsMode.modelDbId && apsMode.apsMapping
      ? apsMode.modelDbId
      : ''
    : loadedKey;
  const fourd = useStore((s) => s.fourd);
  const setStatus = useStore((s) => s.setStatus);
  const selected = useStore((s) => s.selected);
  const isAdmin = !!useAuth().profile?.is_admin;
  const {
    enabled,
    tasks,
    source,
    rangeStart,
    rangeEnd,
    currentTime,
    appearance,
    mapping,
    mappedTasks,
    mappedElements,
  } = fourd;

  const fileInput = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  // 패널 높이(드래그로 위아래 조절 — 사용자 요청). localStorage 에 기억.
  const [panelH, setPanelH] = useState(() => {
    const v = Number(localStorage.getItem('tl-panel-h'));
    return v >= 160 && v <= 900 ? v : 340;
  });
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    resizeRef.current = { startY: e.clientY, startH: panelH };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const st = resizeRef.current;
    if (!st) return;
    // 위로 드래그(클라이언트 Y 감소)하면 높이 증가.
    const next = Math.min(Math.max(st.startH + (st.startY - e.clientY), 160), window.innerHeight - 140);
    setPanelH(next);
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    try {
      localStorage.setItem('tl-panel-h', String(panelH));
    } catch {
      /* ignore */
    }
  };
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [showSettings, setShowSettings] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [pendingCsv, setPendingCsv] = useState<CsvDoc | null>(null);
  const hasSchedule = tasks.length > 0;

  // 활성 슬롯에 즉시 저장(관리자, 모델 오픈 상태). 사용자 편집 직후 명시적으로 호출해
  // 프로그램적 복원(autoRestore)과의 경합을 피한다. fire-and-forget.
  const persistActive = (t: ScheduleTask[], m: TaskMapping, src: ScheduleSource = source ?? 'generic') => {
    if (!projectId || t.length === 0) return;
    if (apsMode) {
      // 로컬(브라우저) 영속화 — DB/관리자 권한·모델 로드와 무관하게 항상 저장해
      // 메뉴 이동·새로고침 후에도 임포트한 공정표가 프로젝트별로 유지된다(#3).
      saveLocalApsSchedule(projectId, t, src, m, apsMode.apsMapping);
      if (!isAdmin || !apsMode.modelDbId || !apsMode.apsMapping) return;
      void saveActiveApsSchedule({
        projectId,
        modelDbId: apsMode.modelDbId,
        apsMapping: apsMode.apsMapping,
        source: src,
        tasks: t,
        mapping: m,
      }).catch(() => {});
      return;
    }
    if (!isAdmin || modelIdMap.size === 0) return;
    void saveActiveSchedule({ projectId, modelIdMap, source: src, tasks: t, mapping: m }).catch(() => {});
  };

  // --- CSV 임포트(열 매핑 모달) ---
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const doc = readCsv(new Uint8Array(await file.arrayBuffer()));
      if (doc.rows.length === 0) {
        setStatus('빈 CSV 입니다.');
        return;
      }
      setPendingCsv(doc); // 모달 열기
    } catch (err) {
      setStatus(`CSV 읽기 실패: ${(err as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const confirmImport = (map: ColumnMap) => {
    if (!pendingCsv) return;
    const parsed = buildSchedule(pendingCsv, map);
    setPendingCsv(null);
    if (parsed.tasks.length === 0) {
      setStatus(`작업을 만들지 못했습니다: ${parsed.warnings.join(' ') || '유효한 행 없음'}`);
      return;
    }
    fourd.loadSchedule({
      tasks: parsed.tasks,
      source: parsed.source,
      start: parsed.start,
      end: parsed.end,
    });
    persistActive(parsed.tasks, {}, parsed.source);
    setStatus(
      `공정표 로드: ${parsed.tasks.length}개 작업 (${parsed.source})` +
        (parsed.warnings.length ? ` · ${parsed.warnings.join(' ')}` : ''),
    );
  };

  // --- 매핑 ---
  const runMapping = (mode: 'name' | 'sequential') => {
    if (!viewer || !hasSchedule) return;
    const catalog = viewer.getElementCatalog();
    if (catalog.length === 0) {
      setStatus('매핑할 모델이 없습니다. 먼저 IFC 모델을 여세요.');
      return;
    }
    let result = mode === 'name' ? mapByName(tasks, catalog) : mapSequential(tasks, catalog);
    const stats = mappingStats(result);
    if (mode === 'name' && stats.elements < catalog.length * 0.05) {
      result = mapSequential(tasks, catalog);
      const seq = mappingStats(result);
      fourd.setMapping(result, seq.tasks, seq.elements);
      persistActive(tasks, result);
      setStatus(`이름 매핑이 적어 순서 기반으로 자동 배정: ${seq.tasks}작업 · ${seq.elements}객체`);
      return;
    }
    fourd.setMapping(result, stats.tasks, stats.elements);
    persistActive(tasks, result);
    setStatus(`${mode === 'name' ? '이름' : '순서'} 매핑: ${stats.tasks}작업 · ${stats.elements}객체`);
  };

  const selectedRef: ElementRef | null = selected
    ? { modelID: selected.modelID, expressID: selected.expressID }
    : null;

  const assignSelected = (taskId: string) => {
    if (!selectedRef) return;
    const existing = mapping[taskId] ?? [];
    if (existing.some((e) => e.modelID === selectedRef.modelID && e.expressID === selectedRef.expressID)) {
      setStatus('이미 이 작업에 매핑된 객체입니다.');
      return;
    }
    const next: TaskMapping = { ...mapping, [taskId]: [...existing, selectedRef] };
    const stats = mappingStats(next);
    fourd.setMapping(next, stats.tasks, stats.elements);
    persistActive(tasks, next);
    setStatus(`객체 #${selectedRef.expressID} → 작업에 매핑(총 ${stats.elements}개)`);
  };

  const clearTaskMapping = (taskId: string) => {
    if (!mapping[taskId]?.length) return;
    const next: TaskMapping = { ...mapping };
    delete next[taskId];
    const stats = mappingStats(next);
    fourd.setMapping(next, stats.tasks, stats.elements);
    persistActive(tasks, next);
    setStatus('작업의 매핑을 비웠습니다.');
  };

  // --- DB 저장/로드 ---
  const [saved, setSaved] = useState<SavedScheduleMeta[]>([]);
  const [savedId, setSavedId] = useState<string>('');
  const [dbBusy, setDbBusy] = useState(false);

  const refreshSaved = async () => {
    if (!projectId) return;
    try {
      const list = (await listSchedules(projectId)).filter((s) => s.name !== ACTIVE_SCHEDULE_NAME);
      setSaved(list);
      if (list.length && !list.some((s) => s.id === savedId)) setSavedId(list[0].id);
    } catch {
      /* 마이그레이션 미적용/권한 등 — 조용히 무시 */
    }
  };

  useEffect(() => {
    refreshSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onSave = async () => {
    if (!hasSchedule || !projectId) return;
    const name = window.prompt('저장할 일정 이름', `일정 ${new Date().toLocaleString()}`);
    if (!name) return;
    setDbBusy(true);
    try {
      if (apsMode) {
        await saveApsSchedule({
          projectId,
          modelDbId: apsMode.modelDbId,
          apsMapping: apsMode.apsMapping ?? { model: null, dbIdToGlobalId: new Map(), globalIdToDbId: new Map(), size: 0 },
          name,
          source: source ?? 'generic',
          tasks,
          mapping,
        });
        setStatus(`일정 저장 완료: ${name}${apsMode.modelDbId ? '' : ' (모델 매핑 제외 — 모델 미오픈)'}`);
      } else {
        await saveSchedule({ projectId, modelIdMap, name, source: source ?? 'generic', tasks, mapping });
        setStatus(`일정 저장 완료: ${name}${modelIdMap.size ? '' : ' (모델 매핑 제외 — 모델 미오픈)'}`);
      }
      await refreshSaved();
    } catch (e) {
      setStatus(`일정 저장 실패: ${(e as Error).message}`);
    } finally {
      setDbBusy(false);
    }
  };

  // 불러온 일정(LoadedSchedule)의 요소 매핑을 현재 세션 기준 TaskMapping 으로 해석.
  // IFC 경로는 modelIdMap(express_id), APS 경로는 apsMode(global_id)로 분기.
  const resolveLoadedMapping = (ls: LoadedSchedule): { mapping: TaskMapping; resolved: number; unresolved: number } => {
    if (apsMode) {
      if (!apsMode.modelDbId || !apsMode.apsMapping) return { mapping: {}, resolved: 0, unresolved: 0 };
      // 뷰어가 객체를 거르는 modelID = model.id 와 일치시킨다(0 이 아니라).
      const runtimeModelId = (apsMode.apsMapping.model as { id?: number } | null)?.id ?? 0;
      const mapping = resolveApsTaskMapping(ls, new Map([[apsMode.modelDbId, { runtimeModelId, mapping: apsMode.apsMapping }]]));
      const resolved = Object.values(mapping).reduce((n, refs) => n + refs.length, 0);
      const total = Object.values(ls.globalElements).reduce((n, refs) => n + refs.length, 0);
      return { mapping, resolved, unresolved: total - resolved };
    }
    const nextMapping: TaskMapping = {};
    let resolved = 0;
    let unresolved = 0;
    for (const [taskId, els] of Object.entries(ls.elements)) {
      for (const el of els) {
        const runtime = dbToRuntime.get(el.modelDbId);
        if (runtime != null) {
          (nextMapping[taskId] ??= []).push({ modelID: runtime, expressID: el.expressID });
          resolved++;
        } else {
          unresolved++;
        }
      }
    }
    return { mapping: nextMapping, resolved, unresolved };
  };

  const onLoad = async () => {
    if (!savedId) return;
    setDbBusy(true);
    try {
      const ls = await loadSchedule(savedId);
      if (ls.tasks.length === 0) {
        setStatus('불러온 일정에 작업이 없습니다.');
        return;
      }
      const starts = ls.tasks.map((t) => t.start);
      const ends = ls.tasks.map((t) => t.end);
      fourd.loadSchedule({
        tasks: ls.tasks,
        source: ls.meta.source,
        start: Math.min(...starts),
        end: Math.max(...ends),
      });
      const { mapping: nextMapping, resolved, unresolved } = resolveLoadedMapping(ls);
      const stats = mappingStats(nextMapping);
      fourd.setMapping(nextMapping, stats.tasks, stats.elements);
      setStatus(
        `일정 불러옴: ${ls.meta.name} · ${ls.tasks.length}작업 · 매핑 ${resolved}개` +
          (unresolved ? ` (다른 모델 ${unresolved}개 제외)` : ''),
      );
    } catch (e) {
      setStatus(`일정 불러오기 실패: ${(e as Error).message}`);
    } finally {
      setDbBusy(false);
    }
  };

  // --- 활성 일정 자동 복원 (수동 저장 없이 유지) ---
  // 저장은 persistActive 로 사용자 편집 시 즉시 이뤄지고, 여기서는 모델이 열릴 때
  // DB 활성 슬롯을 불러와 현재 세션 기준으로 매핑을 다시 해석한다.
  const autoRestoredRef = useRef<string | null>(null);

  // 로컬(브라우저) 저장본 복원 — DB 가 비었거나 실패했을 때의 폴백(APS 전용).
  const restoreFromLocal = (): boolean => {
    if (!apsMode) return false;
    const local = loadLocalApsSchedule(projectId);
    if (!local || local.tasks.length === 0) return false;
    const starts = local.tasks.map((t) => t.start);
    const ends = local.tasks.map((t) => t.end);
    fourd.loadSchedule({
      tasks: local.tasks,
      source: local.source,
      start: Math.min(...starts),
      end: Math.max(...ends),
    });
    const runtimeModelId = (apsMode.apsMapping?.model as { id?: number } | null)?.id ?? 0;
    const mapping = resolveLocalMapping(local, apsMode.apsMapping ?? null, runtimeModelId);
    const stats = mappingStats(mapping);
    fourd.setMapping(mapping, stats.tasks, stats.elements);
    setStatus(`공정표 복원(로컬): ${local.tasks.length}작업 · 매핑 ${stats.elements}객체`);
    return true;
  };

  const autoRestore = async () => {
    try {
      const ls = await loadActiveSchedule(projectId);
      if (ls && ls.tasks.length > 0) {
        const starts = ls.tasks.map((t) => t.start);
        const ends = ls.tasks.map((t) => t.end);
        fourd.loadSchedule({
          tasks: ls.tasks,
          source: ls.meta.source,
          start: Math.min(...starts),
          end: Math.max(...ends),
        });
        const { mapping: nextMapping } = resolveLoadedMapping(ls);
        const stats = mappingStats(nextMapping);
        fourd.setMapping(nextMapping, stats.tasks, stats.elements);
        setStatus(`공정표 자동 복원: ${ls.tasks.length}작업 · 매핑 ${stats.elements}객체`);
        return;
      }
    } catch {
      /* 마이그레이션 미적용/권한 — 로컬 폴백으로 진행 */
    }
    // DB 에 없으면 로컬 저장본으로 폴백. 그것도 없으면 잔여 상태를 비운다.
    if (!restoreFromLocal()) fourd.clearSchedule();
  };

  // 프로젝트가 바뀌면 전역 4D store 에 남은 이전 프로젝트의 공정표/매핑을 비우고,
  // 활성 슬롯 복원이 새 프로젝트 기준으로 다시 일어나도록 한다(store 는 전역이라 필요).
  useEffect(() => {
    autoRestoredRef.current = null;
    fourd.clearSchedule();
    void autoRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 모델이 모두 로드되면(모드별 일괄 로드) 활성 슬롯을 1회 복원한다. 런타임 modelID 는
  // 로드 때마다 달라지므로 DB(model_id+expressID)에서 다시 해석해 매핑을 되살린다.
  useEffect(() => {
    if (!restoreKey) return;
    if (autoRestoredRef.current === restoreKey) return;
    autoRestoredRef.current = restoreKey;
    void autoRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreKey]);

  const onDelete = async () => {
    if (!savedId) return;
    const meta = saved.find((s) => s.id === savedId);
    if (!window.confirm(`"${meta?.name ?? savedId}" 일정을 삭제할까요?`)) return;
    setDbBusy(true);
    try {
      await deleteSchedule(savedId);
      setStatus('일정 삭제 완료');
      setSavedId('');
      await refreshSaved();
    } catch (e) {
      setStatus(`일정 삭제 실패: ${(e as Error).message}`);
    } finally {
      setDbBusy(false);
    }
  };

  // --- 시점/표시 변경 → 뷰어 반영 ---
  useEffect(() => {
    if (!viewer) return;
    if (!enabled || !hasSchedule || Number.isNaN(currentTime)) {
      viewer.clearConstruction();
      return;
    }
    const states = computeStates(tasks, mapping, currentTime);
    viewer.applyConstruction(
      [...states.values()].map((v) => ({ ...v.ref, state: v.state })),
      appearance,
    );
  }, [viewer, enabled, hasSchedule, tasks, mapping, currentTime, appearance]);

  // --- 재생 ---
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (!playing || !hasSchedule) return;
    const id = window.setInterval(() => {
      const next = currentTimeRef.current + speed * DAY;
      if (next >= rangeEnd) {
        fourd.setCurrentTime(rangeEnd);
        setPlaying(false);
      } else {
        fourd.setCurrentTime(next);
      }
    }, 120);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, rangeEnd, hasSchedule]);

  const totalDays = useMemo(
    () => (hasSchedule ? Math.max(1, Math.round((rangeEnd - rangeStart) / DAY)) : 1),
    [hasSchedule, rangeStart, rangeEnd],
  );
  const curDay = hasSchedule ? Math.round((currentTime - rangeStart) / DAY) : 0;

  if (collapsed) {
    return (
      <div className="timeline collapsed">
        <button className="tl-toggle" onClick={() => setCollapsed(false)}>
          ▴ 4D 타임라인
        </button>
        {hasSchedule && <span className="muted">{formatDate(currentTime)}</span>}
      </div>
    );
  }

  return (
    <div className="timeline" style={{ height: panelH }}>
      <div
        className="tl-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        title="드래그하여 높이 조절"
      />
      <div className="tl-controls">
        <button className="tl-toggle" onClick={() => setCollapsed(true)}>
          ▾
        </button>
        <input ref={fileInput} type="file" accept=".csv" hidden onChange={onPickFile} />
        <button onClick={() => fileInput.current?.click()}>공정표 임포트</button>

        {hasSchedule && (
          <>
            <label className="tl-check">
              <input type="checkbox" checked={enabled} onChange={(e) => fourd.setEnabled(e.target.checked)} />
              4D
            </label>
            <span className="tl-divider" />
            {!apsMode && (
              <>
                <button onClick={() => runMapping('name')}>이름 매핑</button>
                <button onClick={() => runMapping('sequential')}>순서 자동배정</button>
              </>
            )}
            <span className="muted tl-stats">
              {mappedTasks > 0 ? `${mappedTasks}작업/${mappedElements}객체` : '미매핑'}
            </span>
            <span className="tl-divider" />
            <button onClick={() => setPlaying((p) => !p)} disabled={!enabled}>
              {playing ? '⏸' : '▶'}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="재생 속도(일/틱)">
              <option value={1}>1×</option>
              <option value={3}>3×</option>
              <option value={7}>7×</option>
              <option value={30}>30×</option>
            </select>
            <button onClick={() => setShowSettings((v) => !v)} title="표시 설정">
              표시 ▾
            </button>
            <button onClick={() => setDetailed((v) => !v)} title="상세 열 표시">
              {detailed ? '기본 열' : '상세 열'}
            </button>
            <span className="spacer" />
            <span className="tl-date">{formatDate(currentTime)}</span>
            <span className="muted">
              D{curDay}/{totalDays} · {source}
            </span>
          </>
        )}

        {(hasSchedule || saved.length > 0) && projectId && (
          <>
            <span className="tl-divider" />
            {hasSchedule && (
              <button onClick={onSave} disabled={dbBusy} title="현재 일정+매핑을 DB에 저장">
                DB 저장
              </button>
            )}
            {saved.length > 0 && (
              <>
                <select value={savedId} onChange={(e) => setSavedId(e.target.value)} title="저장된 일정">
                  {saved.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button onClick={onLoad} disabled={dbBusy || !savedId}>
                  불러오기
                </button>
                <button onClick={onDelete} disabled={dbBusy || !savedId} title="선택 일정 삭제">
                  삭제
                </button>
              </>
            )}
          </>
        )}
      </div>

      {hasSchedule && showSettings && <AppearancePanel />}

      {hasSchedule ? (
        <>
          <input
            className="tl-slider"
            type="range"
            min={rangeStart}
            max={rangeEnd}
            step={DAY}
            value={Number.isNaN(currentTime) ? rangeStart : currentTime}
            onChange={(e) => fourd.setCurrentTime(Number(e.target.value))}
          />
          <TaskTable
            tasks={tasks}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            currentTime={currentTime}
            mapping={mapping}
            detailed={detailed}
            canAssign={!!selectedRef}
            onAssign={assignSelected}
            onClear={clearTaskMapping}
          />
        </>
      ) : (
        <div className="tl-empty muted">
          공정표 CSV(Navisworks/Fuzor)를 임포트하면 열 매핑 후 타임슬라이더로 시공 순서를 재생할 수 있습니다.
        </div>
      )}

      {pendingCsv && (
        <ColumnMapModal doc={pendingCsv} onConfirm={confirmImport} onCancel={() => setPendingCsv(null)} />
      )}
    </div>
  );
}

// --- 표시 설정 패널 ---

function AppearancePanel() {
  const appearance = useStore((s) => s.fourd.appearance);
  const setAppearance = useStore((s) => s.fourd.setAppearance);
  return (
    <div className="tl-settings">
      <label className="tl-check">
        진행 중 불투명도
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={appearance.activeOpacity}
          onChange={(e) => setAppearance({ activeOpacity: Number(e.target.value) })}
        />
        <span className="muted">{Math.round(appearance.activeOpacity * 100)}%</span>
      </label>
      <label className="tl-check">
        시공
        <input
          type="color"
          value={appearance.colorConstruct}
          onChange={(e) => setAppearance({ colorConstruct: e.target.value })}
        />
      </label>
      <label className="tl-check">
        철거
        <input
          type="color"
          value={appearance.colorDemolish}
          onChange={(e) => setAppearance({ colorDemolish: e.target.value })}
        />
      </label>
      <label className="tl-check">
        임시
        <input
          type="color"
          value={appearance.colorTemporary}
          onChange={(e) => setAppearance({ colorTemporary: e.target.value })}
        />
      </label>
      <label className="tl-check">
        빠른 시작(계획보다 앞당김)
        <input
          type="color"
          value={appearance.colorEarly}
          onChange={(e) => setAppearance({ colorEarly: e.target.value })}
        />
      </label>
      <label className="tl-check">
        늦은 시작(계획보다 지연)
        <input
          type="color"
          value={appearance.colorLate}
          onChange={(e) => setAppearance({ colorLate: e.target.value })}
        />
      </label>
      <label className="tl-check">
        <input
          type="checkbox"
          checked={appearance.ghostFuture}
          onChange={(e) => setAppearance({ ghostFuture: e.target.checked })}
        />
        미시공 반투명(ghost)
      </label>
      <div className="muted" style={{ fontSize: 11 }}>
        실제 시작(actualStart) 값이 있는 작업만 계획 대비 빠름/늦음으로 표시됩니다.
      </div>
    </div>
  );
}

// --- 작업 테이블(헤더/열) + 간트 ---

const NAME_W = 200;
type RowState = 'before' | 'active' | 'done';

function rowState(t: ScheduleTask, now: number): RowState {
  return now >= t.end ? 'done' : now >= t.start ? 'active' : 'before';
}
const STATE_LABEL: Record<RowState, string> = { before: '예정', active: '진행', done: '완료' };

function TaskTable({
  tasks,
  rangeStart,
  rangeEnd,
  currentTime,
  mapping,
  detailed,
  canAssign,
  onAssign,
  onClear,
}: {
  tasks: ScheduleTask[];
  rangeStart: number;
  rangeEnd: number;
  currentTime: number;
  mapping: TaskMapping;
  detailed: boolean;
  canAssign: boolean;
  onAssign: (taskId: string) => void;
  onClear: (taskId: string) => void;
}) {
  const span = Math.max(1, rangeEnd - rangeStart);
  // 메타 열 폭 합 = 간트 커서 좌측 오프셋
  const metaW = NAME_W + 60 + 56 + 92 + 92 + (detailed ? 92 + 92 + 96 : 0) + 56;
  const cursorPct = ((currentTime - rangeStart) / span) * 100;

  return (
    <div className="tl-table">
      <div className="tl-thead" style={{ ['--meta-w' as string]: `${metaW}px` }}>
        <div className="th" style={{ width: NAME_W }}>공정명</div>
        <div className="th" style={{ width: 60 }}>유형</div>
        <div className="th" style={{ width: 56 }}>상태</div>
        <div className="th" style={{ width: 92 }}>계획 시작</div>
        <div className="th" style={{ width: 92 }}>계획 끝</div>
        {detailed && <div className="th" style={{ width: 92 }}>실제 시작</div>}
        {detailed && <div className="th" style={{ width: 92 }}>실제 끝</div>}
        {detailed && <div className="th" style={{ width: 96 }}>비용</div>}
        <div className="th" style={{ width: 56 }}>맵핑</div>
        <div className="th th-gantt">간트</div>
      </div>

      <div className="tl-tbody">
        <div className="tl-cursor" style={{ left: `calc(${metaW}px + (100% - ${metaW}px) * ${cursorPct / 100})` }} />
        {tasks.map((t) => {
          const st = rowState(t, currentTime);
          const leftPct = ((t.start - rangeStart) / span) * 100;
          const widthPct = Math.max(0.5, ((t.end - t.start) / span) * 100);
          const count = mapping[t.id]?.length ?? 0;
          return (
            <div className="tr" key={t.id}>
              <div className="td td-name" style={{ width: NAME_W }} title={t.name}>
                {t.name}
              </div>
              <div className="td" style={{ width: 60 }}>
                <span className={`tl-kind tl-kind-${t.type}`}>{TASK_KIND_LABEL[t.type]}</span>
              </div>
              <div className="td" style={{ width: 56 }}>
                <span className={`tl-status tl-status-${st}`}>{STATE_LABEL[st]}</span>
              </div>
              <div className="td num" style={{ width: 92 }}>{formatDate(t.start)}</div>
              <div className="td num" style={{ width: 92 }}>{formatDate(t.end)}</div>
              {detailed && <div className="td num" style={{ width: 92 }}>{formatDate(t.actualStart)}</div>}
              {detailed && <div className="td num" style={{ width: 92 }}>{formatDate(t.actualEnd)}</div>}
              {detailed && (
                <div className="td num" style={{ width: 96 }}>
                  {t.cost != null ? t.cost.toLocaleString() : '—'}
                </div>
              )}
              <div className="td td-map" style={{ width: 56 }}>
                <button className="tl-mini" title="선택 객체를 이 작업에 매핑" disabled={!canAssign} onClick={() => onAssign(t.id)}>
                  ＋
                </button>
                <span
                  className={`tl-count${count ? '' : ' muted'}`}
                  role={count ? 'button' : undefined}
                  title={count ? '클릭 시 매핑 비우기' : '매핑된 객체 없음'}
                  onClick={() => count && onClear(t.id)}
                >
                  {count}
                </span>
              </div>
              <div className="td td-gantt">
                <div className={`tl-bar tl-bar-${st} tl-bar-${t.type}`} style={{ left: `${leftPct}%`, width: `${widthPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
