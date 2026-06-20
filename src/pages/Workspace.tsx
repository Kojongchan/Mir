import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { createIssue, listIssues, OPEN_STATUSES, type Issue } from '../lib/issues';
import { IfcViewer, type UpAxis } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { useAuth } from '../auth/AuthProvider';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { Timeline } from '../components/Timeline';
import { ClashPanel } from '../components/ClashPanel';
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

  // 통합모델: 이슈 핀(객체에 연결된 이슈 마커) 표시/숨김.
  const [issues, setIssues] = useState<Issue[]>([]);
  const [showPins, setShowPins] = useState(true);

  const { status, setStatus, setSelected, setModelCount, selected } = useStore();

  // 이슈 '위치 보기'로 진입하면 location.state.focus 로 대상 객체가 전달된다.
  const location = useLocation();
  const focus =
    (location.state as { focus?: { modelDbId: string; expressID: number } } | null)?.focus ?? null;
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
      }));
    viewer.setIssuePins(pins);
    viewer.setIssuePinsVisible(showPins);
  }, [viewer, mode, issues, modelIdMap, showPins]);

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
              <li key={m.id}>
                <button className="model-item" onClick={() => frameModel(m)} title={`${m.name} — 카메라 맞춤`}>
                  <span className="model-name">{m.name}</span>
                  <span className="muted">{sizeLabel(m.size_bytes)}</span>
                </button>
              </li>
            ))}
            {models.length === 0 && <li className="muted empty">등록된 모델이 없습니다. IFC를 업로드하세요.</li>}
          </ul>

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
          <div className="spacer" />
          <span className="muted">{status}</span>
          <span className="muted">· 모델 {viewer?.modelCount ?? 0}개</span>
        </div>
        <div className="viewport" ref={containerRef} />
        <PropertiesPanel />
        {mode === 'clash' && showClash && (
          <ClashPanel viewer={viewer} projectId={projectId} modelIdMap={modelIdMap} onClose={() => setShowClash(false)} />
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
