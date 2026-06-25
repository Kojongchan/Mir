import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clashesToCsv,
  downloadCsv,
  groupClashes,
  inheritStatuses,
  CLASH_STATUSES,
  CLASH_STATUS_LABEL,
  OPEN_CLASH_STATUSES,
  GROUP_BY_LABEL,
  SORT_BY_LABEL,
  type ClashRow,
  type ClashStatus,
  type ClashType,
  type ClashGroupBy,
  type ClashSortBy,
} from '../lib/clash';
import {
  listClashTests,
  saveApsClashTest,
  loadApsClashes,
  loadedApsToRows,
  deleteClashTest,
  setClashStatus,
  linkClashIssue,
  type ClashTestMeta,
} from '../lib/clashApi';
import { runApsClashDetection, targetKey, type ApsClashTarget, type ApsMetaResolver } from '../lib/apsClash';
import { showApsClash, clearApsClashView } from '../lib/apsClashView';
import { enumerateApsElements, groupByCategory, type ApsElement } from '../lib/apsElements';
import { createIssue, ISSUE_PRIORITIES, PRIORITY_LABEL, type IssuePriority } from '../lib/issues';
import type { ApsMapping } from '../lib/apsMapping';
import { useAuth } from '../auth/AuthProvider';

/** 간섭 대상으로 로드된 모델 한 개. */
export interface ClashModel {
  model: any;
  name: string;
  mapping: ApsMapping;
}

interface Props {
  viewer: any;
  models: ClashModel[];
  projectId: string;
  canEdit: boolean;
  /** ACC 폴더에서 비교할 파일을 더 겹쳐 로드(방법 2). */
  onAddModels?: () => void;
  onClose: () => void;
}

type SelRef = { modelId: number; cat: string }; // cat='all' = 모델 전체
const eqSel = (x: SelRef | null, y: SelRef | null) =>
  !!x && !!y && x.modelId === y.modelId && x.cat === y.cat;

/**
 * APS 간섭체크 — 모델간/모델내(카테고리) 간섭. 대상 A/B 를 **ACC 모델 트리처럼**
 * (모델 → 카테고리) 계층에서 고른다. ① 현재 열린(고정) 모델에서 바로, ② ACC 폴더에서
 * 비교 파일을 겹쳐 로드해 그 파일들끼리. 검출은 apsClash(fragment+BVH), 시각화는
 * apsClashView(A초록/B빨강+ghost+줌), 저장키는 GlobalId. 그룹/정렬/CSV 는 clash.ts 재사용.
 */
export function ApsClashPanel({ viewer, models, projectId, canEdit, onAddModels, onClose }: Props) {
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // 이동/크기 조절 창.
  const [win, setWin] = useState({ x: 80, y: 64, w: 520, h: 620 });
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      setWin((w) =>
        d.mode === 'move'
          ? { ...w, x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) }
          : { ...w, w: Math.max(360, d.ox + dx), h: Math.max(300, d.oy + dy) },
      );
    };
    const onUp = () => (dragRef.current = null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  const startDrag = (mode: 'move' | 'resize') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      ox: mode === 'move' ? win.x : win.w,
      oy: mode === 'move' ? win.y : win.h,
    };
  };

  // 모델별 요소(지연 열거 캐시) — 트리 카테고리/대상 해석에 사용.
  const elemCacheRef = useRef<Map<number, { elements: ApsElement[]; groups: Map<string, number[]> }>>(
    new Map(),
  );
  const ensureElements = async (cm: ClashModel) => {
    const id = cm.model.id as number;
    const cached = elemCacheRef.current.get(id);
    if (cached) return cached;
    const elements = await enumerateApsElements(cm.model);
    const v = { elements, groups: groupByCategory(elements) };
    elemCacheRef.current.set(id, v);
    return v;
  };

  // 트리 펼침/카테고리 표시.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [cats, setCats] = useState<Map<number, { name: string; count: number }[]>>(new Map());
  const [loadingModel, setLoadingModel] = useState<number | null>(null);
  const [filter, setFilter] = useState('');

  const modelsById = useMemo(() => {
    const m = new Map<number, ClashModel>();
    for (const cm of models) m.set(cm.model.id, cm);
    return m;
  }, [models]);

  const toggleModel = async (cm: ClashModel) => {
    const id = cm.model.id as number;
    const isOpen = expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!isOpen && !cats.has(id)) {
      setLoadingModel(id);
      try {
        const v = await ensureElements(cm);
        const list = [...v.groups.entries()]
          .map(([name, ids]) => ({ name, count: ids.length }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCats((prev) => new Map(prev).set(id, list));
      } catch {
        setCats((prev) => new Map(prev).set(id, []));
      } finally {
        setLoadingModel(null);
      }
    }
  };

  // 대상 선택.
  const [aSel, setASel] = useState<SelRef | null>(null);
  const [bSel, setBSel] = useState<SelRef | null>(null);
  const assign = (side: 'A' | 'B', ref: SelRef) => {
    if (side === 'A') setASel((cur) => (eqSel(cur, ref) ? null : ref));
    else setBSel((cur) => (eqSel(cur, ref) ? null : ref));
  };
  const selLabel = (sel: SelRef | null) => {
    if (!sel) return '미선택';
    const cm = modelsById.get(sel.modelId);
    const base = cm?.name ?? '모델';
    return sel.cat === 'all' ? `${base} · 전체` : `${base} · ${sel.cat}`;
  };

  const [type, setType] = useState<ClashType>('hard');
  const [tolerance, setTolerance] = useState(0.01);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ ratio: number; phase: string } | null>(null);
  const cancelRef = useRef(false);

  const [rows, setRows] = useState<ClashRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dbBacked, setDbBacked] = useState(false);
  const [status, setStatus] = useState('');

  const [groupBy, setGroupBy] = useState<ClashGroupBy>('none');
  const [sortBy, setSortBy] = useState<ClashSortBy>('index');
  const [statusFilter, setStatusFilter] = useState<Set<ClashStatus>>(new Set(CLASH_STATUSES));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [tests, setTests] = useState<ClashTestMeta[]>([]);
  const [selTest, setSelTest] = useState('');
  const [issueFor, setIssueFor] = useState<ClashRow | null>(null);

  useEffect(() => {
    listClashTests(projectId).then(setTests).catch(() => {});
    return () => clearApsClashView(viewer, models.map((m) => m.model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 선택 → 대상(모델,dbId) 목록 + 메타맵.
  const resolveTargets = async (sel: SelRef): Promise<ApsClashTarget[]> => {
    const cm = modelsById.get(sel.modelId);
    if (!cm) return [];
    const v = await ensureElements(cm);
    const dbIds = sel.cat === 'all' ? v.elements.map((e) => e.dbId) : v.groups.get(sel.cat) ?? [];
    return dbIds.map((dbId) => ({ model: cm.model, dbId }));
  };
  const buildMetaMap = async (sels: SelRef[]): Promise<ApsMetaResolver> => {
    const map: ApsMetaResolver = new Map();
    const seen = new Set<number>();
    for (const s of sels) {
      const cm = modelsById.get(s.modelId);
      if (!cm || seen.has(s.modelId)) continue;
      seen.add(s.modelId);
      const v = await ensureElements(cm);
      for (const e of v.elements) map.set(targetKey(cm.model.id, e.dbId), { name: e.name, category: e.category });
    }
    return map;
  };

  const run = async () => {
    if (running) return;
    if (!aSel || !bSel) {
      setStatus('대상 A·B 를 모두 선택하세요.');
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ ratio: 0, phase: '준비' });
    try {
      const [itemsA, itemsB, metaMap] = await Promise.all([
        resolveTargets(aSel),
        resolveTargets(bSel),
        buildMetaMap([aSel, bSel]),
      ]);
      if (!itemsA.length || !itemsB.length) {
        setStatus('대상 집합이 비어 있습니다.');
        return;
      }
      const hits = await runApsClashDetection({
        viewer,
        itemsA,
        itemsB,
        type,
        tolerance,
        metaMap,
        onProgress: (ratio, phase) => setProgress({ ratio, phase }),
        shouldCancel: () => cancelRef.current,
      });
      const next = inheritStatuses(hits, rows);
      const inherited = next.filter((r) => r.status !== 'new').length;
      setRows(next);
      setDbBacked(false);
      setSelTest('');
      setActiveId(null);
      setStatus(`간섭 ${next.length}건${inherited ? ` (상태 승계 ${inherited}건)` : ''}`);
    } catch (e) {
      setStatus(`검사 실패: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const onRowClick = (r: ClashRow) => {
    setActiveId(r.id);
    const aModel = modelsById.get(r.a.modelID)?.model;
    const bModel = modelsById.get(r.b.modelID)?.model;
    showApsClash(viewer, aModel, r.a.expressID, bModel, r.b.expressID);
  };

  const mappingsMap = useMemo(() => {
    const m = new Map<number, ApsMapping>();
    for (const cm of models) m.set(cm.model.id, cm.mapping);
    return m;
  }, [models]);

  const save = async () => {
    if (!rows.length) return;
    setStatus('저장 중…');
    try {
      const id = await saveApsClashTest({
        projectId,
        name: `간섭 ${new Date().toLocaleString('ko-KR')}`,
        setA: selLabel(aSel),
        setB: selLabel(bSel),
        type,
        tolerance,
        rows,
        mappings: mappingsMap,
      });
      setDbBacked(true);
      setSelTest(id);
      await listClashTests(projectId).then(setTests);
      setStatus('저장 완료');
    } catch (e) {
      setStatus(`저장 실패: ${(e as Error).message}`);
    }
  };

  const loadTest = async (testId: string) => {
    setSelTest(testId);
    if (!testId) return;
    setStatus('불러오는 중…');
    try {
      const loaded = await loadApsClashes(testId);
      setRows(loadedApsToRows(loaded, models.map((m) => m.mapping)));
      setDbBacked(true);
      setActiveId(null);
      setStatus(`불러옴 ${loaded.length}건`);
    } catch (e) {
      setStatus(`불러오기 실패: ${(e as Error).message}`);
    }
  };

  const removeTest = async (testId: string) => {
    if (!confirm('이 간섭 테스트를 삭제할까요?')) return;
    try {
      await deleteClashTest(testId);
      await listClashTests(projectId).then(setTests);
      if (selTest === testId) {
        setSelTest('');
        setRows([]);
        setDbBacked(false);
      }
    } catch (e) {
      setStatus(`삭제 실패: ${(e as Error).message}`);
    }
  };

  const changeStatus = async (r: ClashRow, s: ClashStatus) => {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: s } : x)));
    if (dbBacked) {
      try {
        await setClashStatus(r.id, s);
      } catch (e) {
        setStatus(`상태 저장 실패: ${(e as Error).message}`);
      }
    }
  };

  const [issueTitle, setIssueTitle] = useState('');
  const [issueDesc, setIssueDesc] = useState('');
  const [issuePriority, setIssuePriority] = useState<IssuePriority>('high');
  const openIssue = (r: ClashRow) => {
    setIssueFor(r);
    setIssueTitle(`간섭: ${r.a.name || r.a.category} ↔ ${r.b.name || r.b.category}`);
    setIssueDesc(
      `간섭 검출 (관통깊이 ${r.depth.toFixed(3)}m)\nA: ${r.a.name || r.a.category}\nB: ${r.b.name || r.b.category}`,
    );
    setIssuePriority('high');
  };
  const submitIssue = async () => {
    const r = issueFor;
    if (!r) return;
    const globalId = mappingsMap.get(r.a.modelID)?.dbIdToGlobalId.get(r.a.expressID) ?? null;
    try {
      const issueId = await createIssue(
        projectId,
        { title: issueTitle, description: issueDesc, priority: issuePriority, global_id: globalId },
        authorName,
      );
      if (dbBacked) {
        await linkClashIssue(r.id, issueId);
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, issueId } : x)));
      }
      setIssueFor(null);
      setStatus('이슈 생성됨');
    } catch (e) {
      setStatus(`이슈 생성 실패: ${(e as Error).message}`);
    }
  };

  const visibleRows = useMemo(() => rows.filter((r) => statusFilter.has(r.status)), [rows, statusFilter]);
  const grouped = useMemo(() => groupClashes(visibleRows, groupBy, sortBy), [visibleRows, groupBy, sortBy]);
  const openCount = rows.filter((r) => OPEN_CLASH_STATUSES.includes(r.status)).length;

  const toggleStatusFilter = (s: ClashStatus) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 트리 한 줄: [A][B] 토글 + 라벨.
  const ABButtons = (ref: SelRef) => (
    <span style={{ display: 'inline-flex', gap: 4, marginRight: 6 }}>
      <button
        onClick={() => assign('A', ref)}
        title="대상 A 로"
        style={{ ...abBtn, ...(eqSel(aSel, ref) ? abA : {}) }}
      >
        A
      </button>
      <button
        onClick={() => assign('B', ref)}
        title="대상 B 로"
        style={{ ...abBtn, ...(eqSel(bSel, ref) ? abB : {}) }}
      >
        B
      </button>
    </span>
  );

  let globalIdx = 0;

  return (
    <div
      className="clash-win"
      style={{
        position: 'fixed',
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        background: 'var(--panel)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 600,
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
      }}
    >
      <div
        onMouseDown={startDrag('move')}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'move' }}
      >
        <strong style={{ fontSize: 13 }}>🔍 간섭체크</strong>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {rows.length ? `총 ${rows.length} · 미해결 ${openCount}` : `모델 ${models.length}`}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={btn}>
          ✕
        </button>
      </div>

      <div style={{ padding: 10, overflowY: 'auto', flex: 1 }}>
        {/* 대상 트리(모델 → 카테고리) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong style={{ fontSize: 12 }}>대상 선택</strong>
          <span style={{ flex: 1 }} />
          {onAddModels && (
            <button onClick={onAddModels} style={{ ...btn, fontSize: 11 }} title="ACC 폴더에서 비교할 파일 겹쳐 로드">
              ＋ 파일 추가
            </button>
          )}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="카테고리 검색…"
          style={{ ...sel, marginTop: 6 }}
        />
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
          {models.map((cm) => {
            const id = cm.model.id as number;
            const open = expanded.has(id);
            const list = (cats.get(id) ?? []).filter(
              (c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()),
            );
            return (
              <div key={id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '4px 6px' }}>
                  <button onClick={() => void toggleModel(cm)} style={{ ...rowBtn, width: 16 }}>
                    {loadingModel === id ? '⏳' : open ? '▾' : '▸'}
                  </button>
                  {ABButtons({ modelId: id, cat: 'all' })}
                  <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    🧱 {cm.name}
                  </span>
                </div>
                {open &&
                  list.map((c) => (
                    <div key={c.name} style={{ display: 'flex', alignItems: 'center', padding: '2px 6px 2px 24px' }}>
                      {ABButtons({ modelId: id, cat: c.name })}
                      <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name} <span style={{ color: 'var(--muted)' }}>({c.count})</span>
                      </span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11 }}>
          <span>
            <b style={{ color: '#16a34a' }}>A</b> {selLabel(aSel)}
          </span>
          <span>
            <b style={{ color: '#dc2626' }}>B</b> {selLabel(bSel)}
          </span>
        </div>

        {/* 검사 옵션 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>유형</label>
            <select value={type} onChange={(e) => setType(e.target.value as ClashType)} style={sel}>
              <option value="hard">Hard(겹침)</option>
              <option value="clearance">Clearance(이격)</option>
            </select>
          </div>
          <div>
            <label style={lbl}>허용오차(m)</label>
            <input
              type="number"
              step="0.001"
              value={tolerance}
              onChange={(e) => setTolerance(Math.max(0, Number(e.target.value)))}
              style={{ ...sel, width: 90 }}
            />
          </div>
          <button onClick={() => void run()} disabled={running || !aSel || !bSel} style={{ ...btnPrimary, flex: 1 }}>
            {running ? '검사 중…' : '간섭 검사'}
          </button>
          {running && (
            <button onClick={() => (cancelRef.current = true)} style={btn}>
              중지
            </button>
          )}
        </div>
        {progress && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
            {progress.phase} · {Math.round(progress.ratio * 100)}%
          </div>
        )}

        {/* 저장/불러오기 */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
          {canEdit && (
            <button onClick={() => void save()} disabled={!rows.length} style={btn}>
              💾 저장
            </button>
          )}
          <select value={selTest} onChange={(e) => void loadTest(e.target.value)} style={{ ...sel, flex: 1 }}>
            <option value="">저장된 테스트…</option>
            {tests.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {canEdit && selTest && (
            <button onClick={() => void removeTest(selTest)} style={btn}>
              🗑
            </button>
          )}
          <button onClick={() => downloadCsv('clash.csv', clashesToCsv(rows))} disabled={!rows.length} style={btn}>
            CSV
          </button>
        </div>

        {/* 그룹/정렬/상태필터 */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as ClashGroupBy)} style={sel}>
              {(Object.keys(GROUP_BY_LABEL) as ClashGroupBy[]).map((k) => (
                <option key={k} value={k}>
                  묶음: {GROUP_BY_LABEL[k]}
                </option>
              ))}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as ClashSortBy)} style={sel}>
              {(Object.keys(SORT_BY_LABEL) as ClashSortBy[]).map((k) => (
                <option key={k} value={k}>
                  정렬: {SORT_BY_LABEL[k]}
                </option>
              ))}
            </select>
            {CLASH_STATUSES.map((s) => {
              const n = rows.filter((r) => r.status === s).length;
              const on = statusFilter.has(s);
              return (
                <button key={s} onClick={() => toggleStatusFilter(s)} style={{ ...chip, opacity: on ? 1 : 0.4 }}>
                  {CLASH_STATUS_LABEL[s]} {n}
                </button>
              );
            })}
          </div>
        )}

        {/* 결과 목록 */}
        <div style={{ marginTop: 10 }}>
          {grouped.map((g) => (
            <div key={g.key} style={{ marginBottom: 8 }}>
              {groupBy !== 'none' && (
                <button onClick={() => toggleCollapse(g.key)} style={groupHeader}>
                  {collapsed.has(g.key) ? '▸' : '▾'} {g.label} · 미해결 {g.open}/{g.rows.length}
                </button>
              )}
              {!collapsed.has(g.key) &&
                g.rows.map((r) => {
                  globalIdx += 1;
                  const idx = globalIdx;
                  const active = r.id === activeId;
                  return (
                    <div
                      key={r.id}
                      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginTop: 6, background: active ? 'var(--panel-2)' : 'transparent' }}
                    >
                      <div onClick={() => onRowClick(r)} style={{ cursor: 'pointer', fontSize: 12, display: 'flex', gap: 6 }}>
                        <span style={{ color: 'var(--muted)' }}>#{idx}</span>
                        <span style={{ flex: 1 }}>
                          <span style={{ color: '#16a34a' }}>A</span> {r.a.name || r.a.category}
                          {' ↔ '}
                          <span style={{ color: '#dc2626' }}>B</span> {r.b.name || r.b.category}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>{r.depth.toFixed(3)}m</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                        <select
                          value={r.status}
                          onChange={(e) => void changeStatus(r, e.target.value as ClashStatus)}
                          disabled={!canEdit}
                          style={{ ...sel, width: 'auto', fontSize: 11 }}
                        >
                          {CLASH_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {CLASH_STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                        {r.issueId ? (
                          <span style={{ fontSize: 11, color: 'var(--accent)' }}>이슈 연결됨</span>
                        ) : (
                          canEdit && (
                            <button onClick={() => openIssue(r)} style={{ ...btn, fontSize: 11 }}>
                              이슈 생성
                            </button>
                          )
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>{status}</div>
      </div>

      {issueFor && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, width: '88%' }}>
            <strong style={{ fontSize: 13 }}>간섭 → 이슈</strong>
            <label style={lbl}>제목</label>
            <input value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} style={sel} />
            <label style={lbl}>내용</label>
            <textarea value={issueDesc} onChange={(e) => setIssueDesc(e.target.value)} style={{ ...sel, height: 80, resize: 'vertical' }} />
            <label style={lbl}>우선순위</label>
            <select value={issuePriority} onChange={(e) => setIssuePriority(e.target.value as IssuePriority)} style={sel}>
              {ISSUE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setIssueFor(null)} style={btn}>
                취소
              </button>
              <button onClick={() => void submitIssue()} disabled={!issueTitle.trim()} style={btnPrimary}>
                생성
              </button>
            </div>
          </div>
        </div>
      )}

      <div onMouseDown={startDrag('resize')} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize' }} />
    </div>
  );
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 6 };
const sel: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  borderRadius: 6,
  marginTop: 2,
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
};
const btn: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid var(--accent)' };
const chip: React.CSSProperties = { ...btn, fontSize: 11, padding: '2px 8px' };
const rowBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 };
const abBtn: React.CSSProperties = {
  width: 18,
  height: 18,
  fontSize: 10,
  fontWeight: 700,
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  cursor: 'pointer',
  lineHeight: '16px',
  padding: 0,
};
const abA: React.CSSProperties = { background: '#16a34a', color: '#fff', border: '1px solid #16a34a' };
const abB: React.CSSProperties = { background: '#dc2626', color: '#fff', border: '1px solid #dc2626' };
const groupHeader: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '4px 6px',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
};
