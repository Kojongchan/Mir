import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { IfcViewer, type UpAxis } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { useAuth } from '../auth/AuthProvider';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { Timeline } from '../components/Timeline';
import {
  downloadModelBytes,
  listModels,
  uploadModel,
  type ModelRecord,
} from '../lib/api';
import {
  listFiles,
  sizeLabel as fileSizeLabel,
  type FileRecord,
} from '../lib/files';
import { uploadNewFile } from '../lib/cde';

/**
 * 모델뷰어 모듈 — 포털 셸 안에서 렌더된다(좌측 모듈 레일은 셸이 유지). 모듈
 * 레일 옆에 모델/문서 하위 트리를 두고, 우측 메인에 3D 뷰포트·4D 타임라인을 둔다.
 */
export function Workspace() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;

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

  const { status, setStatus, setSelected, setModelCount, fourd } = useStore();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshModels = () => listModels(projectId).then(setModels).catch(() => setModels([]));
  const refreshFiles = () => listFiles(projectId).then(setFiles).catch(() => setFiles([]));

  const openModel = async (m: ModelRecord) => {
    if (!viewer) return;
    setBusyId(m.id);
    setStatus(`불러오는 중: ${m.name}`);
    try {
      const bytes = await downloadModelBytes(m.storage_path);
      const saved = loadUpAxisPref(m.id);
      await viewer.loadIfc(bytes, saved ? { upAxis: saved } : undefined);
      setModelCount(viewer.modelCount);
      openModelId.current = m.id;
      setOpenModelDbId(m.id);
      viewer.clearConstruction();
      fourd.setMapping({}, 0, 0);
      setStatus(`불러옴: ${m.name}`);
    } catch (e) {
      setStatus(`불러오기 실패: ${(e as Error).message}`);
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
      await uploadModel(projectId, file);
      await refreshModels();
      setStatus(`업로드 완료: ${file.name}`);
    } catch (err) {
      setStatus(`업로드 실패: ${(err as Error).message}`);
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
      setStatus(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setDocUploading(false);
      if (docInput.current) docInput.current.value = '';
    }
  };

  const openFile = (f: FileRecord) => window.open(`/view/${f.id}`, '_blank', 'noopener');

  return (
    <div className="mod-fill viewer-fill">
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
              <button className="model-item" onClick={() => openModel(m)} disabled={busyId === m.id}>
                <span className="model-name">{m.name}</span>
                <span className="muted">{busyId === m.id ? '로딩…' : sizeLabel(m.size_bytes)}</span>
              </button>
            </li>
          ))}
          {models.length === 0 && <li className="muted empty">등록된 모델이 없습니다.</li>}
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

      <div className="mod-main viewer-main">
        <div className="viewer-bar">
          <Toolbar viewer={viewer} />
          <div className="spacer" />
          <span className="muted">{status}</span>
          <span className="muted">· 모델 {viewer?.modelCount ?? 0}개</span>
        </div>
        <div className="viewport" ref={containerRef} />
        <PropertiesPanel />
        <Timeline viewer={viewer} projectId={projectId} modelDbId={openModelDbId} />
      </div>
    </div>
  );
}

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
