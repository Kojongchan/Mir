import { useEffect, useMemo, useRef, useState } from 'react';
import {
  groupClashes, inheritStatuses, clashesToCsv, downloadCsv,
  CLASH_STATUSES, CLASH_STATUS_LABEL, OPEN_CLASH_STATUSES, GROUP_BY_LABEL, SORT_BY_LABEL,
  type ClashRow, type ClashStatus, type ClashType, type ClashGroupBy, type ClashSortBy,
} from '../../lib/clash';
import {
  listClashTests, saveApsClashTest, loadApsClashes, loadedApsToRows, deleteClashTest, setClashStatus, linkClashIssue,
  type ClashTestMeta,
} from '../../lib/clashApi';
import type { ApsMapping } from '../../lib/apsMapping';
import { estimateClash, runMirClashDetection } from '../../lib/mirClash';
import { confirmDialog } from '../../lib/dialogs';
import { createIssue, ISSUE_PRIORITIES, PRIORITY_LABEL, type IssuePriority } from '../../lib/issues';
import { ISSUE_TYPES, TYPE_LABEL, type IssueType } from '../../lib/issueTypes';
import { listIssueCategories, type IssueCategory } from '../../lib/issueCategories';
import { listProjectMembers, memberLabel, type ProjectMember } from '../../lib/members';
import { uploadAttachment } from '../../lib/attachments';
import { clashReportHtml, dataUrlToFile, downloadReport } from '../../lib/apsReport';
import { useAuth } from '../../auth/AuthProvider';
import { errMessage } from '../../lib/errors';
import type { ModelTree } from '../../viewer/ModelTree';

/**
 * 간섭검토 — 자체 엔진판(기존 Autodesk 뷰어의 ApsClashPanel 과 같은 흐름·같은 저장 형식).
 * 대상 A·B 를 각 트리 칸에서 고르고(파일 → 부재), 원본 형상으로 검사(mirClash.ts), 결과를 누르면 두 부재를 보여 준다.
 * 저장은 객체 외부 ID(GlobalId)로 — 같은 모델이면 기존 뷰어에서 저장한 검토도 여기서 열리고 그 반대도 된다.
 */
export interface MirClashPanelProps {
  tree: ModelTree;
  projectId: string;
  canEdit: boolean;
  /** 열린 타일셋 파일(서명 URL) — 검사 때 원본 형상을 받는다. */
  urls: () => Record<string, string> | null;
  /** objects.bin(객체 상자). */
  boxes: () => Promise<Float32Array> | null;
  externalOf: (dbId: number) => Promise<string | null>;
  findExternal: (ids: string[]) => Promise<Map<string, number>>;
  /** 결과 한 건 보기: A·B 선택 + 확대. */
  onShow: (a: number, b: number) => void;
  /** 지금 화면(이슈 첨부 사진, 데이터 URL). */
  snapshot: () => Promise<string | null>;
  /** 결과 보기 방식: ghost = A·B 만 또렷이(나머지 반투명), all = 모두 그대로, null = 결과 표시 없음. */
  view: 'ghost' | 'all' | null;
  onView: (mode: 'ghost' | 'all' | 'clear') => void;
  /** 보고서: 한 건을 비춘 사진(데이터 URL). */
  capture: (a: number, b: number) => Promise<string | null>;
  /** 객체 → 분야(상위 파일 이름). */
  fileOf: (dbId: number) => string;
  projectName?: string;
  onIssueCreated?: () => void;
  onClose: () => void;
}

const SHOW_STEP = 300;

/** 한 모델 매핑(저장·불러오기용 — clashApi 는 APS 매핑 모양을 받는다). */
type Mapping = ApsMapping;
const emptyMapping = (): Mapping => ({ model: { id: 0 }, dbIdToGlobalId: new Map(), globalIdToDbId: new Map(), size: 0 });

export function MirClashPanel(props: MirClashPanelProps) {
  const { tree, projectId, canEdit, urls, boxes, externalOf, findExternal, onShow, snapshot, view, onView, capture, fileOf, projectName, onIssueCreated, onClose } = props;
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // 창 위치(머리줄을 끌어 옮김).
  const [pos, setPos] = useState({ x: 16, y: 56 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => { const d = drag.current; if (d) setPos({ x: Math.max(0, d.ox + e.clientX - d.sx), y: Math.max(0, d.oy + e.clientY - d.sy) }); };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  // 대상 A·B (트리 노드 하나씩).
  const [expandA, setExpandA] = useState<Set<number>>(new Set());
  const [expandB, setExpandB] = useState<Set<number>>(new Set());
  const [aSel, setASel] = useState<{ id: number; name: string } | null>(null);
  const [bSel, setBSel] = useState<{ id: number; name: string } | null>(null);
  const [type, setType] = useState<ClashType>('hard');
  const [tolerance, setTolerance] = useState(0.01);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ ratio: number; phase: string } | null>(null);
  const cancelRef = useRef(false);
  const [rows, setRows] = useState<ClashRow[]>([]);
  // 목록은 앞에서부터 SHOW_STEP 건씩 그린다(수만 건을 한꺼번에 그리면 화면이 멈춤).
  const [shown, setShown] = useState(SHOW_STEP);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dbBacked, setDbBacked] = useState(false);
  const [status, setStatus] = useState('');
  const [groupBy, setGroupBy] = useState<ClashGroupBy>('none');
  const [sortBy, setSortBy] = useState<ClashSortBy>('index');
  const [statusFilter, setStatusFilter] = useState<Set<ClashStatus>>(new Set(CLASH_STATUSES));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tests, setTests] = useState<ClashTestMeta[]>([]);
  const [selTest, setSelTest] = useState('');
  const [saveName, setSaveName] = useState('');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [cats, setCats] = useState<IssueCategory[]>([]);

  useEffect(() => {
    listClashTests(projectId).then(setTests).catch(() => {});
    listProjectMembers(projectId).then(setMembers).catch(() => {});
    listIssueCategories(projectId).then(setCats).catch(() => setCats([]));
  }, [projectId]);
  useEffect(() => {
    if (rows.length && !saveName) setSaveName(`간섭 ${new Date().toLocaleString('ko-KR')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  /** 노드 아래의 실제 부재(자식 없는 노드). */
  const leavesOf = (id: number) => tree.subtree(id).filter((d) => tree.childCount(d) === 0);
  const meta = (id: number) => {
    const parent = tree.parent[id];
    return { name: tree.name(id), category: parent >= 0 ? tree.name(parent) : '(그룹)' };
  };

  const run = async () => {
    if (running) return;
    if (!aSel || !bSel) { setStatus('대상 A·B 를 각 칸에서 선택하세요.'); return; }
    const u = urls(), b = boxes();
    if (!u || !b) { setStatus('모델이 아직 열리지 않았습니다.'); return; }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ ratio: 0, phase: '준비' });
    try {
      const idsA = leavesOf(aSel.id), idsB = leavesOf(bSel.id);
      if (!idsA.length || !idsB.length) { setStatus('대상에 부재가 없습니다.'); return; }
      const allBoxes = await b;
      // 큰 검사(예: 모델 전체 대 전체)는 규모를 먼저 알리고 묻는다.
      if (idsA.length + idsB.length > 4000) {
        setProgress({ ratio: 0, phase: '규모 확인 중' });
        const est = await estimateClash(u, allBoxes, idsA, idsB, tolerance);
        if (est.truncated) { setStatus(`후보 쌍이 ${est.pairs.toLocaleString()}개를 넘습니다. 대상을 파일·분류 단위로 나눠 검사하세요.`); return; }
        const heavy = est.tiles > 300 || est.pairs > 200_000;
        const ok = await confirmDialog(
          `대상 A ${idsA.length.toLocaleString()}개 · B ${idsB.length.toLocaleString()}개 부재\n`
          + `후보 쌍 ${est.pairs.toLocaleString()}개 · 관련 부재 ${est.objects.toLocaleString()}개 · 원본 타일 ${est.tiles.toLocaleString()}개를 검사합니다.\n`
          + (heavy ? '규모가 커서 수 분 이상 걸릴 수 있습니다(진행 중 「중지」 가능, 받은 타일은 이 브라우저에 남아 다음 검사가 빨라짐). ' : '')
          + '계속할까요?',
          { title: '간섭 검사 규모', confirmLabel: '검사 시작' });
        if (!ok) { setStatus('검사를 시작하지 않았습니다.'); return; }
      }
      const hits = await runMirClashDetection({
        urls: u, boxes: allBoxes, idsA, idsB, type, tolerance, meta,
        onProgress: (ratio, phase) => setProgress({ ratio, phase }),
        shouldCancel: () => cancelRef.current,
      });
      const next = inheritStatuses(hits, rows);
      const inherited = next.filter((r) => r.status !== 'new').length;
      setRows(next); setDbBacked(false); setSelTest(''); setActiveId(null);
      setShown(SHOW_STEP);
      setStatus(cancelRef.current ? `중지됨 · 그때까지 ${next.length}건`
        : `간섭 ${next.length.toLocaleString()}건${next.length >= 20000 ? ' (2만 건에서 멈춤 — 대상을 나눠 검사하세요)' : ''}${inherited ? ` (상태 승계 ${inherited}건)` : ''}`);
    } catch (e) {
      setStatus(`검사 실패: ${errMessage(e)}`);
    } finally {
      setRunning(false); setProgress(null);
    }
  };

  const show = (r: ClashRow) => {
    setActiveId(r.id);
    if (r.a.expressID >= 0 && r.b.expressID >= 0) onShow(r.a.expressID, r.b.expressID);
    else setStatus('이 결과의 부재를 지금 모델에서 찾지 못했습니다.');
  };

  /** 결과 행들의 객체 외부 ID(저장용). */
  const mappingFor = async (list: ClashRow[]): Promise<Mapping> => {
    const m = emptyMapping();
    const ids = [...new Set(list.flatMap((r) => [r.a.expressID, r.b.expressID]).filter((x) => x >= 0))];
    let k = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let i = k++; i < ids.length; i = k++) {
        const x = await externalOf(ids[i]).catch(() => null);
        if (x) { m.dbIdToGlobalId.set(ids[i], x); m.globalIdToDbId.set(x, ids[i]); }
      }
    }));
    return { ...m, size: m.dbIdToGlobalId.size };
  };

  const loadTest = async (testId: string) => {
    setSelTest(testId);
    if (!testId) return;
    setStatus('불러오는 중…');
    try {
      const loaded = await loadApsClashes(testId);
      const gids = [...new Set(loaded.flatMap((c) => [c.global_id_a, c.global_id_b]).filter((x): x is string => !!x))];
      const found = await findExternal(gids);
      const m = emptyMapping();
      for (const [x, id] of found) { m.globalIdToDbId.set(x, id); m.dbIdToGlobalId.set(id, x); }
      setRows(loadedApsToRows(loaded, [{ ...m, size: found.size }]));
      setDbBacked(true); setActiveId(null);
      const missing = loaded.filter((c) => !found.has(c.global_id_a ?? '') || !found.has(c.global_id_b ?? '')).length;
      setStatus(`불러옴 ${loaded.length}건${missing ? ` · 이 모델에 없는 부재 ${missing}건(표시만)` : ''}`);
    } catch (e) {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
    }
  };

  const save = async () => {
    if (!rows.length) return;
    setStatus('저장 중…');
    try {
      const mapping = await mappingFor(rows);
      const id = await saveApsClashTest({
        projectId,
        name: saveName.trim() || `간섭 ${new Date().toLocaleString('ko-KR')}`,
        setA: aSel?.name ?? '', setB: bSel?.name ?? '', type, tolerance, rows,
        mappings: new Map([[0, mapping]]),
      });
      await listClashTests(projectId).then(setTests);
      await loadTest(id);
      setStatus('저장 완료');
    } catch (e) {
      setStatus(`저장 실패: ${errMessage(e)}`);
    }
  };

  const removeTest = async (testId: string) => {
    if (!confirm('이 간섭 테스트를 삭제할까요?')) return;
    try {
      await deleteClashTest(testId);
      await listClashTests(projectId).then(setTests);
      if (selTest === testId) { setSelTest(''); setRows([]); setDbBacked(false); }
    } catch (e) {
      setStatus(`삭제 실패: ${errMessage(e)}`);
    }
  };

  const changeStatus = async (r: ClashRow, s: ClashStatus) => {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: s } : x)));
    if (dbBacked) {
      try { await setClashStatus(r.id, s); } catch (e) { setStatus(`상태 저장 실패: ${errMessage(e)}`); }
    }
  };

  // 간섭 → 이슈.
  const [issueFor, setIssueFor] = useState<ClashRow | null>(null);
  const [form, setForm] = useState({ title: '', desc: '', type: 'quality' as IssueType, category: '', priority: 'high' as IssuePriority, assignee: '', due: '' });
  const [shot, setShot] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [saving, setSaving] = useState(false);
  const openIssue = async (r: ClashRow) => {
    show(r);
    setIssueFor(r);
    setForm({
      title: `간섭: ${r.a.name || r.a.category} ↔ ${r.b.name || r.b.category}`,
      desc: `간섭 검출 (관통깊이 ${r.depth.toFixed(3)}m)\nA: ${r.a.name || r.a.category}\nB: ${r.b.name || r.b.category}`,
      type: 'quality', category: '', priority: 'high', assignee: '', due: '',
    });
    setShot(null); setAttach(true);
    // 두 부재로 화면이 옮겨 간 뒤 한 장.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setShot(await snapshot().catch(() => null));
  };
  const submitIssue = async () => {
    const r = issueFor;
    if (!r || saving || !form.title.trim()) return;
    setSaving(true);
    try {
      const [ga, gb] = await Promise.all([externalOf(r.a.expressID).catch(() => null), externalOf(r.b.expressID).catch(() => null)]);
      const assignee = members.find((m) => m.id === form.assignee);
      const issueId = await createIssue(projectId, {
        title: form.title.trim(), description: form.desc, type: form.type, category_id: form.category || null, priority: form.priority,
        assignee_id: form.assignee || null, assignee_name: assignee?.name, due_date: form.due || null, global_id: ga, global_id_b: gb,
      }, authorName);
      if (shot && attach) {
        const file = dataUrlToFile(shot, `clash-${Date.now()}.jpg`);
        if (file) await uploadAttachment(projectId, 'issue', issueId, file).catch(() => {});
      }
      if (dbBacked) {
        await linkClashIssue(r.id, issueId);
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, issueId } : x)));
      }
      setIssueFor(null);
      onIssueCreated?.();
      setStatus(`이슈 생성됨${shot && attach ? ' · 사진 1장 첨부' : ''}`);
    } catch (e) {
      setStatus(`이슈 생성 실패: ${errMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // 이미지 보고서(.html): 보이는 결과 순서대로 최대 60건을 비춰 찍는다(기존 뷰어 보고서와 같은 양식).
  const [reportBusy, setReportBusy] = useState(false);
  const reportCancel = useRef(false);
  const exportReport = async (list: ClashRow[]) => {
    if (!list.length || reportBusy) return;
    setReportBusy(true);
    reportCancel.current = false;
    const shots: Record<string, string> = {};
    const targets = list.filter((r) => r.a.expressID >= 0 && r.b.expressID >= 0).slice(0, 60);
    try {
      for (let i = 0; i < targets.length && !reportCancel.current; i++) {
        setStatus(`보고서 사진 ${i + 1}/${targets.length} (화면이 자동으로 옮겨 갑니다)…`);
        const shot = await capture(targets[i].a.expressID, targets[i].b.expressID).catch(() => null);
        if (shot) shots[targets[i].id] = shot;
      }
      const html = clashReportHtml(list, shots, fileOf, { projectName, setA: aSel?.name, setB: bSel?.name, maxShots: 60 });
      downloadReport(`간섭보고서-${new Date().toISOString().slice(0, 10)}.html`, html);
      setStatus(`보고서 저장 완료(.html, 사진 ${Object.keys(shots).length}장 — 브라우저에서 인쇄 → PDF 가능)`);
    } catch (e) {
      setStatus(`보고서 실패: ${errMessage(e)}`);
    } finally {
      setReportBusy(false);
    }
  };

  const visibleRows = useMemo(() => rows.filter((r) => statusFilter.has(r.status)), [rows, statusFilter]);
  const grouped = useMemo(() => groupClashes(visibleRows, groupBy, sortBy), [visibleRows, groupBy, sortBy]);
  const openCount = rows.filter((r) => OPEN_CLASH_STATUSES.includes(r.status)).length;
  const toggleIn = <T,>(set: (f: (p: Set<T>) => Set<T>) => void, v: T) =>
    set((prev) => { const next = new Set(prev); if (next.has(v)) next.delete(v); else next.add(v); return next; });

  const renderTree = (side: 'A' | 'B') => {
    const expand = side === 'A' ? expandA : expandB;
    const setExpand = side === 'A' ? setExpandA : setExpandB;
    const sel = side === 'A' ? aSel : bSel;
    const setSel = side === 'A' ? setASel : setBSel;
    const node = (id: number, depth: number): React.ReactNode => {
      const hasKids = tree.childCount(id) > 0;
      const open = expand.has(id);
      const selected = sel?.id === id;
      return (
        <div key={id}>
          <div className={`mir-clash__node${selected ? ` is-sel is-${side.toLowerCase()}` : ''}`} style={{ paddingLeft: 4 + depth * 12 }}>
            <button type="button" className="mir-clash__twisty" style={{ visibility: hasKids ? 'visible' : 'hidden' }}
              onClick={() => toggleIn(setExpand, id)} aria-label={open ? '접기' : '펼치기'}>{open ? '▾' : '▸'}</button>
            <span className="mir-clash__name" title={tree.name(id)} onClick={() => setSel(selected ? null : { id, name: tree.name(id) })}>
              {tree.name(id) || `#${id}`}
            </span>
          </div>
          {open && Array.from(tree.children(id)).slice(0, 2000).map((c) => node(c, depth + 1))}
        </div>
      );
    };
    return (
      <div className="mir-clash__side">
        <div className={`mir-clash__side-h is-${side.toLowerCase()}`}>대상 {side}{sel ? ` · ${sel.name}` : ''}</div>
        <div className="mir-clash__tree">{tree.roots.map((r) => node(r, 0))}</div>
      </div>
    );
  };

  let n = 0;
  return (
    <div className="mir-clash" style={{ left: pos.x, top: pos.y }} role="dialog" aria-label="간섭검토">
      <div className="mir-clash__head" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) return; drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }; }}>
        <strong>간섭검토</strong>
        <span className="muted">{rows.length ? `총 ${rows.length} · 미해결 ${openCount}` : ''}</span>
        <span className="spacer" />
        {view && (
          <>
            <button type="button" className={`btn btn--sm${view === 'all' ? ' btn--primary' : ''}`} onClick={() => onView('all')} title="모든 부재를 그대로 표시(A·B 색 유지)">전체 표시</button>
            <button type="button" className={`btn btn--sm${view === 'ghost' ? ' btn--primary' : ''}`} onClick={() => onView('ghost')} title="간섭 부재만 또렷이, 나머지는 반투명">반투명</button>
            <button type="button" className="btn btn--sm" onClick={() => onView('clear')} title="간섭 표시 지우기">표시 해제</button>
          </>
        )}
        <button type="button" className="ic-only" onClick={onClose} aria-label="간섭검토 닫기">✕</button>
      </div>
      <div className="mir-clash__body">
        <div className="mir-clash__sides">{renderTree('A')}{renderTree('B')}</div>
        <div className="mir-clash__opts">
          <label>유형
            <select value={type} onChange={(e) => setType(e.target.value as ClashType)}>
              <option value="hard">Hard(관통)</option>
              <option value="clearance">Clearance(이격)</option>
            </select>
          </label>
          <label>허용오차(m)
            <input type="number" step="0.001" min={0} value={tolerance} onChange={(e) => setTolerance(Math.max(0, Number(e.target.value)))} />
          </label>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void run()} disabled={running || !aSel || !bSel}>
            {running ? '검사 중…' : '간섭 검사 실행'}
          </button>
          {running && <button type="button" className="btn btn--sm" onClick={() => { cancelRef.current = true; }}>중지</button>}
        </div>
        {progress && <div className="muted mir-clash__progress">{progress.phase} · {Math.round(progress.ratio * 100)}%</div>}
        {rows.length > 0 && canEdit && (
          <input className="mir-clash__savename" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="저장 제목(예: 교각 vs 거푸집 간섭 검토)" />
        )}
        <div className="mir-clash__row">
          <select value={selTest} onChange={(e) => void loadTest(e.target.value)}>
            <option value="">저장된 테스트…</option>
            {tests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {canEdit && selTest && <button type="button" className="btn btn--sm" onClick={() => void removeTest(selTest)} title="삭제">삭제</button>}
          {canEdit && <button type="button" className="btn btn--sm" onClick={() => void save()} disabled={!rows.length} title="결과 저장">저장</button>}
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('clash.csv', clashesToCsv(rows))} disabled={!rows.length}>CSV</button>
          <button type="button" className="btn btn--sm" onClick={() => void exportReport(grouped.flatMap((g) => g.rows))} disabled={!rows.length || reportBusy}
            title="보이는 결과(필터·정렬 그대로) 최대 60건을 사진과 함께 .html 보고서로">{reportBusy ? '보고서 만드는 중…' : '보고서'}</button>
          {reportBusy && <button type="button" className="btn btn--sm" onClick={() => { reportCancel.current = true; }}>사진 그만 찍기</button>}
        </div>
        {rows.length > 0 && (
          <div className="mir-clash__row">
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as ClashGroupBy)}>
              {(Object.keys(GROUP_BY_LABEL) as ClashGroupBy[]).map((k) => <option key={k} value={k}>그룹: {GROUP_BY_LABEL[k]}</option>)}
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as ClashSortBy)}>
              {(Object.keys(SORT_BY_LABEL) as ClashSortBy[]).map((k) => <option key={k} value={k}>정렬: {SORT_BY_LABEL[k]}</option>)}
            </select>
            {CLASH_STATUSES.map((s) => (
              <button key={s} type="button" className={`btn btn--sm mir-clash__chip${statusFilter.has(s) ? '' : ' is-off'}`} onClick={() => toggleIn(setStatusFilter, s)}>
                {CLASH_STATUS_LABEL[s]} {rows.filter((r) => r.status === s).length}
              </button>
            ))}
          </div>
        )}
        <div className="mir-clash__list">
          {grouped.map((g) => (
            <div key={g.key}>
              {groupBy !== 'none' && (
                <button type="button" className="mir-clash__group" onClick={() => toggleIn(setCollapsed, g.key)}>
                  {collapsed.has(g.key) ? '▸' : '▾'} {g.label} · 미해결 {g.open}/{g.rows.length}
                </button>
              )}
              {!collapsed.has(g.key) && g.rows.map((r) => {
                n += 1;
                if (n > shown) return null;
                return (
                  <div key={r.id} className={`mir-clash__item${r.id === activeId ? ' is-active' : ''}`}>
                    <div className="mir-clash__item-h" onClick={() => show(r)}>
                      <span className="muted">#{n}</span>
                      <span className="mir-clash__pair"><b className="is-a">A</b> {r.a.name || r.a.category} ↔ <b className="is-b">B</b> {r.b.name || r.b.category}</span>
                      <span className="muted">{r.depth.toFixed(3)}m</span>
                    </div>
                    <div className="mir-clash__row">
                      <select value={r.status} disabled={!canEdit} onChange={(e) => void changeStatus(r, e.target.value as ClashStatus)}>
                        {CLASH_STATUSES.map((s) => <option key={s} value={s}>{CLASH_STATUS_LABEL[s]}</option>)}
                      </select>
                      {r.issueId
                        ? <span className="mir-clash__linked">이슈 등록됨(협업·이슈에서 협의)</span>
                        : canEdit && <button type="button" className="btn btn--sm btn--primary" onClick={() => void openIssue(r)}>이슈로 등록</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {visibleRows.length > shown && (
            <button type="button" className="btn btn--sm mir-clash__more" onClick={() => setShown((v) => v + SHOW_STEP)}>
              더 보기 ({shown.toLocaleString()} / {visibleRows.length.toLocaleString()}건 표시 중)
            </button>
          )}
        </div>
        {status && <div className="muted mir-clash__status">{status}</div>}
      </div>

      {issueFor && (
        <div className="mir-clash__modal">
          <div className="mir-clash__modal-box">
            <strong>간섭 → 이슈</strong>
            <label>제목<input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></label>
            <label>내용<textarea value={form.desc} rows={4} onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))} /></label>
            <div className="mir-clash__row">
              <label>항목
                <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                  <option value="">미지정</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label>유형
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as IssueType }))}>
                  {ISSUE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </label>
            </div>
            <div className="mir-clash__row">
              <label>우선순위
                <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as IssuePriority }))}>
                  {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </label>
              <label>마감일<input type="date" value={form.due} onChange={(e) => setForm((f) => ({ ...f, due: e.target.value }))} /></label>
            </div>
            <label>담당자
              <select value={form.assignee} onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value }))}>
                <option value="">미지정</option>
                {members.map((m) => <option key={m.id} value={m.id}>{memberLabel(m)}</option>)}
              </select>
            </label>
            <label className="mir-clash__attach">
              <input type="checkbox" checked={attach} disabled={!shot} onChange={(e) => setAttach(e.target.checked)} />
              지금 화면 사진 첨부 {shot ? '' : '(캡처 중…)'}
            </label>
            {shot && <img src={shot} alt="간섭 화면" className="mir-clash__shot" />}
            <div className="mir-clash__acts">
              <button type="button" className="btn btn--sm" onClick={() => setIssueFor(null)}>취소</button>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void submitIssue()} disabled={!form.title.trim() || saving}>
                {saving ? '생성 중…' : '생성'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
