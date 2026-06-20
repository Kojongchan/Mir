import { useEffect, useMemo, useRef, useState } from 'react';
import type { IfcViewer, ElementMeta } from '../viewer/IfcViewer';
import {
  runClashDetection,
  clashesToCsv,
  downloadCsv,
  CLASH_STATUSES,
  CLASH_STATUS_LABEL,
  OPEN_CLASH_STATUSES,
  type ClashRow,
  type ClashStatus,
  type ClashType,
} from '../lib/clash';
import {
  listClashTests,
  saveClashTest,
  loadClashes,
  deleteClashTest,
  setClashStatus,
  linkClashIssue,
  loadedToRows,
  type ClashTestMeta,
} from '../lib/clashApi';
import { createIssue, ISSUE_PRIORITIES, PRIORITY_LABEL, type IssuePriority } from '../lib/issues';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import { uploadAttachment } from '../lib/attachments';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  viewer: IfcViewer | null;
  projectId: string;
  /** 런타임 modelID → DB 모델 uuid(이슈 핀·결과 저장 매핑용). */
  modelIdMap: Map<number, string>;
  onClose: () => void;
}

/**
 * 간섭체크 결과 — 이동/크기 조절 가능한 팝업 창. 대상 A/B 를 (모델 → 카테고리)
 * 2단계로 선택하고 허용오차로 Hard/Clearance 간섭을 검출한다. 결과 행 클릭 시
 * 대상객체 A=초록/B=빨강 하이라이트 + 나머지 반투명 + 줌인. 간섭 → 이슈 전환은
 * 내용 작성 + 4각도 스냅샷 첨부까지 한 창에서. 결과 DB 저장/불러오기 + CSV.
 */
export function ClashPanel({ viewer, projectId, modelIdMap, onClose }: Props) {
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // --- 이동/크기 조절 가능한 창 ---
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

  // --- 대상/검사 상태 ---
  const [meta, setMeta] = useState<ElementMeta[]>([]);
  const [aModel, setAModel] = useState<'all' | number>('all');
  const [aCat, setACat] = useState('all');
  const [bModel, setBModel] = useState<'all' | number>('all');
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

  const [tests, setTests] = useState<ClashTestMeta[]>([]);
  const [selTest, setSelTest] = useState('');

  const [issueFor, setIssueFor] = useState<ClashRow | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);

  const refreshTargets = () => {
    if (viewer) setMeta(viewer.getElementMeta());
  };

  // 모델이 로드될 때마다(modelIdMap 변화) 대상 목록을 자동 갱신.
  useEffect(() => {
    if (viewer) setMeta(viewer.getElementMeta());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, modelIdMap]);

  useEffect(() => {
    void refreshTests();
    if (isAdmin) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    return () => {
      viewer?.clearClashView();
      viewer?.showAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, projectId]);

  const refreshTests = async () => {
    try {
      setTests(await listClashTests(projectId));
    } catch {
      /* 0015 미적용/권한 — 무시 */
    }
  };

  const loadedModels = useMemo(() => viewer?.getLoadedModels() ?? [], [viewer, meta]);

  // 모델 선택에 따른 카테고리 목록(전체 또는 특정 모델 내).
  const categoriesFor = (model: 'all' | number) => {
    const cats = new Map<string, number>();
    for (const e of meta) {
      if (model !== 'all' && e.modelID !== model) continue;
      cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
    }
    return [...cats.entries()].sort((a, b) => b[1] - a[1]);
  };
  const aCats = useMemo(() => categoriesFor(aModel), [meta, aModel]);
  const bCats = useMemo(() => categoriesFor(bModel), [meta, bModel]);

  const filterFor = (model: 'all' | number, cat: string) => (e: ElementMeta) =>
    (model === 'all' || e.modelID === model) && (cat === 'all' || e.category === cat);
  const itemsA = useMemo(() => meta.filter(filterFor(aModel, aCat)), [meta, aModel, aCat]);
  const itemsB = useMemo(() => meta.filter(filterFor(bModel, bCat)), [meta, bModel, bCat]);

  const labelFor = (model: 'all' | number, cat: string) => {
    const mName = model === 'all' ? '전체 모델' : loadedModels.find((m) => m.modelID === model)?.label ?? '모델';
    return cat === 'all' ? mName : `${mName} · ${cat}`;
  };

  const summary = useMemo(() => {
    const total = rows.length;
    const open = rows.filter((r) => OPEN_CLASH_STATUSES.includes(r.status)).length;
    return { total, open, closed: total - open };
  }, [rows]);

  const run = async () => {
    if (!viewer || meta.length === 0) {
      setStatus('먼저 모델을 여세요(대상 갱신 후 검사).');
      return;
    }
    if (itemsA.length === 0 || itemsB.length === 0) {
      setStatus('선택한 대상에 요소가 없습니다.');
      return;
    }
    setRunning(true);
    setRows([]);
    setActiveId(null);
    setDbBacked(false);
    cancelRef.current = false;
    setProgress({ ratio: 0, phase: '시작' });
    try {
      const hits = await runClashDetection({
        itemsA,
        itemsB,
        type,
        tolerance,
        build: (m) => viewer.buildClashGeom(m.modelID, m.expressID),
        onProgress: (ratio, phase) => setProgress({ ratio, phase }),
        shouldCancel: () => cancelRef.current,
      });
      setRows(hits.map((h) => ({ ...h, status: 'new' as ClashStatus, issueId: null })));
      setStatus(
        cancelRef.current ? '검사 취소됨' : `검사 완료: 간섭 ${hits.length}건 (A ${itemsA.length} × B ${itemsB.length})`,
      );
    } catch (e) {
      setStatus(`검사 실패: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const focusRow = (r: ClashRow) => {
    if (!viewer) return;
    setActiveId(r.id);
    if (r.a.modelID < 0 || r.b.modelID < 0) {
      setStatus('이 간섭의 객체가 현재 뷰에 없습니다(모델 미오픈/변경).');
      return;
    }
    viewer.showClash(r.a, r.b);
  };

  const showAll = () => {
    viewer?.showAll();
    viewer?.clearClashView();
    setActiveId(null);
  };

  const changeStatus = async (r: ClashRow, st: ClashStatus) => {
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, status: st } : x)));
    if (dbBacked && isAdmin) {
      try {
        await setClashStatus(r.id, st);
      } catch (e) {
        setStatus(`상태 저장 실패: ${(e as Error).message}`);
      }
    }
  };

  const onSave = async () => {
    if (rows.length === 0) return;
    const name = window.prompt('저장할 검사 이름', `간섭검사 ${new Date().toLocaleString()}`);
    if (!name) return;
    try {
      const id = await saveClashTest({
        projectId,
        name,
        setA: labelFor(aModel, aCat),
        setB: labelFor(bModel, bCat),
        type,
        tolerance,
        rows,
        modelIdMap,
      });
      setStatus(`검사 저장 완료: ${name} (${rows.length}건)`);
      await refreshTests();
      setSelTest(id);
    } catch (e) {
      setStatus(`저장 실패: ${(e as Error).message}`);
    }
  };

  const onLoad = async () => {
    if (!selTest) return;
    try {
      const loaded = await loadClashes(selTest);
      const inverse = new Map<string, number>();
      for (const [rt, db] of modelIdMap.entries()) inverse.set(db, rt);
      setRows(loadedToRows(loaded, inverse));
      setDbBacked(true);
      setActiveId(null);
      const tmeta = tests.find((t) => t.id === selTest);
      if (tmeta) {
        setType(tmeta.type);
        setTolerance(tmeta.tolerance);
      }
      setStatus(`불러옴: ${tmeta?.name ?? selTest} · ${loaded.length}건`);
    } catch (e) {
      setStatus(`불러오기 실패: ${(e as Error).message}`);
    }
  };

  const onDelete = async () => {
    if (!selTest) return;
    const t = tests.find((x) => x.id === selTest);
    if (!window.confirm(`"${t?.name ?? selTest}" 검사를 삭제할까요?`)) return;
    try {
      await deleteClashTest(selTest);
      setSelTest('');
      await refreshTests();
      setStatus('검사 삭제 완료');
    } catch (e) {
      setStatus(`삭제 실패: ${(e as Error).message}`);
    }
  };

  const onExportCsv = () => {
    if (rows.length > 0) downloadCsv(`clash_${Date.now()}.csv`, clashesToCsv(rows));
  };

  // 간섭 → 이슈(내용 + 선택 스냅샷 첨부).
  const submitIssue = async (input: {
    title: string;
    description: string;
    priority: IssuePriority;
    assigneeId: string | null;
    dueDate: string | null;
    shots: string[];
  }) => {
    const r = issueFor;
    if (!r) return;
    const modelDbId = modelIdMap.get(r.a.modelID) ?? modelIdMap.get(r.b.modelID) ?? null;
    try {
      const assignee = members.find((m) => m.id === input.assigneeId) ?? null;
      const issueId = await createIssue(
        projectId,
        {
          title: input.title,
          description: input.description,
          priority: input.priority,
          assignee_id: input.assigneeId,
          assignee_name: assignee?.name,
          due_date: input.dueDate,
          model_id: modelDbId,
          express_id: r.a.expressID,
        },
        authorName,
      );
      // 선택한 각도 스냅샷을 이슈 첨부로 업로드.
      let uploaded = 0;
      for (let i = 0; i < input.shots.length; i++) {
        try {
          const file = dataUrlToFile(input.shots[i], `clash_${r.a.expressID}_${r.b.expressID}_${i + 1}.png`);
          await uploadAttachment(projectId, 'issue', issueId, file);
          uploaded++;
        } catch {
          /* 첨부 실패는 비치명적 */
        }
      }
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, issueId, status: 'reviewing' } : x)));
      if (dbBacked) {
        try {
          await linkClashIssue(r.id, issueId);
          await setClashStatus(r.id, 'reviewing');
        } catch {
          /* 비치명적 */
        }
      }
      setIssueFor(null);
      setStatus(`이슈 생성됨 — 사진 ${uploaded}장 첨부 (객체 #${r.a.expressID})`);
    } catch (e) {
      setStatus(`이슈 생성 실패: ${(e as Error).message}`);
    }
  };

  return (
    <div className="clash-win" style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
      <div className="clash-head" onMouseDown={startDrag('move')}>
        <h3>🔍 간섭체크 결과</h3>
        <button className="clash-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="clash-scroll">
        {/* 대상 A/B (모델 → 카테고리) */}
        <div className="clash-setup">
          <div className="clash-sets">
            <SetPicker
              tag="A"
              models={loadedModels}
              cats={aCats}
              model={aModel}
              cat={aCat}
              count={itemsA.length}
              onModel={(m) => {
                setAModel(m);
                setACat('all');
              }}
              onCat={setACat}
            />
            <span className="clash-vs">vs</span>
            <SetPicker
              tag="B"
              models={loadedModels}
              cats={bCats}
              model={bModel}
              cat={bCat}
              count={itemsB.length}
              onModel={(m) => {
                setBModel(m);
                setBCat('all');
              }}
              onCat={setBCat}
            />
          </div>
          <div className="clash-row2">
            <label className="clash-field">
              <span>유형</span>
              <select value={type} onChange={(e) => setType(e.target.value as ClashType)}>
                <option value="hard">하드(겹침)</option>
                <option value="clearance">이격(근접)</option>
              </select>
            </label>
            <label className="clash-field">
              <span>허용오차(m)</span>
              <input
                type="number"
                min={0}
                step={0.005}
                value={tolerance}
                onChange={(e) => setTolerance(Math.max(0, Number(e.target.value)))}
              />
            </label>
          </div>
          <div className="clash-actions">
            <button className="primary" onClick={run} disabled={running || !viewer}>
              {running ? '검사 중…' : '검사 실행'}
            </button>
            <button onClick={refreshTargets} disabled={running} title="열린 모델에서 대상 다시 읽기">
              대상 갱신
            </button>
            {running && (
              <button onClick={() => (cancelRef.current = true)} title="검사 중단">
                중단
              </button>
            )}
          </div>
          {progress && (
            <div className="clash-progress">
              <div className="clash-progress-bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              <span className="muted">
                {progress.phase} {Math.round(progress.ratio * 100)}%
              </span>
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <div className="clash-summary">
            <span className="clash-chip">총 {summary.total}</span>
            <span className="clash-chip clash-chip-open">미해결 {summary.open}</span>
            <span className="clash-chip clash-chip-closed">처리 {summary.closed}</span>
            <span className="spacer" />
            <button onClick={showAll} title="모두 표시(하이라이트 해제)">
              전체 보기
            </button>
            <button onClick={onExportCsv} title="CSV 내보내기">
              CSV
            </button>
            {isAdmin && (
              <button onClick={onSave} title="결과 DB 저장">
                저장
              </button>
            )}
          </div>
        )}

        {tests.length > 0 && (
          <div className="clash-loadbar">
            <select value={selTest} onChange={(e) => setSelTest(e.target.value)}>
              <option value="">저장된 검사…</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button onClick={onLoad} disabled={!selTest}>
              불러오기
            </button>
            {isAdmin && (
              <button onClick={onDelete} disabled={!selTest}>
                삭제
              </button>
            )}
          </div>
        )}

        <div className="clash-results">
          {rows.length === 0 ? (
            <p className="muted clash-empty">
              대상 A·B(모델→카테고리)와 허용오차를 정하고 <b>검사 실행</b>. 결과 행을 클릭하면 A=
              <b style={{ color: 'var(--chip-construct-fg)' }}>초록</b>·B=
              <b style={{ color: 'var(--chip-demolish-fg)' }}>빨강</b>으로 하이라이트되고 나머지는 반투명,
              간섭부로 줌인됩니다.
            </p>
          ) : (
            <table className="clash-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>요소 A</th>
                  <th>요소 B</th>
                  <th>깊이</th>
                  <th>상태</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className={r.id === activeId ? 'is-active' : undefined} onClick={() => focusRow(r)}>
                    <td className="num">{i + 1}</td>
                    <td title={`${r.a.category} #${r.a.expressID}`}>
                      <span className="clash-dot clash-dot-a" />
                      {r.a.name || `#${r.a.expressID}`}
                    </td>
                    <td title={`${r.b.category} #${r.b.expressID}`}>
                      <span className="clash-dot clash-dot-b" />
                      {r.b.name || `#${r.b.expressID}`}
                    </td>
                    <td className="num">{r.depth.toFixed(2)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`clash-status clash-status-${r.status}`}
                        value={r.status}
                        onChange={(e) => changeStatus(r, e.target.value as ClashStatus)}
                        disabled={dbBacked && !isAdmin}
                      >
                        {CLASH_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {CLASH_STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {isAdmin &&
                        (r.issueId ? (
                          <span className="muted" title="이슈 생성됨">
                            ✓이슈
                          </span>
                        ) : (
                          <button
                            className="clash-mini"
                            onClick={() => {
                              focusRow(r);
                              setIssueFor(r);
                            }}
                            title="간섭을 이슈로"
                          >
                            이슈
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {status && <div className="clash-status-bar muted">{status}</div>}
      </div>

      <div className="clash-resize" onMouseDown={startDrag('resize')} title="크기 조절" />

      {issueFor && (
        <ClashIssueModal
          viewer={viewer}
          row={issueFor}
          members={members}
          onCancel={() => setIssueFor(null)}
          onConfirm={submitIssue}
        />
      )}
    </div>
  );
}

// --- 대상 선택기(모델 → 카테고리) ----------------------------------

function SetPicker({
  tag,
  models,
  cats,
  model,
  cat,
  count,
  onModel,
  onCat,
}: {
  tag: 'A' | 'B';
  models: { modelID: number; label: string; count: number }[];
  cats: [string, number][];
  model: 'all' | number;
  cat: string;
  count: number;
  onModel: (m: 'all' | number) => void;
  onCat: (c: string) => void;
}) {
  return (
    <div className="clash-set">
      <div className={`clash-set-tag clash-set-tag-${tag.toLowerCase()}`}>대상 {tag}</div>
      <label className="clash-field">
        <span>모델</span>
        <select value={model === 'all' ? 'all' : String(model)} onChange={(e) => onModel(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <option value="all">전체 모델</option>
          {models.map((m) => (
            <option key={m.modelID} value={m.modelID}>
              {m.label} ({m.count})
            </option>
          ))}
        </select>
      </label>
      <label className="clash-field">
        <span>카테고리</span>
        <select value={cat} onChange={(e) => onCat(e.target.value)}>
          <option value="all">전체 카테고리</option>
          {cats.map(([c, n]) => (
            <option key={c} value={c}>
              {c} ({n})
            </option>
          ))}
        </select>
      </label>
      <div className="clash-set-count muted">{count}개 요소</div>
    </div>
  );
}

// --- 간섭 → 이슈 생성 모달(내용 + 4각도 스냅샷) ---------------------

function ClashIssueModal({
  viewer,
  row,
  members,
  onCancel,
  onConfirm,
}: {
  viewer: IfcViewer | null;
  row: ClashRow;
  members: ProjectMember[];
  onCancel: () => void;
  onConfirm: (input: {
    title: string;
    description: string;
    priority: IssuePriority;
    assigneeId: string | null;
    dueDate: string | null;
    shots: string[];
  }) => void;
}) {
  const [title, setTitle] = useState(`간섭: ${row.a.name || row.a.category} ↔ ${row.b.name || row.b.category}`);
  const [description, setDescription] = useState(
    `A: ${row.a.name || '(이름없음)'} [${row.a.category} #${row.a.expressID}]\n` +
      `B: ${row.b.name || '(이름없음)'} [${row.b.category} #${row.b.expressID}]\n` +
      `관통깊이 ${row.depth.toFixed(3)}m\n\n조치사항: `,
  );
  const [priority, setPriority] = useState<IssuePriority>('high');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');

  const [shots, setShots] = useState<string[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);

  // 모달이 열리면 간섭부를 비추고 4각도 스냅샷을 캡처.
  useEffect(() => {
    if (!viewer) return;
    viewer.showClash(row.a, row.b);
    const s = viewer.captureClashViews(row.a, row.b, 4);
    setShots(s);
    setPicked(s.map(() => true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (i: number) => setPicked((p) => p.map((v, j) => (j === i ? !v : v)));

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>간섭 → 이슈 생성</h3>
          <span className="muted">내용 작성 + 첨부할 각도를 선택하세요. 담당자·마감 지정 시 알림(S30).</span>
        </div>
        <div className="modal-body clash-issue-form">
          <label className="clash-field">
            <span>제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="clash-field">
            <span>내용</span>
            <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="clash-row2">
            <label className="clash-field">
              <span>우선순위</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                {ISSUE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="clash-field">
              <span>마감일</span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          </div>
          <label className="clash-field">
            <span>담당자</span>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— 미지정 —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="clash-field">
            <span>스냅샷 첨부 (각도 선택)</span>
            <div className="clash-shots">
              {shots.length === 0 && <span className="muted">캡처 중…</span>}
              {shots.map((s, i) => (
                <button
                  type="button"
                  key={i}
                  className={`clash-shot${picked[i] ? ' is-on' : ''}`}
                  onClick={() => toggle(i)}
                  title={picked[i] ? '첨부됨 — 클릭 시 제외' : '제외됨 — 클릭 시 첨부'}
                >
                  <img src={s} alt={`각도 ${i + 1}`} />
                  <span className="clash-shot-check">{picked[i] ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>취소</button>
          <button
            className="primary"
            disabled={!title.trim()}
            onClick={() =>
              onConfirm({
                title: title.trim(),
                description,
                priority,
                assigneeId: assigneeId || null,
                dueDate: dueDate || null,
                shots: shots.filter((_, i) => picked[i]),
              })
            }
          >
            이슈 생성
          </button>
        </div>
      </div>
    </div>
  );
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}
