import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import {
  createIssue,
  listIssues,
  OPEN_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  dueDeltaLabel,
  type Issue,
} from '../lib/issues';
import { IfcViewer, type ElementMeta, type UpAxis } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { useAuth } from '../auth/AuthProvider';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { Timeline } from '../components/Timeline';
import { ClashPanel } from '../components/ClashPanel';
import { ViewpointPanel } from '../components/ViewpointPanel';
import { MarkupOverlay, type MarkupTool } from '../components/MarkupOverlay';
import { REDLINE_COLORS, type DisplayState, type MarkupShape, type RedlineColor } from '../lib/viewpoints';
import {
  downloadModelBytes,
  listModels,
  uploadModel,
  type ModelPurpose,
  type ModelRecord,
} from '../lib/api';
import {
  listFiles,
  sizeLabel as fileSizeLabel,
  type FileRecord,
} from '../lib/files';
import { uploadNewFile } from '../lib/cde';

/**
 * 3D 뷰어 모듈의 용도. 모델 풀은 셋이 공유한다(통합모델에 올린 모델이 4D·간섭체크
 * 에도 보임). 각 모듈은 진입 시 **프로젝트의 모든 모델을 자동 로드**하고, 자기 IfcViewer
 * 인스턴스를 가지므로 4D 공정 매핑이 간섭체크 화면을 방해하지 않는다.
 *  - integrated: 통합모델 3D. 모델 트리 + 업로드 + 이슈 생성/이슈 핀 토글.
 *  - 4d: 공정관리. 트리 숨김(메인 확대) + 하단 4D 타임라인.
 *  - clash: 간섭체크. 트리 숨김(메인 확대) + 간섭체크 결과 팝업.
 */
export type ViewerMode = ModelPurpose;

const MODE_TITLE: Record<ViewerMode, string> = {
  integrated: '통합모델 (3D)',
  '4d': '공정관리 (4D)',
  clash: '간섭체크',
};

export function Workspace({ mode = 'integrated' }: { mode?: ViewerMode } = {}) {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const showTree = mode === 'integrated';

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);

  const [models, setModels] = useState<ModelRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<FileRecord[]>([]);
  const [docUploading, setDocUploading] = useState(false);
  const docInput = useRef<HTMLInputElement>(null);

  // 런타임 modelID → DB 모델 uuid (4D 매핑·간섭 저장·이슈 핀 매핑용).
  const [modelIdMap, setModelIdMap] = useState<Map<number, string>>(new Map());
  const loadedAllRef = useRef(false);

  const [showClash, setShowClash] = useState(mode === 'clash');

  // 통합모델: 이슈 핀(객체에 연결된 이슈 마커) 표시/숨김 + 핀 클릭 팝업.
  const [issues, setIssues] = useState<Issue[]>([]);
  const [showPins, setShowPins] = useState(true);
  const [pinPopup, setPinPopup] = useState<{ issue: Issue; x: number; y: number } | null>(null);
  const navigate = useNavigate();

  // 측정 / 단면(클리핑) — 범용 리뷰 도구.
  const [measureOn, setMeasureOn] = useState(false);
  const [measureMsg, setMeasureMsg] = useState<string | null>(null);
  const [sectionOn, setSectionOn] = useState(false);
  const [sectionAxis, setSectionAxis] = useState<'x' | 'y' | 'z'>('y');
  const [sectionOffset, setSectionOffset] = useState(0.5);
  const [sectionFlip, setSectionFlip] = useState(false);

  // 저장 뷰포인트 + 마크업(redline).
  const [showViewpoints, setShowViewpoints] = useState(false);
  const [markupOn, setMarkupOn] = useState(false);
  const [markupTool, setMarkupTool] = useState<MarkupTool>('arrow');
  const [markupColor, setMarkupColor] = useState<RedlineColor>('red');
  const [markupShapes, setMarkupShapes] = useState<MarkupShape[]>([]);

  // 통합모델: 모델/카테고리별 표시 토글(보고 싶은 것만 선택).
  const [meta, setMeta] = useState<ElementMeta[]>([]);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set());
  const [showCats, setShowCats] = useState(false);

  const { status, setStatus, setSelected, setModelCount, selected } = useStore();

  // 이슈 '위치 보기'로 진입하면 location.state.focus 로 대상 객체가 전달된다.
  const location = useLocation();
  const locState =
    (location.state as {
      focus?: { modelDbId: string; expressID: number };
      openViewpoint?: string;
    } | null) ?? null;
  const focus = locState?.focus ?? null;
  const openViewpoint = locState?.openViewpoint ?? null;
  const focusHandledRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    (window as unknown as { __mirUpAxis?: (a: UpAxis) => void }).__mirUpAxis = (a) => v.setUpAxis(a);
    setViewer(v);
    return () => v.dispose();
  }, [setSelected]);

  useEffect(() => {
    refreshModels();
    if (showTree) refreshFiles();
    if (mode === 'integrated') listIssues(projectId).then(setIssues).catch(() => setIssues([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode]);

  // 모델 풀은 모듈 공유(전체 조회). 4D/간섭은 통합모델에 올린 모델을 그대로 본다.
  const refreshModels = () => listModels(projectId).then(setModels).catch(() => setModels([]));
  const refreshFiles = () => listFiles(projectId).then(setFiles).catch(() => setFiles([]));

  // 모드 전환 시 4D 시공 시뮬 상태가 다른 모듈로 새지 않게 정리한다. 라우터가 세 모듈을
  // 같은 Workspace 컴포넌트(=같은 IfcViewer 인스턴스)로 렌더하므로, mode 가 바뀌어도
  // 뷰어가 재생성되지 않는다 → 4D 가 아니면 시공 오버라이드를 풀고 전체 표시로 되돌린다.
  useEffect(() => {
    if (!viewer) return;
    if (mode !== '4d') {
      viewer.clearConstruction();
      viewer.showAll();
    }
  }, [viewer, mode]);

  // 진입 시 프로젝트의 모든 모델을 자동 로드(클릭 불필요). 통합모델에 업로드만 하면
  // 세 모듈 모두에서 자동으로 보인다.
  useEffect(() => {
    if (!viewer || models.length === 0 || loadedAllRef.current) return;
    loadedAllRef.current = true;
    void loadAllModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, models]);

  const loadOne = async (m: ModelRecord) => {
    if (!viewer) return;
    const bytes = await downloadModelBytes(m.storage_path);
    const saved = loadUpAxisPref(m.id);
    await viewer.loadIfc(bytes, { label: m.name, ...(saved ? { upAxis: saved } : {}) });
    if (viewer.primaryModelID != null) {
      const rid = viewer.primaryModelID;
      setModelIdMap((prev) => new Map(prev).set(rid, m.id));
    }
  };

  const loadAllModels = async () => {
    if (!viewer) return;
    let ok = 0;
    for (const m of models) {
      setStatus(`불러오는 중: ${m.name} (${ok + 1}/${models.length})`);
      try {
        await loadOne(m);
        ok++;
      } catch (e) {
        setStatus(`불러오기 실패: ${m.name} — ${errMessage(e)}`);
      }
    }
    setModelCount(viewer.modelCount);
    // 4D/간섭은 시공 시뮬 상태가 끼지 않도록 항상 전체 표시로 시작.
    if (mode !== '4d') {
      viewer.clearConstruction();
      viewer.showAll();
    }
    setStatus(ok ? `불러옴: 모델 ${ok}개` : '표시할 모델이 없습니다.');
  };

  // 이슈에 연결된 객체로 카메라 이동(위치 보기). 모든 모델 로드 후 매핑으로 해석.
  useEffect(() => {
    if (!focus || focusHandledRef.current || !viewer) return;
    let runtime: number | null = null;
    for (const [rid, db] of modelIdMap.entries()) if (db === focus.modelDbId) runtime = rid;
    if (runtime == null) return; // 아직 로드 전
    focusHandledRef.current = true;
    const ok = viewer.focusElement(runtime, focus.expressID);
    if (!ok) setStatus('연결된 객체를 찾지 못했습니다(모델이 변경되었을 수 있음).');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, modelIdMap, focus]);

  // 통합모델: 로드된 모델에 연결된 이슈에 핀(미해결=빨강/완료=초록)을 찍는다.
  useEffect(() => {
    if (!viewer || mode !== 'integrated') return;
    const dbToRuntime = new Map<string, number>();
    for (const [rid, db] of modelIdMap.entries()) dbToRuntime.set(db, rid);
    const pins = issues
      .filter((i) => i.model_id && i.express_id != null && dbToRuntime.has(i.model_id))
      .map((i) => ({
        modelID: dbToRuntime.get(i.model_id as string) as number,
        expressID: i.express_id as number,
        color: OPEN_STATUSES.includes(i.status) ? 0xdc2626 : 0x16a34a,
        issueId: i.id,
      }));
    viewer.setIssuePins(pins);
    viewer.setIssuePinsVisible(showPins);
  }, [viewer, mode, issues, modelIdMap, showPins]);

  // 핀 클릭 → 이슈 상세 미니 팝업.
  useEffect(() => {
    if (!viewer) return;
    viewer.setOnIssuePin((id, x, y) => {
      const issue = issues.find((i) => i.id === id);
      if (issue) setPinPopup({ issue, x, y });
    });
  }, [viewer, issues]);

  // 통합모델: 모델이 로드되면 요소 메타(카테고리)를 읽어 표시 토글에 쓴다.
  useEffect(() => {
    if (viewer && mode === 'integrated') setMeta(viewer.getElementMeta());
  }, [viewer, mode, modelIdMap]);

  const catByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of meta) m.set(`${e.modelID}:${e.expressID}`, e.category);
    return m;
  }, [meta]);
  const categories = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of meta) c.set(e.category, (c.get(e.category) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [meta]);

  // 표시 토글 적용(모델 OR 카테고리 숨김이면 비표시).
  useEffect(() => {
    if (!viewer || mode !== 'integrated') return;
    if (hiddenModels.size === 0 && hiddenCats.size === 0) {
      viewer.showAll();
      return;
    }
    viewer.applyVisibility((mid, eid) => {
      const db = modelIdMap.get(mid);
      if (db && hiddenModels.has(db)) return false;
      const cat = catByKey.get(`${mid}:${eid}`);
      if (cat && hiddenCats.has(cat)) return false;
      return true;
    });
  }, [viewer, mode, hiddenModels, hiddenCats, modelIdMap, catByKey]);

  // 측정 모드 토글 + 메시지 콜백.
  useEffect(() => {
    if (!viewer) return;
    viewer.setOnMeasure(setMeasureMsg);
    viewer.setMeasureMode(measureOn);
  }, [viewer, measureOn]);

  // 단면(클리핑) 적용.
  useEffect(() => {
    if (!viewer) return;
    viewer.setSection({ enabled: sectionOn, axis: sectionAxis, offset: sectionOffset, flip: sectionFlip });
  }, [viewer, sectionOn, sectionAxis, sectionOffset, sectionFlip]);

  const toggleModel = (dbId: string) =>
    setHiddenModels((s) => {
      const n = new Set(s);
      n.has(dbId) ? n.delete(dbId) : n.add(dbId);
      return n;
    });
  const toggleCat = (cat: string) =>
    setHiddenCats((s) => {
      const n = new Set(s);
      n.has(cat) ? n.delete(cat) : n.add(cat);
      return n;
    });

  // 마크업 그리기를 켜면 측정 모드와 충돌하지 않게 측정을 끈다(둘 다 클릭을 가로챔).
  useEffect(() => {
    if (markupOn && measureOn) setMeasureOn(false);
  }, [markupOn, measureOn]);

  // 이슈 → 뷰포인트 딥링크로 진입하면 뷰포인트 패널을 연다.
  useEffect(() => {
    if (openViewpoint) setShowViewpoints(true);
  }, [openViewpoint]);

  // 뷰포인트 저장/복원용 표시상태(모델/카테고리 숨김 + 단면).
  const getDisplayState = (): DisplayState => ({
    hiddenModels: [...hiddenModels],
    hiddenCats: [...hiddenCats],
    section: { enabled: sectionOn, axis: sectionAxis, offset: sectionOffset, flip: sectionFlip },
  });
  const applyDisplayState = (d: DisplayState) => {
    setHiddenModels(new Set(d.hiddenModels ?? []));
    setHiddenCats(new Set(d.hiddenCats ?? []));
    if (d.section) {
      setSectionOn(d.section.enabled);
      setSectionAxis(d.section.axis);
      setSectionOffset(d.section.offset);
      setSectionFlip(d.section.flip);
    }
  };

  // 뷰포인트 저장 컨텍스트: 단일 모델 프로젝트면 그 모델, 다중이면 장면 전체(null).
  const modelDbId = modelIdMap.size === 1 ? [...modelIdMap.values()][0] : null;

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(`업로드 중: ${file.name}`);
    try {
      const rec = await uploadModel(projectId, file); // 공유 풀(기본 integrated)
      await refreshModels();
      await loadOne(rec); // 방금 올린 모델을 현재 화면에도 즉시 표시
      setModelCount(viewer?.modelCount ?? 0);
      setStatus(`업로드 완료: ${file.name}`);
    } catch (err) {
      setStatus(`업로드 실패: ${errMessage(err)}`);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onUploadDoc = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocUploading(true);
    setStatus(`업로드 중: ${file.name}`);
    try {
      await uploadNewFile(projectId, null, file);
      await refreshFiles();
      setStatus(`업로드 완료: ${file.name}`);
    } catch (err) {
      setStatus(`업로드 실패: ${errMessage(err)}`);
    } finally {
      setDocUploading(false);
      if (docInput.current) docInput.current.value = '';
    }
  };

  const openFile = (f: FileRecord) => window.open(`/view/${f.id}`, '_blank', 'noopener');

  // 통합모델 트리에서 모델 클릭 → 그 모델로 카메라 맞춤(이미 로드돼 있음).
  const frameModel = (m: ModelRecord) => {
    if (!viewer) return;
    for (const [rid, db] of modelIdMap.entries()) if (db === m.id) viewer.fitModel(rid);
  };

  // 선택한 3D 객체에 연결된 이슈 생성(관리자).
  const selectedModelDbId = selected ? modelIdMap.get(selected.modelID) ?? null : null;
  const onCreateIssueFromSelection = async () => {
    if (!selected) return;
    const title = window.prompt(`선택 객체(#${selected.expressID})에 연결할 이슈 제목`);
    if (!title?.trim()) return;
    try {
      await createIssue(
        projectId,
        { title: title.trim(), priority: 'normal', model_id: selectedModelDbId, express_id: selected.expressID },
        profile?.full_name ?? profile?.username ?? null,
      );
      setStatus(`이슈 생성됨 (객체 #${selected.expressID}) — 협업·이슈에서 확인`);
      if (mode === 'integrated') listIssues(projectId).then(setIssues).catch(() => {});
    } catch (e) {
      setStatus(`이슈 생성 실패: ${errMessage(e)}`);
    }
  };

  const pinnedCount = useMemo(
    () => issues.filter((i) => i.model_id && i.express_id != null).length,
    [issues],
  );

  return (
    <div className="mod-fill viewer-fill">
      {showTree && (
        <aside className="mod-subtree">
          <div className="sidebar-head">
            <h2>모델</h2>
            <input ref={fileInput} type="file" accept=".ifc" style={{ display: 'none' }} onChange={onUpload} />
            {isAdmin && (
              <button onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중…' : 'IFC 업로드'}
              </button>
            )}
          </div>
          <ul className="model-list">
            {models.map((m) => (
              <li key={m.id} className="model-row">
                <input
                  type="checkbox"
                  className="model-check"
                  checked={!hiddenModels.has(m.id)}
                  onChange={() => toggleModel(m.id)}
                  title="표시/숨김"
                />
                <button className="model-item" onClick={() => frameModel(m)} title={`${m.name} — 카메라 맞춤`}>
                  <span className="model-name">{m.name}</span>
                  <span className="muted">{sizeLabel(m.size_bytes)}</span>
                </button>
              </li>
            ))}
            {models.length === 0 && <li className="muted empty">등록된 모델이 없습니다. IFC를 업로드하세요.</li>}
          </ul>

          {categories.length > 0 && (
            <>
              <div className="sidebar-head">
                <h2>카테고리</h2>
                <button onClick={() => setShowCats((v) => !v)} title="카테고리 표시 토글">
                  {showCats ? '접기' : `펼치기 (${categories.length})`}
                </button>
              </div>
              {showCats && (
                <ul className="model-list cat-list">
                  {hiddenCats.size > 0 && (
                    <li>
                      <button className="model-item cat-clear" onClick={() => setHiddenCats(new Set())}>
                        전체 표시로 초기화
                      </button>
                    </li>
                  )}
                  {categories.map(([c, n]) => (
                    <li key={c} className="model-row">
                      <input
                        type="checkbox"
                        className="model-check"
                        checked={!hiddenCats.has(c)}
                        onChange={() => toggleCat(c)}
                        title="표시/숨김"
                      />
                      <span className="cat-name" title={c}>
                        {c}
                      </span>
                      <span className="muted">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="sidebar-head">
            <h2>문서 · 미디어</h2>
            <input ref={docInput} type="file" style={{ display: 'none' }} onChange={onUploadDoc} />
            {isAdmin && (
              <button onClick={() => docInput.current?.click()} disabled={docUploading}>
                {docUploading ? '업로드 중…' : '파일 업로드'}
              </button>
            )}
          </div>
          <ul className="model-list">
            {files.map((f) => (
              <li key={f.id}>
                <button className="model-item" onClick={() => openFile(f)} title={`${f.name} — 새 탭에서 미리보기`}>
                  <span className="model-name">{f.name}</span>
                  <span className="muted">{fileSizeLabel(f.size_bytes)}</span>
                </button>
              </li>
            ))}
            {files.length === 0 && <li className="muted empty">등록된 문서가 없습니다.</li>}
          </ul>
        </aside>
      )}

      <div className="mod-main viewer-main">
        <div className="viewer-bar">
          <span className="viewer-mode-title">{MODE_TITLE[mode]}</span>
          <span className="tl-divider" />
          <Toolbar viewer={viewer} />
          {isAdmin && selected && (
            <button onClick={onCreateIssueFromSelection}>＋ 선택 객체로 이슈</button>
          )}
          {mode === 'integrated' && pinnedCount > 0 && (
            <label className="clash-check" title="이슈 위치 핀 표시/숨김">
              <input type="checkbox" checked={showPins} onChange={(e) => setShowPins(e.target.checked)} />
              이슈 핀 {pinnedCount}
            </label>
          )}
          {mode === 'clash' && (
            <button
              className={showClash ? 'is-active' : undefined}
              onClick={() => setShowClash((v) => !v)}
              title="간섭체크 결과 창 열기/닫기"
            >
              🔍 간섭체크 결과
            </button>
          )}

          <span className="tl-divider" />
          <button
            className={measureOn ? 'is-active' : undefined}
            onClick={() => setMeasureOn((v) => !v)}
            title="두 점을 클릭해 거리 측정"
          >
            📏 측정
          </button>
          {measureOn && (
            <button onClick={() => viewer?.clearMeasurements()} title="측정 지우기">
              지우기
            </button>
          )}
          <button
            className={sectionOn ? 'is-active' : undefined}
            onClick={() => setSectionOn((v) => !v)}
            title="단면(클리핑 평면)"
          >
            ✂ 단면
          </button>
          {sectionOn && (
            <span className="section-ctrls">
              <select value={sectionAxis} onChange={(e) => setSectionAxis(e.target.value as 'x' | 'y' | 'z')}>
                <option value="x">X</option>
                <option value="y">Y</option>
                <option value="z">Z</option>
              </select>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={sectionOffset}
                onChange={(e) => setSectionOffset(Number(e.target.value))}
                title="단면 위치"
              />
              <button onClick={() => setSectionFlip((v) => !v)} title="단면 방향 뒤집기">
                ⇄
              </button>
            </span>
          )}

          <span className="tl-divider" />
          <button
            className={showViewpoints ? 'is-active' : undefined}
            onClick={() => setShowViewpoints((v) => !v)}
            title="저장 뷰포인트 패널"
          >
            📌 뷰포인트
          </button>
          <button
            className={markupOn ? 'is-active' : undefined}
            onClick={() => setMarkupOn((v) => !v)}
            title="2D 마크업(redline) 그리기"
          >
            ✎ 마크업
          </button>
          {markupOn && (
            <span className="markup-ctrls">
              <select value={markupTool} onChange={(e) => setMarkupTool(e.target.value as MarkupTool)} title="도구">
                <option value="arrow">화살표</option>
                <option value="line">선</option>
                <option value="rect">사각형</option>
                <option value="text">텍스트</option>
              </select>
              <span className="markup-swatches">
                {REDLINE_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`markup-swatch markup-swatch-${c}${markupColor === c ? ' is-on' : ''}`}
                    onClick={() => setMarkupColor(c)}
                    title={c}
                  />
                ))}
              </span>
              <button onClick={() => setMarkupShapes([])} disabled={markupShapes.length === 0} title="마크업 지우기">
                지우기
              </button>
            </span>
          )}

          <div className="spacer" />
          {measureMsg && <span className="muted measure-msg">{measureMsg}</span>}
          <span className="muted">{status}</span>
          <span className="muted">· 모델 {viewer?.modelCount ?? 0}개</span>
        </div>
        <div className="viewport-wrap">
          <div className="viewport" ref={containerRef} />
          <MarkupOverlay
            shapes={markupShapes}
            onChange={setMarkupShapes}
            active={markupOn}
            tool={markupTool}
            color={markupColor}
          />
        </div>
        <PropertiesPanel />
        {pinPopup && (
          <div
            className="pin-popup"
            style={{ left: pinPopup.x + 12, top: pinPopup.y + 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pin-popup-head">
              <span className={`issue-status-dot issue-status-${pinPopup.issue.status}`} />
              <strong>{pinPopup.issue.title}</strong>
              <button className="clash-x" onClick={() => setPinPopup(null)} title="닫기">
                ✕
              </button>
            </div>
            <div className="pin-popup-meta muted">
              {STATUS_LABEL[pinPopup.issue.status]} · {PRIORITY_LABEL[pinPopup.issue.priority]}
              {pinPopup.issue.assignee_name ? ` · 담당 ${pinPopup.issue.assignee_name}` : ''}
              {pinPopup.issue.due_date ? ` · 마감 ${pinPopup.issue.due_date} (${dueDeltaLabel(pinPopup.issue.due_date)})` : ''}
            </div>
            {pinPopup.issue.description && (
              <p className="pin-popup-desc">{pinPopup.issue.description}</p>
            )}
            <div className="pin-popup-foot">
              <button
                onClick={() => {
                  const exp = pinPopup.issue.express_id;
                  const dbId = pinPopup.issue.model_id;
                  let rid: number | null = null;
                  for (const [r, db] of modelIdMap.entries()) if (db === dbId) rid = r;
                  if (rid != null && exp != null) viewer?.focusElement(rid, exp);
                }}
                title="객체로 카메라 이동"
              >
                객체 보기
              </button>
              <button
                className="primary"
                onClick={() =>
                  navigate(`/project/${projectId}/issues`, { state: { focusIssueId: pinPopup.issue.id } })
                }
              >
                이슈로 이동
              </button>
            </div>
          </div>
        )}
        {mode === 'clash' && showClash && (
          <ClashPanel viewer={viewer} projectId={projectId} modelIdMap={modelIdMap} onClose={() => setShowClash(false)} />
        )}
        {showViewpoints && (
          <ViewpointPanel
            viewer={viewer}
            projectId={projectId}
            modelDbId={modelDbId}
            isAdmin={isAdmin}
            authorName={profile?.full_name ?? profile?.username ?? null}
            getDisplayState={getDisplayState}
            applyDisplayState={applyDisplayState}
            markup={markupShapes}
            setMarkup={setMarkupShapes}
            autoOpenId={openViewpoint}
            onClose={() => setShowViewpoints(false)}
          />
        )}
        {mode === '4d' && <Timeline viewer={viewer} projectId={projectId} modelIdMap={modelIdMap} />}
      </div>
    </div>
  );
}

const UP_AXIS_KEY = (modelId: string) => `mir.upaxis.${modelId}`;

function loadUpAxisPref(modelId: string): UpAxis | null {
  const v = localStorage.getItem(UP_AXIS_KEY(modelId));
  return v === 'x' || v === 'y' || v === 'z' ? v : null;
}

function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
