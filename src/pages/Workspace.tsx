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
  getModel,
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

/** 3D 뷰어 모듈의 용도. 각 모듈은 자기 용도의 모델 세트만 본다(S33). */
export type ViewerMode = ModelPurpose;

const MODE_TEXT: Record<ViewerMode, { title: string; modelHead: string; upload: string; empty: string }> = {
  integrated: {
    title: '통합모델 (3D)',
    modelHead: '통합모델',
    upload: 'IFC 업로드',
    empty: '등록된 통합모델이 없습니다.',
  },
  '4d': {
    title: '공정관리 (4D)',
    modelHead: '4D 모델',
    upload: '4D IFC 업로드',
    empty: '4D용 모델이 없습니다. (통합모델과 별도로 업로드)',
  },
  clash: {
    title: '간섭체크',
    modelHead: '간섭 모델',
    upload: '간섭 IFC 업로드',
    empty: '간섭체크용 모델이 없습니다. (통합모델과 별도로 업로드)',
  },
};

/**
 * 3D 뷰어 모듈 — 포털 셸 안에서 렌더된다(좌측 모듈 레일은 셸이 유지).
 * `mode` 로 용도를 구분한다(S33):
 *  - integrated: 통합모델 3D. 이슈 생성 + 이슈 핀 표시/숨김 토글.
 *  - 4d: 공정관리. 하단 4D 타임라인(공정표 매핑).
 *  - clash: 간섭체크. 우측 충돌검사 패널.
 * 각 모듈은 자기 용도(purpose)의 모델만 목록·업로드하므로 서로 간섭하지 않는다.
 */
export function Workspace({ mode = 'integrated' }: { mode?: ViewerMode } = {}) {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const text = MODE_TEXT[mode];

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);

  const [models, setModels] = useState<ModelRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<FileRecord[]>([]);
  const [docUploading, setDocUploading] = useState(false);
  const docInput = useRef<HTMLInputElement>(null);

  const openModelId = useRef<string | null>(null);
  const [openModelDbId, setOpenModelDbId] = useState<string | null>(null);
  const autoOpenedRef = useRef(false); // 마지막으로 보던 모델 자동 복원 1회

  // 런타임 modelID → DB 모델 uuid (충돌검사 저장·이슈 핀 매핑용).
  const [modelIdMap, setModelIdMap] = useState<Map<number, string>>(new Map());
  const [showClash, setShowClash] = useState(mode === 'clash');

  // 통합모델: 이슈 핀(객체에 연결된 이슈 마커) 표시/숨김.
  const [issues, setIssues] = useState<Issue[]>([]);
  const [showPins, setShowPins] = useState(true);

  const { status, setStatus, setSelected, setModelCount, fourd, selected } = useStore();

  // 이슈 '위치 보기'로 진입하면 location.state.focus 로 대상 객체가 전달된다.
  const location = useLocation();
  const focus =
    (location.state as { focus?: { modelDbId: string; expressID: number } } | null)?.focus ?? null;
  const focusHandledRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    (window as unknown as { __mirUpAxis?: (a: UpAxis) => void }).__mirUpAxis = (a) => {
      v.setUpAxis(a);
      if (openModelId.current) saveUpAxisPref(openModelId.current, a);
    };
    setViewer(v);
    return () => v.dispose();
  }, [setSelected]);

  useEffect(() => {
    refreshModels();
    refreshFiles();
    if (mode === 'integrated') listIssues(projectId).then(setIssues).catch(() => setIssues([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode]);

  const refreshModels = () =>
    listModels(projectId, mode).then(setModels).catch(() => setModels([]));
  const refreshFiles = () => listFiles(projectId).then(setFiles).catch(() => setFiles([]));

  // 재진입 시 마지막으로 보던 모델을 자동으로 다시 연다(모드별 기억).
  // (이슈 '위치 보기'로 들어온 경우엔 focus 효과가 대상 모델을 연다.)
  useEffect(() => {
    if (autoOpenedRef.current || focus || !viewer || models.length === 0) return;
    const savedId = localStorage.getItem(ACTIVE_MODEL_KEY(projectId, mode));
    const m = savedId ? models.find((x) => x.id === savedId) : null;
    if (m) {
      autoOpenedRef.current = true;
      openModel(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, models, projectId, focus]);

  // 이슈에 연결된 객체로 카메라 이동: 대상 모델을 열고 객체를 선택·맞춤.
  useEffect(() => {
    if (!focus || focusHandledRef.current || !viewer) return;
    focusHandledRef.current = true;
    (async () => {
      // 이 모듈의 목록(용도 필터)에 없으면 id 로 직접 조회해 연다.
      const m = models.find((x) => x.id === focus.modelDbId) ?? (await getModel(focus.modelDbId));
      if (!m) {
        setStatus('연결된 모델을 찾지 못했습니다.');
        return;
      }
      await openModel(m);
      if (viewer.primaryModelID != null) {
        const ok = viewer.focusElement(viewer.primaryModelID, focus.expressID);
        if (!ok) setStatus('연결된 객체를 찾지 못했습니다(모델이 변경되었을 수 있음).');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, models, focus]);

  // 통합모델: 로드된 모델에 연결된 이슈에 핀을 찍는다(상태색: 미해결=빨강/완료=초록).
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

  const openModel = async (m: ModelRecord) => {
    if (!viewer) return;
    setBusyId(m.id);
    setStatus(`불러오는 중: ${m.name}`);
    try {
      const bytes = await downloadModelBytes(m.storage_path);
      const saved = loadUpAxisPref(m.id);
      await viewer.loadIfc(bytes, { label: m.name, ...(saved ? { upAxis: saved } : {}) });
      setModelCount(viewer.modelCount);
      if (viewer.primaryModelID != null) {
        const rid = viewer.primaryModelID;
        setModelIdMap((prev) => new Map(prev).set(rid, m.id));
      }
      openModelId.current = m.id;
      setOpenModelDbId(m.id);
      // 모드별로 마지막에 보던 모델을 기억(재진입 자동 복원).
      localStorage.setItem(ACTIVE_MODEL_KEY(projectId, mode), m.id);
      // 4D 매핑/시공 상태 리셋은 공정관리 모드에서만(전역 store 오염 방지).
      if (mode === '4d') {
        viewer.clearConstruction();
        fourd.setMapping({}, 0, 0);
      }
      setStatus(`불러옴: ${m.name}`);
    } catch (e) {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(`업로드 중: ${file.name}`);
    try {
      await uploadModel(projectId, file, mode);
      await refreshModels();
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

  // 선택한 3D 객체에 연결된 이슈 생성(관리자). 통합모델에서 핀도 갱신.
  const onCreateIssueFromSelection = async () => {
    if (!selected || !openModelDbId) return;
    const title = window.prompt(`선택 객체(#${selected.expressID})에 연결할 이슈 제목`);
    if (!title?.trim()) return;
    try {
      await createIssue(
        projectId,
        { title: title.trim(), priority: 'normal', model_id: openModelDbId, express_id: selected.expressID },
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
      <aside className="mod-subtree">
        <div className="sidebar-head">
          <h2>{text.modelHead}</h2>
          <input ref={fileInput} type="file" accept=".ifc" style={{ display: 'none' }} onChange={onUpload} />
          {isAdmin && (
            <button onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? '업로드 중…' : text.upload}
            </button>
          )}
        </div>
        <ul className="model-list">
          {models.map((m) => (
            <li key={m.id}>
              <button className="model-item" onClick={() => openModel(m)} disabled={busyId === m.id}>
                <span className="model-name">{m.name}</span>
                <span className="muted">{busyId === m.id ? '로딩…' : sizeLabel(m.size_bytes)}</span>
              </button>
            </li>
          ))}
          {models.length === 0 && <li className="muted empty">{text.empty}</li>}
        </ul>

        {mode === 'integrated' && (
          <>
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
          </>
        )}
      </aside>

      <div className="mod-main viewer-main">
        <div className="viewer-bar">
          <span className="viewer-mode-title">{text.title}</span>
          <span className="tl-divider" />
          <Toolbar viewer={viewer} />
          {isAdmin && selected && openModelDbId && (
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
              title="충돌검사 패널 열기/닫기"
            >
              🔍 충돌검사
            </button>
          )}
          <div className="spacer" />
          <span className="muted">{status}</span>
          <span className="muted">· 모델 {viewer?.modelCount ?? 0}개</span>
        </div>
        <div className="viewport" ref={containerRef} />
        <PropertiesPanel />
        {mode === 'clash' && showClash && (
          <ClashPanel
            viewer={viewer}
            projectId={projectId}
            modelIdMap={modelIdMap}
            onClose={() => setShowClash(false)}
          />
        )}
        {mode === '4d' && <Timeline viewer={viewer} projectId={projectId} modelDbId={openModelDbId} />}
      </div>
    </div>
  );
}

const ACTIVE_MODEL_KEY = (projectId: string, mode: ViewerMode) => `mir.model.${mode}.${projectId}`;
const UP_AXIS_KEY = (modelId: string) => `mir.upaxis.${modelId}`;

function loadUpAxisPref(modelId: string): UpAxis | null {
  const v = localStorage.getItem(UP_AXIS_KEY(modelId));
  return v === 'x' || v === 'y' || v === 'z' ? v : null;
}

function saveUpAxisPref(modelId: string, axis: UpAxis) {
  localStorage.setItem(UP_AXIS_KEY(modelId), axis);
}

function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
