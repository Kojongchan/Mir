import { useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { runApsClashDetection, targetKey, type ApsMetaResolver } from '../lib/apsClash';
import { showApsClash, showAllWithColors, showTranslucentClash, clearApsClashView } from '../lib/apsClashView';
import { rootChildren, childrenOf, collectLeaves, nodeName, parentName, type ApsTreeNode } from '../lib/apsTree';
import { ApsClashDim } from './ApsClashDim';
import { apsClashesToCsv, buildApsClashReport, downloadReport, captureClashAngles, dataUrlToFile } from '../lib/apsReport';
import { downloadCsv } from '../lib/clash';
import { uploadAttachment } from '../lib/attachments';
import { createIssue, ISSUE_PRIORITIES, PRIORITY_LABEL, type IssuePriority } from '../lib/issues';
import type { ApsMapping } from '../lib/apsMapping';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  viewer: any;
  /** 열린 통합모델(보통 nwd). 하나의 인스턴스 트리. */
  model: any;
  mapping: ApsMapping;
  projectId: string;
  projectName?: string;
  canEdit: boolean;
  onClose: () => void;
  /** 이슈 생성 시 부모(AccModels)의 이슈 목록·핀 갱신. */
  onIssueCreated?: () => void;
}

type SelNode = { dbId: number; name: string };

/**
 * APS 간섭체크 — ACC 통합모델(nwd)의 인스턴스 트리에서 **대상 A·B 를 각각의 트리 칸**
 * 에서 고른다(파일 → 부재). 상위 노드 둘을 고르면 곧 파일간 간섭. 검출은 apsClash,
 * 결과 클릭 시 두 부재의 상위 파일만 남기고(나머지 숨김) A초록/B빨강 + 반투명 + 줌.
 * 표시 옵션(전체/반투명), 저장(GlobalId)·CSV·이미지 보고서. 그룹/정렬/필터는 clash.ts.
 */
export function ApsClashPanel({ viewer, model, mapping, projectId, projectName, canEdit, onClose, onIssueCreated }: Props) {
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // 이동/크기 조절 창.
  const [win, setWin] = useState({ x: 80, y: 64, w: 540, h: 660 });
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
          : { ...w, w: Math.max(380, d.ox + dx), h: Math.max(320, d.oy + dy) },
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
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, ox: mode === 'move' ? win.x : win.w, oy: mode === 'move' ? win.y : win.h };
  };

  // 인스턴스 트리(모델 트리) — 자식 캐시 공유, 펼침 상태는 A/B 칸별로.
  const roots = useMemo<ApsTreeNode[]>(() => rootChildren(model), [model]);
  const childCacheRef = useRef<Map<number, ApsTreeNode[]>>(new Map());
  const kids = (dbId: number): ApsTreeNode[] => {
    const c = childCacheRef.current;
    if (!c.has(dbId)) c.set(dbId, childrenOf(model, dbId));
    return c.get(dbId)!;
  };
  const [expandA, setExpandA] = useState<Set<number>>(new Set());
  const [expandB, setExpandB] = useState<Set<number>>(new Set());
  const [aSel, setASel] = useState<SelNode | null>(null);
  const [bSel, setBSel] = useState<SelNode | null>(null);

  const toggle = (side: 'A' | 'B', dbId: number) => {
    kids(dbId);
    const setter = side === 'A' ? setExpandA : setExpandB;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(dbId)) next.delete(dbId);
      else next.add(dbId);
      return next;
    });
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
  const [reportBusy, setReportBusy] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [dimOn, setDimOn] = useState(false); // 치수 표시(아이디어 #3, 기본 OFF)

  // 결과가 생기면 저장 제목 기본값(날짜·시간)을 채운다(#3, 사용자가 목적 덧붙이기 좋게).
  useEffect(() => {
    if (rows.length && !saveName) setSaveName(`간섭 ${new Date().toLocaleString('ko-KR')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  useEffect(() => {
    listClashTests(projectId).then(setTests).catch(() => {});
    return () => clearApsClashView(viewer, model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 선택 노드 → leaf dbId + 메타(이름=부재, 카테고리=상위 그룹).
  const buildMeta = (leaves: number[]): ApsMetaResolver => {
    const map: ApsMetaResolver = new Map();
    for (const d of leaves) {
      map.set(targetKey(model.id, d), { name: nodeName(model, d), category: parentName(model, d) || '(그룹)' });
    }
    return map;
  };

  const run = async () => {
    if (running) return;
    if (!aSel || !bSel) {
      setStatus('대상 A·B 를 각 칸에서 선택하세요.');
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ ratio: 0, phase: '준비' });
    try {
      const leavesA = collectLeaves(model, aSel.dbId);
      const leavesB = collectLeaves(model, bSel.dbId);
      if (!leavesA.length || !leavesB.length) {
        setStatus('대상에 부재가 없습니다.');
        return;
      }
      const metaMap = buildMeta([...new Set([...leavesA, ...leavesB])]);
      const hits = await runApsClashDetection({
        viewer,
        itemsA: leavesA.map((dbId) => ({ model, dbId })),
        itemsB: leavesB.map((dbId) => ({ model, dbId })),
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
    showApsClash(viewer, model, r.a.expressID, r.b.expressID);
  };

  // 표시 옵션(#6 전체 표시 / #7 반투명) — 활성 결과 기준.
  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  const showAll = () => showAllWithColors(viewer);
  const showTrans = () => {
    if (activeRow) showTranslucentClash(viewer, model, activeRow.a.expressID, activeRow.b.expressID);
  };

  const mappingsMap = useMemo(() => new Map([[model.id as number, mapping]]), [model, mapping]);

  const save = async () => {
    if (!rows.length) return;
    setStatus('저장 중…');
    try {
      const id = await saveApsClashTest({
        projectId,
        name: saveName.trim() || `간섭 ${new Date().toLocaleString('ko-KR')}`,
        setA: aSel?.name ?? '',
        setB: bSel?.name ?? '',
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
      setRows(loadedApsToRows(loaded, [mapping]));
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

  const exportReport = async () => {
    if (!rows.length || reportBusy) return;
    setReportBusy(true);
    setStatus('보고서 생성 중(스냅샷 캡처)…');
    try {
      const html = await buildApsClashReport(viewer, model, rows, {
        projectName,
        setA: aSel?.name,
        setB: bSel?.name,
        onProgress: (d, t) => setStatus(`보고서 스냅샷 ${d}/${t}…`),
      });
      downloadReport(`clash-report-${Date.now()}.html`, html);
      setStatus('보고서 다운로드 완료(.html — 브라우저에서 인쇄→PDF 가능)');
    } catch (e) {
      setStatus(`보고서 실패: ${(e as Error).message}`);
    } finally {
      setReportBusy(false);
    }
  };

  const [issueTitle, setIssueTitle] = useState('');
  const [issueDesc, setIssueDesc] = useState('');
  const [issuePriority, setIssuePriority] = useState<IssuePriority>('high');
  const [issueShots, setIssueShots] = useState<string[]>([]);
  const [issueShotSel, setIssueShotSel] = useState<Set<number>>(new Set());
  const [issueCapturing, setIssueCapturing] = useState(false);
  const [issueSaving, setIssueSaving] = useState(false);

  const openIssue = async (r: ClashRow) => {
    setIssueFor(r);
    setIssueTitle(`간섭: ${r.a.name || r.a.category} ↔ ${r.b.name || r.b.category}`);
    setIssueDesc(`간섭 검출 (관통깊이 ${r.depth.toFixed(3)}m)\nA: ${r.a.name || r.a.category}\nB: ${r.b.name || r.b.category}`);
    setIssuePriority('high');
    // 4컷 캡처(#7) — 사용자가 원하는 뷰를 골라 이슈에 첨부.
    setIssueShots([]);
    setIssueShotSel(new Set());
    setIssueCapturing(true);
    try {
      const shots = (await captureClashAngles(viewer, model, r.a.expressID, r.b.expressID, 4)).filter(Boolean);
      setIssueShots(shots);
      setIssueShotSel(new Set(shots.map((_, i) => i)));
    } catch {
      /* 캡처 실패 무시 */
    } finally {
      setIssueCapturing(false);
    }
  };
  const submitIssue = async () => {
    const r = issueFor;
    if (!r || issueSaving) return;
    setIssueSaving(true);
    const globalId = mapping.dbIdToGlobalId.get(r.a.expressID) ?? null;
    const globalIdB = mapping.dbIdToGlobalId.get(r.b.expressID) ?? null;
    try {
      const issueId = await createIssue(
        projectId,
        { title: issueTitle, description: issueDesc, priority: issuePriority, global_id: globalId, global_id_b: globalIdB },
        authorName,
      );
      // 선택한 스냅샷을 이슈 첨부로 업로드(#7).
      const chosen = issueShots.filter((_, i) => issueShotSel.has(i));
      for (let i = 0; i < chosen.length; i++) {
        const file = dataUrlToFile(chosen[i], `clash-${Date.now()}-${i + 1}.png`);
        if (file) await uploadAttachment(projectId, 'issue', issueId, file).catch(() => {});
      }
      if (dbBacked) {
        await linkClashIssue(r.id, issueId);
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, issueId } : x)));
      }
      setIssueFor(null);
      setIssueShots([]);
      onIssueCreated?.();
      setStatus(`이슈 생성됨${chosen.length ? ` · 사진 ${chosen.length}장 첨부` : ''}`);
    } catch (e) {
      setStatus(`이슈 생성 실패: ${(e as Error).message}`);
    } finally {
      setIssueSaving(false);
    }
  };
  const toggleShot = (i: number) =>
    setIssueShotSel((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

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

  // 한쪽(A/B) 트리 렌더 — 단일 선택.
  const renderTree = (side: 'A' | 'B') => {
    const expand = side === 'A' ? expandA : expandB;
    const sel = side === 'A' ? aSel : bSel;
    const setSel = side === 'A' ? setASel : setBSel;
    const color = side === 'A' ? '#16a34a' : '#dc2626';
    const renderNode = (node: ApsTreeNode, depth: number): React.ReactNode => {
      const open = expand.has(node.dbId);
      const selected = sel?.dbId === node.dbId;
      return (
        <div key={node.dbId}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '1px 4px', paddingLeft: 4 + depth * 12, background: selected ? color : 'transparent', borderRadius: 4 }}>
            <button
              onClick={() => node.hasChildren && toggle(side, node.dbId)}
              style={{ ...rowBtn, width: 14, visibility: node.hasChildren ? 'visible' : 'hidden', color: selected ? '#fff' : 'var(--muted)' }}
            >
              {open ? '▾' : '▸'}
            </button>
            <span
              onClick={() => setSel(selected ? null : { dbId: node.dbId, name: node.name })}
              title={node.name}
              style={{ flex: 1, fontSize: 12, cursor: 'pointer', color: selected ? '#fff' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {node.hasChildren ? '📁' : '🔹'} {node.name}
            </span>
          </div>
          {open && kids(node.dbId).map((k) => renderNode(k, depth + 1))}
        </div>
      );
    };
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 2 }}>
          대상 {side} {sel ? `· ${sel.name}` : ''}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, height: 170, overflow: 'auto' }}>
          {roots.length ? roots.map((n) => renderNode(n, 0)) : <div style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>트리 로딩…</div>}
        </div>
      </div>
    );
  };

  let globalIdx = 0;

  return (
    <div
      className="clash-win"
      style={{ position: 'fixed', left: win.x, top: win.y, width: win.w, height: win.h, background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column', zIndex: 600, boxShadow: '0 8px 32px rgba(0,0,0,0.35)' }}
    >
      <div onMouseDown={startDrag('move')} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'move' }}>
        <strong style={{ fontSize: 13 }}>🔍 간섭체크</strong>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length ? `총 ${rows.length} · 미해결 ${openCount}` : ''}</span>
        <span style={{ flex: 1 }} />
        <button onClick={showAll} style={{ ...btn, fontSize: 11 }} title="모든 파일 표시(색 유지)">전체 표시</button>
        <button onClick={showTrans} disabled={!activeRow} style={{ ...btn, fontSize: 11 }} title="간섭 부재만 솔리드, 나머지 반투명">반투명</button>
        <button onClick={() => setDimOn((v) => !v)} style={{ ...btn, fontSize: 11, ...(dimOn ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' } : {}) }} title="간섭 치수(관통/이격) 표시">📏 치수</button>
        <button onClick={onClose} style={btn}>✕</button>
      </div>

      <div style={{ padding: 10, overflowY: 'auto', flex: 1 }}>
        {/* 대상 A·B 각각의 트리 칸(#9) */}
        <div style={{ display: 'flex', gap: 8 }}>
          {renderTree('A')}
          {renderTree('B')}
        </div>

        {/* 검사 옵션 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>유형</label>
            <select value={type} onChange={(e) => setType(e.target.value as ClashType)} style={sel}>
              <option value="hard">Hard(관통)</option>
              <option value="clearance">Clearance(이격)</option>
            </select>
          </div>
          <div>
            <label style={lbl}>허용오차(m)</label>
            <input type="number" step="0.001" value={tolerance} onChange={(e) => setTolerance(Math.max(0, Number(e.target.value)))} style={{ ...sel, width: 90 }} />
          </div>
          <button onClick={() => void run()} disabled={running || !aSel || !bSel} style={{ ...btnPrimary, flex: 1 }}>
            {running ? '검사 중…' : '간섭 검사 실행'}
          </button>
          {running && <button onClick={() => (cancelRef.current = true)} style={btn}>중지</button>}
        </div>
        {progress && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>{progress.phase} · {Math.round(progress.ratio * 100)}%</div>}

        {/* 저장 제목(#3) — 날짜·시간 기본 + 검토 목적 덧붙이기 */}
        {rows.length > 0 && canEdit && (
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="저장 제목(예: 2층 배관 vs 구조 간섭 검토)"
            style={{ ...sel, marginTop: 10 }}
          />
        )}
        {/* 저장/불러오기 (#3 순서: 저장된 테스트 → 🗑 → 💾 → CSV → 보고서) */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={selTest} onChange={(e) => void loadTest(e.target.value)} style={{ ...sel, flex: 1, minWidth: 120 }}>
            <option value="">저장된 테스트…</option>
            {tests.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {canEdit && selTest && <button onClick={() => void removeTest(selTest)} style={btn} title="삭제">🗑</button>}
          {canEdit && <button onClick={() => void save()} disabled={!rows.length} style={btn} title="결과 저장">💾</button>}
          <button onClick={() => downloadCsv('clash.csv', apsClashesToCsv(rows, model))} disabled={!rows.length} style={btn} title="CSV 내보내기">CSV</button>
          <button onClick={() => void exportReport()} disabled={!rows.length || reportBusy} style={btn} title="이미지 포함 보고서(.html)">📄 보고서</button>
        </div>

        {/* 그룹/정렬/상태필터 (#10) */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as ClashGroupBy)} style={sel}>
              {(Object.keys(GROUP_BY_LABEL) as ClashGroupBy[]).map((k) => (
                <option key={k} value={k}>그룹: {GROUP_BY_LABEL[k]}</option>
              ))}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as ClashSortBy)} style={sel}>
              {(Object.keys(SORT_BY_LABEL) as ClashSortBy[]).map((k) => (
                <option key={k} value={k}>정렬: {SORT_BY_LABEL[k]}</option>
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
                    <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginTop: 6, background: active ? 'var(--panel-2)' : 'transparent' }}>
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
                        <select value={r.status} onChange={(e) => void changeStatus(r, e.target.value as ClashStatus)} disabled={!canEdit} style={{ ...sel, width: 'auto', fontSize: 11 }}>
                          {CLASH_STATUSES.map((s) => (
                            <option key={s} value={s}>{CLASH_STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                        {r.issueId ? (
                          <span style={{ fontSize: 11, color: 'var(--accent)' }}>이슈 연결됨</span>
                        ) : (
                          canEdit && <button onClick={() => openIssue(r)} style={{ ...btn, fontSize: 11 }}>이슈 생성</button>
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
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
            {/* 4컷 스냅샷(#7) — 첨부할 뷰 선택 */}
            <label style={lbl}>첨부 사진 {issueCapturing ? '(캡처 중…)' : `(${issueShotSel.size}/${issueShots.length} 선택)`}</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 }}>
              {issueShots.map((s, i) => (
                <button
                  key={i}
                  onClick={() => toggleShot(i)}
                  style={{ padding: 0, border: issueShotSel.has(i) ? '2px solid var(--accent)' : '2px solid var(--border)', borderRadius: 6, background: 'transparent', cursor: 'pointer', position: 'relative' }}
                  title={issueShotSel.has(i) ? '첨부됨(클릭 해제)' : '클릭해 첨부'}
                >
                  <img src={s} alt={`view ${i + 1}`} style={{ width: '100%', display: 'block', borderRadius: 4, opacity: issueShotSel.has(i) ? 1 : 0.5 }} />
                  {issueShotSel.has(i) && (
                    <span style={{ position: 'absolute', top: 2, right: 4, color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>✓</span>
                  )}
                </button>
              ))}
              {!issueCapturing && issueShots.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--muted)', gridColumn: '1 / -1' }}>스냅샷 없음(캡처 실패)</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setIssueFor(null)} style={btn}>취소</button>
              <button onClick={() => void submitIssue()} disabled={!issueTitle.trim() || issueSaving} style={btnPrimary}>
                {issueSaving ? '생성 중…' : '생성'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div onMouseDown={startDrag('resize')} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize' }} />

      {/* 간섭 치수 라벨(아이디어 #3) — 활성 결과 + 토글 ON 일 때 */}
      {dimOn && activeRow && (
        <ApsClashDim
          viewer={viewer}
          point={activeRow.point}
          color={type === 'hard' ? '#dc2626' : '#2563eb'}
          label={`${type === 'hard' ? '관통' : '이격'} ${activeRow.depth.toFixed(3)} m`}
        />
      )}

      {/* 캡처 중 화면 전환 깜빡임을 가리는 마스크(#7). 스냅샷은 캔버스에서 찍혀 영향 없음. */}
      {(issueCapturing || reportBusy) && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 590, background: 'rgba(15,20,30,0.78)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff', pointerEvents: 'all' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>📸 스냅샷 캡처 중…</div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85 }}>화면이 잠시 자동으로 전환됩니다. 잠시만 기다려 주세요.</div>
        </div>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 6 };
const sel: React.CSSProperties = { width: '100%', padding: '4px 6px', borderRadius: 6, marginTop: 2, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' };
const btn: React.CSSProperties = { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid var(--accent)' };
const chip: React.CSSProperties = { ...btn, fontSize: 11, padding: '2px 8px' };
const rowBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 };
const groupHeader: React.CSSProperties = { width: '100%', textAlign: 'left', padding: '4px 6px', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 12 };
