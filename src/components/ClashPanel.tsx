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
import { useAuth } from '../auth/AuthProvider';

interface Props {
  viewer: IfcViewer | null;
  projectId: string;
  /** 런타임 modelID → DB 모델 uuid(이슈 핀·저장 매핑용). */
  modelIdMap: Map<number, string>;
  onClose: () => void;
}

/** 대상 집합(Set A/B) 선택 옵션. */
interface SetOption {
  id: string;
  label: string;
  filter: (m: ElementMeta) => boolean;
  count: number;
}

/**
 * 충돌검사(Clash Detective) 도킹 패널 — 공정관리(4D) 뷰어 우측 드로어.
 * 대상 집합 A vs B(모델/카테고리/전체) + 허용오차로 Hard/Clearance 간섭을 검출하고,
 * 결과 행 클릭 시 양쪽 객체 하이라이트 + 카메라 fit + 간섭점 마커. 간섭 → 이슈 전환,
 * 결과 DB 저장/불러오기, CSV 내보내기(D13 / 0015_clash.sql).
 */
export function ClashPanel({ viewer, projectId, modelIdMap, onClose }: Props) {
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [meta, setMeta] = useState<ElementMeta[]>([]);
  const [setAId, setSetAId] = useState('all');
  const [setBId, setSetBId] = useState('all');
  const [type, setType] = useState<ClashType>('hard');
  const [tolerance, setTolerance] = useState(0.01);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ ratio: number; phase: string } | null>(null);
  const cancelRef = useRef(false);

  const [rows, setRows] = useState<ClashRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isolate, setIsolate] = useState(false);
  const [dbBacked, setDbBacked] = useState(false);
  const [status, setStatus] = useState('');

  // 결과 DB 저장/불러오기
  const [tests, setTests] = useState<ClashTestMeta[]>([]);
  const [selTest, setSelTest] = useState('');

  // 간섭 → 이슈 모달
  const [issueFor, setIssueFor] = useState<ClashRow | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);

  // 대상 메타 읽기(모델이 열려 있어야 함).
  const refreshTargets = () => {
    if (!viewer) return;
    setMeta(viewer.getElementMeta());
  };

  useEffect(() => {
    refreshTargets();
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
      /* 0015 미적용/권한 — 조용히 무시 */
    }
  };

  // 집합 옵션: 전체 / 모델별 / 카테고리별.
  const options: SetOption[] = useMemo(() => {
    const opts: SetOption[] = [
      { id: 'all', label: '전체', filter: () => true, count: meta.length },
    ];
    for (const m of viewer?.getLoadedModels() ?? []) {
      opts.push({
        id: `model:${m.modelID}`,
        label: `모델: ${m.label}`,
        filter: (e) => e.modelID === m.modelID,
        count: m.count,
      });
    }
    const cats = new Map<string, number>();
    for (const e of meta) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
    for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
      opts.push({
        id: `cat:${cat}`,
        label: `카테고리: ${cat}`,
        filter: (e) => e.category === cat,
        count,
      });
    }
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, viewer]);

  const optA = options.find((o) => o.id === setAId) ?? options[0];
  const optB = options.find((o) => o.id === setBId) ?? options[0];

  const summary = useMemo(() => {
    const total = rows.length;
    const open = rows.filter((r) => OPEN_CLASH_STATUSES.includes(r.status)).length;
    return { total, open, closed: total - open };
  }, [rows]);

  const run = async () => {
    if (!viewer || meta.length === 0) {
      setStatus('먼저 IFC 모델을 여세요. (대상 갱신 후 검사)');
      return;
    }
    const itemsA = meta.filter(optA.filter);
    const itemsB = meta.filter(optB.filter);
    if (itemsA.length === 0 || itemsB.length === 0) {
      setStatus('선택한 집합에 요소가 없습니다.');
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
      const next: ClashRow[] = hits.map((h) => ({ ...h, status: 'new' as ClashStatus, issueId: null }));
      setRows(next);
      setStatus(
        cancelRef.current
          ? '검사 취소됨'
          : `검사 완료: 간섭 ${next.length}건 (대상 A ${itemsA.length} × B ${itemsB.length})`,
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
    if (isolate) viewer.isolateClashPair(r.a, r.b);
    viewer.showClash(r.a, r.b, r.point);
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
    if (rows.length === 0 || !projectId) return;
    const name = window.prompt('저장할 검사 이름', `간섭검사 ${new Date().toLocaleString()}`);
    if (!name) return;
    try {
      const id = await saveClashTest({
        projectId,
        name,
        setA: optA.label,
        setB: optB.label,
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
      const next = loadedToRows(loaded, inverse);
      setRows(next);
      setDbBacked(true);
      setActiveId(null);
      const meta = tests.find((t) => t.id === selTest);
      if (meta) {
        setType(meta.type);
        setTolerance(meta.tolerance);
      }
      setStatus(`불러옴: ${meta?.name ?? selTest} · ${next.length}건`);
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
    if (rows.length === 0) return;
    downloadCsv(`clash_${Date.now()}.csv`, clashesToCsv(rows));
  };

  // 간섭 → 이슈 생성 확정.
  const createIssueForClash = async (input: {
    title: string;
    priority: IssuePriority;
    assigneeId: string | null;
    dueDate: string | null;
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
          description:
            `충돌검사에서 생성됨.\n` +
            `A: ${r.a.name || '(이름없음)'} [${r.a.category} #${r.a.expressID}]\n` +
            `B: ${r.b.name || '(이름없음)'} [${r.b.category} #${r.b.expressID}]\n` +
            `간섭점: (${r.point.x.toFixed(2)}, ${r.point.y.toFixed(2)}, ${r.point.z.toFixed(2)}) · 관통깊이 ${r.depth.toFixed(3)}m`,
          priority: input.priority,
          assignee_id: input.assigneeId,
          assignee_name: assignee?.name,
          due_date: input.dueDate,
          model_id: modelDbId,
          express_id: r.a.expressID,
        },
        authorName,
      );
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, issueId, status: 'reviewing' } : x)));
      if (dbBacked) {
        try {
          await linkClashIssue(r.id, issueId);
          await setClashStatus(r.id, 'reviewing');
        } catch {
          /* 링크는 편의 — 비치명적 */
        }
      }
      setIssueFor(null);
      setStatus(`이슈 생성됨 — 협업·이슈에서 확인 (객체 #${r.a.expressID})`);
    } catch (e) {
      setStatus(`이슈 생성 실패: ${(e as Error).message}`);
    }
  };

  return (
    <aside className="clash-panel">
      <div className="clash-head">
        <h3>🔍 충돌검사</h3>
        <button className="clash-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      {/* 설정 */}
      <div className="clash-setup">
        <label className="clash-field">
          <span>대상 A</span>
          <select value={setAId} onChange={(e) => setSetAId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </label>
        <label className="clash-field">
          <span>대상 B</span>
          <select value={setBId} onChange={(e) => setSetBId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </label>
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

      {/* 요약 + 결과 도구 */}
      {rows.length > 0 && (
        <div className="clash-summary">
          <span className="clash-chip">총 {summary.total}</span>
          <span className="clash-chip clash-chip-open">미해결 {summary.open}</span>
          <span className="clash-chip clash-chip-closed">처리 {summary.closed}</span>
          <span className="spacer" />
          <label className="clash-check" title="간섭 객체만 보기">
            <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
            격리
          </label>
          <button onClick={showAll} title="모두 표시 + 마커 제거">
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

      {/* DB 불러오기 */}
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

      {/* 결과 목록 */}
      <div className="clash-results">
        {rows.length === 0 ? (
          <p className="muted clash-empty">
            대상 A·B 와 허용오차를 정하고 <b>검사 실행</b> 을 누르세요. 결과 행을 클릭하면 양쪽
            객체가 하이라이트되고 간섭점으로 카메라가 이동합니다.
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
                <tr
                  key={r.id}
                  className={r.id === activeId ? 'is-active' : undefined}
                  onClick={() => focusRow(r)}
                >
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
                        <button className="clash-mini" onClick={() => setIssueFor(r)} title="간섭을 이슈로">
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

      {issueFor && (
        <ClashIssueModal
          row={issueFor}
          members={members}
          onCancel={() => setIssueFor(null)}
          onConfirm={createIssueForClash}
        />
      )}
    </aside>
  );
}

// --- 간섭 → 이슈 생성 모달 ------------------------------------------

function ClashIssueModal({
  row,
  members,
  onCancel,
  onConfirm,
}: {
  row: ClashRow;
  members: ProjectMember[];
  onCancel: () => void;
  onConfirm: (input: {
    title: string;
    priority: IssuePriority;
    assigneeId: string | null;
    dueDate: string | null;
  }) => void;
}) {
  const [title, setTitle] = useState(
    `간섭: ${row.a.name || row.a.category} ↔ ${row.b.name || row.b.category}`,
  );
  const [priority, setPriority] = useState<IssuePriority>('high');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>간섭 → 이슈 생성</h3>
          <span className="muted">담당자·마감을 지정하면 알림이 전송됩니다(S30).</span>
        </div>
        <div className="modal-body clash-issue-form">
          <label className="clash-field">
            <span>제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
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
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>취소</button>
          <button
            className="primary"
            disabled={!title.trim()}
            onClick={() =>
              onConfirm({
                title: title.trim(),
                priority,
                assigneeId: assigneeId || null,
                dueDate: dueDate || null,
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
