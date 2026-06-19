import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { FolderTree } from '../components/cde/FolderTree';
import { StatusBadge } from '../components/cde/StatusBadge';
import { VersionHistory } from '../components/cde/VersionHistory';
import { ActivityLog } from '../components/cde/ActivityLog';
import { IfcModelViewer } from '../components/IfcModelViewer';
import { extensionOf } from '../lib/files';
import {
  FILE_STATUSES,
  STATUS_LABEL,
  createFolder,
  deleteCdeFile,
  deleteFolder,
  listCdeFiles,
  listFolders,
  renameFolder,
  setFileStatus,
  sizeLabel,
  uploadNewFile,
  uploadNewVersion,
  type CdeFile,
  type FileStatus,
  type Folder,
} from '../lib/cde';

/**
 * 자료 관리(CDE) 모듈 — 포털 셸 안에서 렌더(좌측 모듈 레일은 셸이 유지). 모듈
 * 레일 옆 폴더 트리(두 번째 트리) + 우측 문서 목록. ISO 19650 상태·버전·활동 이력.
 */
export function DocumentManager() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  // D12: 문서 삭제는 D11(admin) 예외 — 업로더 본인도 가능. profile.id 는 auth uid.
  const canDelete = (f: CdeFile) => isAdmin || (!!f.uploaded_by && f.uploaded_by === profile?.id);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null); // null = root/unfiled
  const [files, setFiles] = useState<CdeFile[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const [historyFor, setHistoryFor] = useState<CdeFile | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [viewingFile, setViewingFile] = useState<CdeFile | null>(null); // .ifc opened inline

  const newFileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<CdeFile | null>(null);

  useEffect(() => {
    refreshFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setViewingFile(null);
    refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedId]);

  const refreshFolders = () => listFolders(projectId).then(setFolders).catch(() => setFolders([]));
  const refreshFiles = () =>
    listCdeFiles(projectId, selectedId).then(setFiles).catch(() => setFiles([]));

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === selectedId) ?? null,
    [folders, selectedId],
  );

  const breadcrumb = useMemo(() => buildBreadcrumb(folders, selectedId), [folders, selectedId]);

  const childFolderCount = useMemo(
    () => folders.filter((f) => f.parent_id === selectedId).length,
    [folders, selectedId],
  );

  // ---- folder actions ----
  const onNewFolder = async () => {
    const name = window.prompt('새 폴더 이름', '새 폴더');
    if (!name?.trim()) return;
    try {
      await createFolder(projectId, selectedId, name);
      await refreshFolders();
      setStatus(`폴더 생성: ${name.trim()}`);
    } catch (e) {
      setStatus(`폴더 생성 실패: ${errMessage(e)}`);
    }
  };

  const onRenameFolder = async () => {
    if (!selectedFolder) return;
    const name = window.prompt('폴더 이름 변경', selectedFolder.name);
    if (!name?.trim() || name.trim() === selectedFolder.name) return;
    try {
      await renameFolder(selectedFolder, name);
      await refreshFolders();
    } catch (e) {
      setStatus(`이름 변경 실패: ${errMessage(e)}`);
    }
  };

  const onDeleteFolder = async () => {
    if (!selectedFolder) return;
    if (childFolderCount > 0 || files.length > 0) {
      setStatus('하위 폴더·문서가 있는 폴더는 삭제할 수 없습니다. 먼저 비워주세요.');
      return;
    }
    if (!window.confirm(`'${selectedFolder.name}' 폴더를 삭제할까요?`)) return;
    try {
      const parent = selectedFolder.parent_id;
      await deleteFolder(selectedFolder);
      setSelectedId(parent);
      await refreshFolders();
    } catch (e) {
      setStatus(`폴더 삭제 실패: ${errMessage(e)}`);
    }
  };

  // ---- file actions ----
  const onUploadNew = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setStatus(`업로드 중: ${file.name}`);
    try {
      await uploadNewFile(projectId, selectedId, file);
      await refreshFiles();
      setStatus(`업로드 완료: ${file.name}`);
    } catch (err) {
      setStatus(`업로드 실패: ${errMessage(err)}`);
    } finally {
      setBusy(false);
      if (newFileInput.current) newFileInput.current.value = '';
    }
  };

  const triggerNewVersion = (f: CdeFile) => {
    versionTarget.current = f;
    versionInput.current?.click();
  };

  const onUploadVersion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = versionTarget.current;
    if (!file || !target) return;
    setBusy(true);
    setStatus(`새 버전 업로드 중: ${target.name}`);
    try {
      await uploadNewVersion(target, file);
      await refreshFiles();
      setStatus(`새 버전 등록: ${target.name}`);
    } catch (err) {
      setStatus(`버전 등록 실패: ${errMessage(err)}`);
    } finally {
      setBusy(false);
      versionTarget.current = null;
      if (versionInput.current) versionInput.current.value = '';
    }
  };

  const onChangeStatus = async (f: CdeFile, next: FileStatus) => {
    try {
      await setFileStatus(f, next);
      await refreshFiles();
    } catch (e) {
      setStatus(`상태 변경 실패: ${errMessage(e)}`);
    }
  };

  const onDeleteFile = async (f: CdeFile) => {
    if (!window.confirm(`'${f.name}' 문서를 모든 버전과 함께 삭제할까요?`)) return;
    try {
      await deleteCdeFile(f);
      await refreshFiles();
      setStatus(`삭제 완료: ${f.name}`);
    } catch (e) {
      setStatus(`삭제 실패: ${errMessage(e)}`);
    }
  };

  // IFC models open inline (right pane → 3D viewer with a back button); other
  // files preview in a standalone tab as before.
  const openFile = (f: CdeFile) => {
    if (extensionOf(f.name) === 'ifc') setViewingFile(f);
    else window.open(`/view/${f.id}`, '_blank', 'noopener');
  };

  return (
    <div className="mod-fill cde-embed">
        <aside className="cde-side">
          <div className="sidebar-head">
            <h2>폴더</h2>
            {isAdmin && <button onClick={onNewFolder}>＋ 폴더</button>}
          </div>
          <div className="cde-tree-wrap">
            <FolderTree folders={folders} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          {isAdmin && selectedFolder && (
            <div className="cde-side-actions">
              <button onClick={onRenameFolder}>이름 변경</button>
              <button className="danger" onClick={onDeleteFolder}>폴더 삭제</button>
            </div>
          )}
        </aside>

        <section className="cde-content">
          {viewingFile ? (
            <>
              <div className="cde-toolbar">
                <button onClick={() => setViewingFile(null)}>← 목록</button>
                <span className="cde-view-name">🧊 {viewingFile.name}</span>
              </div>
              <IfcModelViewer bucket="docs" path={viewingFile.storage_path} />
            </>
          ) : (
          <>
          <div className="cde-toolbar">
            <nav className="cde-breadcrumb">
              <button className="cde-crumb" onClick={() => setSelectedId(null)}>전체</button>
              {breadcrumb.map((f) => (
                <span key={f.id}>
                  <span className="cde-crumb-sep">/</span>
                  <button className="cde-crumb" onClick={() => setSelectedId(f.id)}>{f.name}</button>
                </span>
              ))}
            </nav>
            <div className="spacer" />
            <button onClick={() => setShowActivity(true)}>활동 로그</button>
            <input ref={newFileInput} type="file" style={{ display: 'none' }} onChange={onUploadNew} />
            <input ref={versionInput} type="file" style={{ display: 'none' }} onChange={onUploadVersion} />
            {isAdmin && (
              <button className="primary" onClick={() => newFileInput.current?.click()} disabled={busy}>
                {busy ? '처리 중…' : '문서 업로드'}
              </button>
            )}
          </div>

          <div className="cde-table-wrap">
            <table className="cde-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>상태</th>
                  <th className="right">크기</th>
                  <th>등록일</th>
                  <th className="right">작업</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td className="cde-fname">
                      <button className="cde-link" onClick={() => openFile(f)} title="새 탭에서 미리보기">
                        {f.name}
                      </button>
                    </td>
                    <td>
                      <div className="cde-status-cell">
                        <StatusBadge status={f.status} />
                        {isAdmin && (
                          <select
                            value={f.status}
                            onChange={(e) => onChangeStatus(f, e.target.value as FileStatus)}
                            aria-label="상태 변경"
                          >
                            {FILE_STATUSES.map((s) => (
                              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                    <td className="right nowrap">{sizeLabel(f.size_bytes)}</td>
                    <td className="nowrap">{new Date(f.created_at).toLocaleDateString('ko-KR')}</td>
                    <td className="right nowrap">
                      <button onClick={() => setHistoryFor(f)}>이력</button>
                      {isAdmin && (
                        <button onClick={() => triggerNewVersion(f)} disabled={busy}>새 버전</button>
                      )}
                      {canDelete(f) && (
                        <button className="danger" onClick={() => onDeleteFile(f)}>삭제</button>
                      )}
                    </td>
                  </tr>
                ))}
                {files.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted empty">이 폴더에 문서가 없습니다.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="cde-statusline muted">{status}</div>
          </>
          )}
        </section>

      {historyFor && <VersionHistory file={historyFor} onClose={() => setHistoryFor(null)} />}
      {showActivity && <ActivityLog projectId={projectId} onClose={() => setShowActivity(false)} />}
    </div>
  );
}

/** Resolve the chain of folders from root down to the selected one. */
function buildBreadcrumb(folders: Folder[], selectedId: string | null): Folder[] {
  if (selectedId === null) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: Folder[] = [];
  let cur = byId.get(selectedId) ?? null;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) ?? null : null;
  }
  return chain;
}
