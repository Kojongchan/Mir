import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { FolderTree } from '../components/cde/FolderTree';
import { StatusBadge } from '../components/cde/StatusBadge';
import { VersionHistory } from '../components/cde/VersionHistory';
import { ActivityLog } from '../components/cde/ActivityLog';
import { IfcModelViewer } from '../components/IfcModelViewer';
import { AccBrowser } from '../components/acc/AccBrowser';
import { extensionOf } from '../lib/files';
import { syncBimModel, deleteBimModel } from '../lib/api';
import {
  FILE_STATUSES,
  STATUS_LABEL,
  createFolder,
  deleteCdeFile,
  deleteFolder,
  ensureBimRoot,
  getCdeFile,
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
  type FolderKind,
} from '../lib/cde';

/**
 * 자료 관리(CDE) 모듈 — 포털 셸 안에서 렌더(좌측 모듈 레일은 셸이 유지). 모듈
 * 레일 옆 폴더 트리(두 번째 트리) + 우측 문서 목록. ISO 19650 상태·버전·활동 이력.
 */
export function DocumentManager() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  // RBAC(0023): 실무자(editor) 이상이 콘텐츠 쓰기. 시스템 관리자는 자동 관리자.
  const { canEdit } = useProjectRole(projectId);
  // 삭제는 실무자 이상 또는 업로더 본인(D12/D14).
  const canDelete = (f: CdeFile) => canEdit || (!!f.uploaded_by && f.uploaded_by === profile?.id);

  // 저장소 전환: 앱(Supabase docs — 기존 자료 읽기 공존) ↔ ACC(신규 업로드 일원화).
  const [store, setStore] = useState<'supabase' | 'acc'>('supabase');

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null); // null = root/unfiled
  const [files, setFiles] = useState<CdeFile[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null); // 0~1 업로드 진행률(추가의견5)

  const [historyFor, setHistoryFor] = useState<CdeFile | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [viewingFile, setViewingFile] = useState<CdeFile | null>(null); // .ifc opened inline

  const newFileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<CdeFile | null>(null);

  useEffect(() => {
    // 'BIM 데이터' 최상위 폴더가 없으면 만들고(관리자), 폴더 목록을 읽는다.
    (async () => {
      if (canEdit) await ensureBimRoot(projectId).catch(() => {});
      await refreshFolders();
    })();
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

  // 폴더트리를 종류별로 나눠 두 섹션(문서 / BIM 데이터)으로 렌더한다.
  const docFolders = useMemo(() => folders.filter((f) => f.kind !== 'bim'), [folders]);
  const bimFolders = useMemo(() => folders.filter((f) => f.kind === 'bim'), [folders]);
  // 현재 작업중인 섹션의 종류(미분류=문서). 새 폴더/업로드 컨텍스트에 사용.
  const currentKind: FolderKind = selectedFolder?.kind ?? 'doc';
  const inBim = currentKind === 'bim';

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
      // 하위 폴더는 부모(=현재 선택 폴더)의 종류를 물려받는다. 미선택(미분류)이면 문서.
      await createFolder(projectId, selectedId, name, currentKind);
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
    setProgress(0);
    setStatus(`업로드 중: ${file.name}`);
    try {
      const rec = await uploadNewFile(projectId, selectedId, file, undefined, setProgress);
      // BIM 폴더의 IFC 는 통합모델(3D)에 연동되도록 models 행을 함께 생성/갱신.
      if (inBim && extensionOf(file.name) === 'ifc') await syncBimModel(rec);
      await refreshFiles();
      setStatus(`업로드 완료: ${file.name}${inBim ? ' · 통합모델 연동됨' : ''}`);
    } catch (err) {
      setStatus(`업로드 실패: ${errMessage(err)}`);
    } finally {
      setBusy(false);
      setProgress(null);
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
    setProgress(0);
    setStatus(`새 버전 업로드 중: ${target.name}`);
    try {
      await uploadNewVersion(target, file, undefined, setProgress);
      // BIM IFC 새 버전 → 연동된 통합모델 행을 최신 버전으로 repoint.
      if (inBim && extensionOf(target.name) === 'ifc') {
        const updated = await getCdeFile(target.id);
        if (updated) await syncBimModel(updated);
      }
      await refreshFiles();
      setStatus(`새 버전 등록: ${target.name}`);
    } catch (err) {
      setStatus(`버전 등록 실패: ${errMessage(err)}`);
    } finally {
      setBusy(false);
      setProgress(null);
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
      // 연동된 통합모델 행도 함께 정리(BIM IFC).
      if (extensionOf(f.name) === 'ifc') await deleteBimModel(f.id).catch(() => {});
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
    <div className="mod-fill cde-wrap">
      <div className="cde-store-tabs">
        <button className={store === 'supabase' ? 'active' : ''} onClick={() => setStore('supabase')}>
          📁 앱 저장소
        </button>
        <button className={store === 'acc' ? 'active' : ''} onClick={() => setStore('acc')}>
          🅰 ACC 자료
        </button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>
          {store === 'acc' ? '신규 업로드 = ACC' : '기존 자료(읽기)'}
        </span>
      </div>
      {store === 'acc' ? (
        <AccBrowser projectId={projectId} canEdit={canEdit} />
      ) : (
      <div className="cde-embed cde-embed-fill">
        <aside className="cde-side">
          <div className="sidebar-head">
            <h2>폴더</h2>
            {canEdit && <button onClick={onNewFolder}>＋ 폴더</button>}
          </div>
          <div className="cde-tree-wrap">
            <div className="cde-tree-section-label">📄 문서</div>
            <FolderTree
              folders={docFolders}
              selectedId={selectedId}
              onSelect={setSelectedId}
              rootLabel="전체 · 미분류"
            />
            <div className="cde-tree-section-label">🧊 BIM 데이터</div>
            <FolderTree
              folders={bimFolders}
              selectedId={selectedId}
              onSelect={setSelectedId}
              showRoot={false}
            />
          </div>
          {canEdit && selectedFolder && (
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
              <IfcModelViewer bucket="docs" path={viewingFile.storage_path ?? ''} />
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
            <input
              ref={newFileInput}
              type="file"
              accept={inBim ? '.ifc' : undefined}
              style={{ display: 'none' }}
              onChange={onUploadNew}
            />
            <input ref={versionInput} type="file" style={{ display: 'none' }} onChange={onUploadVersion} />
            {canEdit && (
              <button className="primary" onClick={() => newFileInput.current?.click()} disabled={busy}>
                {busy ? '처리 중…' : inBim ? 'BIM 업로드(IFC)' : '문서 업로드'}
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
                        {canEdit && (
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
                      {canEdit && (
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

          {progress != null && (
            <div className="upload-progress" title={`${Math.round(progress * 100)}%`}>
              <div className="upload-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span className="upload-progress-pct">{Math.round(progress * 100)}%</span>
            </div>
          )}
          <div className="cde-statusline muted">{status}</div>
          </>
          )}
        </section>

      {historyFor && <VersionHistory file={historyFor} onClose={() => setHistoryFor(null)} />}
      {showActivity && <ActivityLog projectId={projectId} onClose={() => setShowActivity(false)} />}
      </div>
      )}
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
