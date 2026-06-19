import { useEffect, useMemo, useRef, useState } from 'react';
import type { IfcViewer } from '../viewer/IfcViewer';
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
} from '../lib/fourd';
import {
  listSchedules,
  saveSchedule,
  loadSchedule,
  deleteSchedule,
  saveActiveSchedule,
  loadActiveSchedule,
  ACTIVE_SCHEDULE_NAME,
  type SavedScheduleMeta,
} from '../lib/scheduleApi';
import { useAuth } from '../auth/AuthProvider';
import { ColumnMapModal } from './ColumnMapModal';

interface Props {
  viewer: IfcViewer | null;
  projectId: string;
  modelDbId: string | null;
}

/**
 * 하단 4D 타임라인. 공정표 CSV(Navisworks/Fuzor)를 임포트(열 매핑 모달)하고,
 * 타임슬라이더로 현재 시점을 옮기면 그 시점의 시공 상태(시공/철거/임시)를 유형별
 * 색상·반투명으로 뷰어에 반영한다. 작업 테이블(헤더/열)과 간트를 함께 표시.
 */
export function Timeline({ viewer, projectId, modelDbId }: Props) {
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
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [showSettings, setShowSettings] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [pendingCsv, setPendingCsv] = useState<CsvDoc | null>(null);
  const hasSchedule = tasks.length > 0;

  // 활성 슬롯에 즉시 저장(관리자, 모델 오픈 상태). 사용자 편집 직후 명시적으로 호출해
  // 프로그램적 복원(autoRestore)과의 경합을 피한다. fire-and-forget.
  const persistActive = (t: ScheduleTask[], m: TaskMapping, src: ScheduleSource = source ?? 'generic') => {
    if (!isAdmin || !projectId || !modelDbId || t.length === 0) return;
    void saveActiveSchedule({ projectId, modelDbId, source: src, tasks: t, mapping: m }).catch(() => {});
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
      await saveSchedule({ projectId, modelDbId, name, source: source ?? 'generic', tasks, mapping });
      setStatus(`일정 저장 완료: ${name}${modelDbId ? '' : ' (모델 매핑 제외 — 모델 미오픈)'}`);
      await refreshSaved();
    } catch (e) {
      setStatus(`일정 저장 실패: ${(e as Error).message}`);
    } finally {
      setDbBusy(false);
    }
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
      const runtime = viewer?.primaryModelID ?? null;
      const nextMapping: TaskMapping = {};
      let resolved = 0;
      let unresolved = 0;
      for (const [taskId, els] of Object.entries(ls.elements)) {
        for (const el of els) {
          if (runtime != null && el.modelDbId === modelDbId) {
            (nextMapping[taskId] ??= []).push({ modelID: runtime, expressID: el.expressID });
            resolved++;
          } else {
            unresolved++;
          }
        }
      }
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
  // DB 활성 슬롯을 불러와 런타임 modelID 로 매핑을 다시 해석한다.
  const autoRestoredRef = useRef<string | null>(null);

  const autoRestore = async () => {
    try {
      const ls = await loadActiveSchedule(projectId);
      if (!ls || ls.tasks.length === 0) {
        // 이 프로젝트엔 저장된 공정표가 없음 → 다른 프로젝트의 잔여 상태를 비운다.
        fourd.clearSchedule();
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
      const runtime = viewer?.primaryModelID ?? null;
      const nextMapping: TaskMapping = {};
      for (const [taskId, els] of Object.entries(ls.elements)) {
        for (const el of els) {
          if (runtime != null && el.modelDbId === modelDbId) {
            (nextMapping[taskId] ??= []).push({ modelID: runtime, expressID: el.expressID });
          }
        }
      }
      const stats = mappingStats(nextMapping);
      fourd.setMapping(nextMapping, stats.tasks, stats.elements);
      setStatus(`공정표 자동 복원: ${ls.tasks.length}작업 · 매핑 ${stats.elements}객체`);
    } catch {
      /* 마이그레이션 미적용/권한 — 조용히 무시 */
    }
  };

  // 프로젝트가 바뀌면 전역 4D store 에 남은 이전 프로젝트의 공정표/매핑을 비우고,
  // 활성 슬롯 복원이 새 프로젝트 기준으로 다시 일어나도록 한다(store 는 전역이라 필요).
  useEffect(() => {
    autoRestoredRef.current = null;
    fourd.clearSchedule();
    void autoRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 모델이 (자동/수동) 열릴 때마다 활성 슬롯을 1회 복원한다. 모델 재오픈 시 런타임
  // modelID 가 바뀌고 openModel 이 매핑을 비우므로, DB(model_id+expressID)에서 다시
  // 해석해 매핑을 되살린다 → 수동 저장/재매핑 없이 유지.
  useEffect(() => {
    if (!modelDbId) return;
    if (autoRestoredRef.current === modelDbId) return;
    autoRestoredRef.current = modelDbId;
    void autoRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelDbId]);

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
    <div className="timeline">
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
            <button onClick={() => runMapping('name')}>이름 매핑</button>
            <button onClick={() => runMapping('sequential')}>순서 자동배정</button>
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
        <input
          type="checkbox"
          checked={appearance.ghostFuture}
          onChange={(e) => setAppearance({ ghostFuture: e.target.checked })}
        />
        미시공 반투명(ghost)
      </label>
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
