import { useEffect, useMemo, useRef, useState } from 'react';
import type { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import {
  decodeCsvBytes,
  parseSchedule,
  formatDate,
  TASK_KIND_LABEL,
  DAY,
  type ScheduleTask,
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
  type SavedScheduleMeta,
} from '../lib/scheduleApi';

interface Props {
  viewer: IfcViewer | null;
  projectId: string;
  modelDbId: string | null;
}

/**
 * 하단 4D 타임라인. 공정표 CSV(Navisworks/Fuzor)를 임포트하고, 타임슬라이더로
 * 현재 시점을 옮기면 그 시점까지 시공된 객체만 보이도록 뷰어를 제어한다.
 * 뷰어의 getElementCatalog/applyConstruction/clearConstruction 헬퍼를 사용한다.
 */
export function Timeline({ viewer, projectId, modelDbId }: Props) {
  const fourd = useStore((s) => s.fourd);
  const setStatus = useStore((s) => s.setStatus);
  const selected = useStore((s) => s.selected);
  const {
    enabled,
    tasks,
    source,
    rangeStart,
    rangeEnd,
    currentTime,
    futureMode,
    mapping,
    mappedTasks,
    mappedElements,
  } = fourd;

  const fileInput = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3); // days per animation frame-step
  const hasSchedule = tasks.length > 0;

  // --- CSV 임포트 ---
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = decodeCsvBytes(bytes);
      const parsed = parseSchedule(text);
      if (parsed.tasks.length === 0) {
        setStatus(`공정표를 읽지 못했습니다: ${parsed.warnings.join(' ') || '유효한 작업 없음'}`);
        return;
      }
      fourd.loadSchedule({
        tasks: parsed.tasks,
        source: parsed.source,
        start: parsed.start,
        end: parsed.end,
      });
      setStatus(
        `공정표 로드: ${parsed.tasks.length}개 작업 (${parsed.source})` +
          (parsed.warnings.length ? ` · ${parsed.warnings.join(' ')}` : ''),
      );
    } catch (err) {
      setStatus(`공정표 임포트 실패: ${(err as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
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
    // 이름 매핑이 거의 안 되면 순서 기반으로 폴백
    if (mode === 'name' && stats.elements < catalog.length * 0.05) {
      result = mapSequential(tasks, catalog);
      const seq = mappingStats(result);
      fourd.setMapping(result, seq.tasks, seq.elements);
      setStatus(
        `이름 매핑 결과가 적어 순서 기반으로 자동 배정: ${seq.tasks}개 작업 · ${seq.elements}개 객체`,
      );
      return;
    }
    fourd.setMapping(result, stats.tasks, stats.elements);
    setStatus(
      `${mode === 'name' ? '이름' : '순서'} 매핑: ${stats.tasks}개 작업 · ${stats.elements}개 객체`,
    );
  };

  // --- 수동 매핑: 현재 선택한 객체를 작업에 추가/제거 ---
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
    setStatus(`객체 #${selectedRef.expressID} → 작업에 매핑(총 ${stats.elements}개 객체)`);
  };

  const clearTaskMapping = (taskId: string) => {
    if (!mapping[taskId]?.length) return;
    const next: TaskMapping = { ...mapping };
    delete next[taskId];
    const stats = mappingStats(next);
    fourd.setMapping(next, stats.tasks, stats.elements);
    setStatus('작업의 매핑을 비웠습니다.');
  };

  // --- DB 저장/로드 ---
  const [saved, setSaved] = useState<SavedScheduleMeta[]>([]);
  const [savedId, setSavedId] = useState<string>('');
  const [dbBusy, setDbBusy] = useState(false);

  const refreshSaved = async () => {
    if (!projectId) return;
    try {
      const list = await listSchedules(projectId);
      setSaved(list);
      if (list.length && !list.some((s) => s.id === savedId)) setSavedId(list[0].id);
    } catch {
      /* 마이그레이션 미적용/권한 등 — 조용히 무시(저장 시 에러로 안내) */
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
      // (db model_id, expressID) → 런타임 modelID 변환(현재 활성 모델만).
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
          (unresolved ? ` (다른 모델 ${unresolved}개 제외 — 해당 모델을 여세요)` : ''),
      );
    } catch (e) {
      setStatus(`일정 불러오기 실패: ${(e as Error).message}`);
    } finally {
      setDbBusy(false);
    }
  };

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

  // --- 시점 변경 → 뷰어 반영 ---
  useEffect(() => {
    if (!viewer) return;
    if (!enabled || !hasSchedule || Number.isNaN(currentTime)) {
      viewer.clearConstruction();
      return;
    }
    const states = computeStates(tasks, mapping, currentTime);
    viewer.applyConstruction(
      [...states.values()].map((v) => ({ ...v.ref, state: v.state })),
      futureMode,
    );
  }, [viewer, enabled, hasSchedule, tasks, mapping, currentTime, futureMode]);

  // --- 재생(애니메이션) ---
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

  // 인터벌 콜백이 항상 최신 currentTime 을 읽도록 ref 동기화
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

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
        <input ref={fileInput} type="file" accept=".csv" hidden onChange={onImport} />
      </div>
    );
  }

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="tl-toggle" onClick={() => setCollapsed(true)}>
          ▾
        </button>
        <input ref={fileInput} type="file" accept=".csv" hidden onChange={onImport} />
        <button onClick={() => fileInput.current?.click()}>공정표 임포트</button>

        {hasSchedule && (
          <>
            <label className="tl-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => fourd.setEnabled(e.target.checked)}
              />
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
            <label className="tl-check">
              <input
                type="checkbox"
                checked={futureMode === 'ghost'}
                onChange={(e) => fourd.setFutureMode(e.target.checked ? 'ghost' : 'hidden')}
              />
              미시공 반투명
            </label>
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
                <select
                  value={savedId}
                  onChange={(e) => setSavedId(e.target.value)}
                  title="저장된 일정"
                >
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
          <Gantt
            tasks={tasks}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            currentTime={currentTime}
            mapping={mapping}
            canAssign={!!selectedRef}
            onAssign={assignSelected}
            onClear={clearTaskMapping}
          />
        </>
      ) : (
        <div className="tl-empty muted">
          공정표 CSV(Navisworks/Fuzor)를 임포트하면 타임슬라이더로 시공 순서를 재생할 수 있습니다.
        </div>
      )}
    </div>
  );
}

// --- 간트 차트 ---

function Gantt({
  tasks,
  rangeStart,
  rangeEnd,
  currentTime,
  mapping,
  canAssign,
  onAssign,
  onClear,
}: {
  tasks: ScheduleTask[];
  rangeStart: number;
  rangeEnd: number;
  currentTime: number;
  mapping: TaskMapping;
  canAssign: boolean;
  onAssign: (taskId: string) => void;
  onClear: (taskId: string) => void;
}) {
  const span = Math.max(1, rangeEnd - rangeStart);
  const cursorPct = ((currentTime - rangeStart) / span) * 100;

  return (
    <div className="tl-gantt">
      <div className="tl-cursor" style={{ left: `calc(200px + (100% - 200px) * ${cursorPct / 100})` }} />
      {tasks.map((t) => {
        const leftPct = ((t.start - rangeStart) / span) * 100;
        const widthPct = Math.max(0.5, ((t.end - t.start) / span) * 100);
        const state =
          currentTime >= t.end ? 'built' : currentTime >= t.start ? 'active' : 'future';
        const count = mapping[t.id]?.length ?? 0;
        return (
          <div className="tl-row" key={t.id}>
            <div className="tl-row-name" title={t.name}>
              <span className={`tl-kind tl-kind-${t.type}`}>{TASK_KIND_LABEL[t.type]}</span>
              <span className="tl-row-label">{t.name}</span>
            </div>
            <div className="tl-row-map">
              <button
                className="tl-mini"
                title="선택한 객체를 이 작업에 매핑"
                disabled={!canAssign}
                onClick={() => onAssign(t.id)}
              >
                ＋
              </button>
              <span
                className={`tl-count${count ? '' : ' muted'}`}
                title="이 작업에 매핑된 객체 수"
                role={count ? 'button' : undefined}
                onClick={() => count && onClear(t.id)}
              >
                {count}
              </span>
            </div>
            <div className="tl-track">
              <div
                className={`tl-bar tl-bar-${state}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
