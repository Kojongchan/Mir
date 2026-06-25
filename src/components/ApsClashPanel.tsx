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
import { runApsClashDetection } from '../lib/apsClash';
import { showApsClash, clearApsClashView } from '../lib/apsClashView';
import { enumerateApsElements, elementMetaMap, groupByCategory, type ApsElement } from '../lib/apsElements';
import { createIssue, ISSUE_PRIORITIES, PRIORITY_LABEL, type IssuePriority } from '../lib/issues';
import type { ApsMapping } from '../lib/apsMapping';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  viewer: any;
  model: any;
  mapping: ApsMapping;
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
}

/**
 * APS 간섭체크 결과 — ClashPanel(IfcViewer)의 APS 판. 대상 A/B 를 카테고리로
 * 선택(모델 1개)하고 허용오차로 Hard/Clearance 간섭을 검출(apsClash). 행 클릭 시
 * A=초록/B=빨강 + 나머지 ghost + 줌(apsClashView). 결과는 GlobalId 로 저장/불러오기.
 * 간섭 → 이슈(GlobalId 앵커). 그룹화·정렬·상태필터·CSV 는 clash.ts 순수함수 재사용.
 */
export function ApsClashPanel({ viewer, model, mapping, projectId, canEdit, onClose }: Props) {
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // 이동/크기 조절 창(ClashPanel 과 동일 패턴).
  const [win, setWin] = useState({ x: 96, y: 72, w: 480, h: 560 });
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
          : { ...w, w: Math.max(340, d.ox + dx), h: Math.max(280, d.oy + dy) },
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

  // 요소/카테고리(집합 선택용).
  const [elements, setElements] = useState<ApsElement[]>([]);
  const [aCat, setACat] = useState('all');
  const [bCat, setBCat] = useState('all');
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

  const groups = useMemo(() => groupByCategory(elements), [elements]);
  const metaMap = useMemo(() => elementMetaMap(elements), [elements]);
  const catNames = useMemo(
    () => [...groups.keys()].sort((a, b) => a.localeCompare(b)),
    [groups],
  );

  // 모델 요소를 한 번 열거(이름·카테고리).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('요소 분석 중…');
      try {
        const els = await enumerateApsElements(model);
        if (!cancelled) {
          setElements(els);
          setStatus(`요소 ${els.length}개`);
        }
      } catch (e) {
        if (!cancelled) setStatus(`요소 분석 실패: ${(e as Error).message}`);
      }
    })();
    listClashTests(projectId).then(setTests).catch(() => {});
    return () => {
      cancelled = true;
      clearApsClashView(viewer, model);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dbIdsFor = (cat: string): number[] =>
    cat === 'all' ? elements.map((e) => e.dbId) : groups.get(cat) ?? [];

  const run = async () => {
    if (running) return;
    const A = dbIdsFor(aCat);
    const B = dbIdsFor(bCat);
    if (!A.length || !B.length) {
      setStatus('대상 집합이 비어 있습니다.');
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ ratio: 0, phase: '준비' });
    try {
      const hits = await runApsClashDetection({
        viewer,
        model,
        dbIdsA: A,
        dbIdsB: B,
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
      setStatus(
        `간섭 ${next.length}건${inherited ? ` (상태 승계 ${inherited}건)` : ''}`,
      );
    } catch (e) {
      setStatus(`검사 실패: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const onRowClick = (r: ClashRow) => {
    setActiveId(r.id);
    showApsClash(viewer, model, r.a.expressID, r.b.expressID);
  };

  const save = async () => {
    if (!rows.length) return;
    const name = `간섭 ${new Date().toLocaleString('ko-KR')}`;
    setStatus('저장 중…');
    try {
      const id = await saveApsClashTest({
        projectId,
        name,
        setA: aCat === 'all' ? '전체' : aCat,
        setB: bCat === 'all' ? '전체' : bCat,
        type,
        tolerance,
        rows,
        mapping,
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
      setRows(loadedApsToRows(loaded, mapping));
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

  // 간섭 → 이슈(요소 A 의 GlobalId 를 앵커로).
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
    const globalId = mapping.dbIdToGlobalId.get(r.a.expressID) ?? null;
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

  const visibleRows = useMemo(
    () => rows.filter((r) => statusFilter.has(r.status)),
    [rows, statusFilter],
  );
  const grouped = useMemo(
    () => groupClashes(visibleRows, groupBy, sortBy),
    [visibleRows, groupBy, sortBy],
  );
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
      {/* 헤더(드래그 이동) */}
      <div
        onMouseDown={startDrag('move')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          cursor: 'move',
        }}
      >
        <strong style={{ fontSize: 13 }}>🔍 간섭체크 (ACC)</strong>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {rows.length ? `총 ${rows.length} · 미해결 ${openCount}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={btn}>
          ✕
        </button>
      </div>

      <div style={{ padding: 10, overflowY: 'auto', flex: 1 }}>
        {/* 집합 선택(카테고리) */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={lbl}>대상 A</label>
            <select value={aCat} onChange={(e) => setACat(e.target.value)} style={sel}>
              <option value="all">전체 ({elements.length})</option>
              {catNames.map((c) => (
                <option key={c} value={c}>
                  {c} ({groups.get(c)?.length ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>대상 B</label>
            <select value={bCat} onChange={(e) => setBCat(e.target.value)} style={sel}>
              <option value="all">전체 ({elements.length})</option>
              {catNames.map((c) => (
                <option key={c} value={c}>
                  {c} ({groups.get(c)?.length ?? 0})
                </option>
              ))}
            </select>
          </div>
        </div>

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
          <button onClick={() => void run()} disabled={running} style={{ ...btnPrimary, flex: 1 }}>
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
                <button
                  key={s}
                  onClick={() => toggleStatusFilter(s)}
                  style={{ ...chip, opacity: on ? 1 : 0.4 }}
                >
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
                <button
                  onClick={() => toggleCollapse(g.key)}
                  style={{ ...groupHeader }}
                >
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
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: 8,
                        marginTop: 6,
                        background: active ? 'var(--panel-2)' : 'transparent',
                      }}
                    >
                      <div
                        onClick={() => onRowClick(r)}
                        style={{ cursor: 'pointer', fontSize: 12, display: 'flex', gap: 6 }}
                      >
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

      {/* 간섭 → 이슈 모달 */}
      {issueFor && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
          }}
        >
          <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, width: '88%' }}>
            <strong style={{ fontSize: 13 }}>간섭 → 이슈</strong>
            <label style={lbl}>제목</label>
            <input value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} style={sel} />
            <label style={lbl}>내용</label>
            <textarea
              value={issueDesc}
              onChange={(e) => setIssueDesc(e.target.value)}
              style={{ ...sel, height: 80, resize: 'vertical' }}
            />
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

      {/* 크기조절 핸들 */}
      <div
        onMouseDown={startDrag('resize')}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize' }}
      />
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
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  border: '1px solid var(--accent)',
};
const chip: React.CSSProperties = {
  ...btn,
  fontSize: 11,
  padding: '2px 8px',
};
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
