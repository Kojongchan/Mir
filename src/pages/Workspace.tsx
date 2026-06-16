import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { useAuth } from '../auth/AuthProvider';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import {
  downloadModelBytes,
  getProject,
  listModels,
  uploadModel,
  type ModelRecord,
  type Project,
} from '../lib/api';

export function Workspace() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { signOut } = useAuth();

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const { status, setStatus, setSelected, setModelCount } = useStore();

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    setViewer(v);
    return () => v.dispose();
  }, [setSelected]);

  useEffect(() => {
    getProject(projectId).then(setProject);
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshModels = () => listModels(projectId).then(setModels).catch(() => setModels([]));

  const openModel = async (m: ModelRecord) => {
    if (!viewer) return;
    setBusyId(m.id);
    setStatus(`불러오는 중: ${m.name}`);
    try {
      const bytes = await downloadModelBytes(m.storage_path);
      await viewer.loadIfc(bytes);
      setModelCount(viewer.modelCount);
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

  return (
    <div className="app workspace">
      <header className="topbar">
        <span className="brand">MIR_VDC</span>
        <span className="project-title">{project?.name ?? '…'}</span>
        <Toolbar viewer={viewer} />
        <div className="spacer" />
        <button onClick={() => navigate('/')}>프로젝트 변경</button>
        <button onClick={signOut}>로그아웃</button>
      </header>

      <aside className="sidebar">
        <div className="sidebar-head">
          <h2>모델</h2>
          <input
            ref={fileInput}
            type="file"
            accept=".ifc"
            style={{ display: 'none' }}
            onChange={onUpload}
          />
          <button onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? '업로드 중…' : 'IFC 업로드'}
          </button>
        </div>
        <ul className="model-list">
          {models.map((m) => (
            <li key={m.id}>
              <button
                className="model-item"
                onClick={() => openModel(m)}
                disabled={busyId === m.id}
              >
                <span className="model-name">{m.name}</span>
                <span className="muted">
                  {busyId === m.id ? '로딩…' : sizeLabel(m.size_bytes)}
                </span>
              </button>
            </li>
          ))}
          {models.length === 0 && <li className="muted empty">등록된 모델이 없습니다.</li>}
        </ul>
      </aside>

      <div className="viewport" ref={containerRef} />

      <PropertiesPanel />

      <footer className="statusbar">
        <span>{status}</span>
        <span className="muted">모델 {viewer?.modelCount ?? 0}개</span>
      </footer>
    </div>
  );
}

function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
