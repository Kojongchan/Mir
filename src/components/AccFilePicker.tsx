import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accFetch, uploadToAcc, isAccModel, type AccItem, type AccNamed } from '../lib/aps';
import { recordAccUpload } from '../lib/cde';
import { getProjectAcc } from '../lib/api';

export interface PickedAccFile {
  accProjectId: string;
  accItemId: string;
  accUrn: string | null;
  name: string;
  folderId: string | null;
  folderIds: string[];
  folderNames: string[];
}

/**
 * 자료관리(ACC) 파일 선택기 — 이슈 첨부를 ACC 파일 링크로 만든다. 폴더를 탐색해
 * 파일을 고르면 폴더 경로(조상 id/이름 체인)와 함께 반환한다. 실무자는 현재 폴더로
 * 직접 업로드해 바로 링크할 수도 있다(개인 파일이 흩어지지 않게 자료관리로 일원화).
 */
export function AccFilePicker({
  projectId,
  canEdit,
  onPick,
  onClose,
}: {
  projectId: string;
  canEdit: boolean;
  onPick: (f: PickedAccFile) => void;
  onClose: () => void;
}) {
  const [acc, setAcc] = useState<{ project: string; hub: string; rootId: string | null; rootName: string } | null>(null);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<AccNamed[]>([]);
  const [items, setItems] = useState<AccItem[]>([]);
  const [status, setStatus] = useState('불러오는 중…');
  const [progress, setProgress] = useState<number | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const curId = path.length ? path[path.length - 1].id : null;

  const loadFolder = async (accInfo: { project: string; hub: string }, folderId: string | null) => {
    setStatus('불러오는 중…');
    try {
      if (folderId) {
        const { folders: fs, items: its } = await accFetch({ action: 'contents', project: accInfo.project, folder: folderId });
        setFolders(fs as AccNamed[]);
        setItems(its as AccItem[]);
      } else {
        const { folders: fs } = await accFetch({ action: 'topFolders', hub: accInfo.hub, project: accInfo.project });
        setFolders(fs as AccNamed[]);
        setItems([]);
      }
      setStatus('');
    } catch (e) {
      setStatus(`폴더 열기 실패: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const a = await getProjectAcc(projectId);
        if (!alive) return;
        if (!a.acc_hub_id || !a.acc_project_id) {
          setStatus('ACC 프로젝트가 지정되지 않았습니다(통합모델 메뉴에서 고정).');
          return;
        }
        const info = { project: a.acc_project_id, hub: a.acc_hub_id, rootId: a.acc_root_folder_id ?? null, rootName: a.acc_root_folder_name || '시작 폴더' };
        setAcc(info);
        if (info.rootId) {
          setPath([{ id: info.rootId, name: info.rootName }]);
          await loadFolder(info, info.rootId);
        } else {
          setPath([]);
          await loadFolder(info, null);
        }
      } catch (e) {
        if (alive) setStatus(`ACC 오류: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const enter = async (f: AccNamed) => {
    if (!acc) return;
    setPath((p) => [...p, { id: f.id, name: f.name }]);
    await loadFolder(acc, f.id);
  };
  const goTo = async (index: number) => {
    if (!acc) return;
    if (index < 0) {
      // 최상위
      if (acc.rootId) {
        setPath([{ id: acc.rootId, name: acc.rootName }]);
        await loadFolder(acc, acc.rootId);
      } else {
        setPath([]);
        await loadFolder(acc, null);
      }
      return;
    }
    const target = path[index];
    setPath((p) => p.slice(0, index + 1));
    await loadFolder(acc, target.id);
  };

  const pick = (it: AccItem) => {
    if (!acc) return;
    onPick({
      accProjectId: acc.project,
      accItemId: it.id,
      accUrn: it.urn,
      name: it.name,
      folderId: curId,
      folderIds: path.map((p) => p.id),
      folderNames: path.map((p) => p.name),
    });
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !acc || !curId) return;
    setProgress(0);
    setStatus(`업로드 중: ${file.name}`);
    try {
      const res = await uploadToAcc(acc.project, curId, file, { onProgress: setProgress, mirProject: projectId });
      if (res.itemUrn) await recordAccUpload(projectId, null, file.name, res.itemUrn, res.versionUrn, file.size).catch(() => {});
      await loadFolder(acc, curId);
      setStatus(`업로드됨: ${file.name} — 아래에서 선택해 첨부하세요.`);
    } catch (err) {
      setStatus(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  return createPortal(
    <div className="acc-modal-back" onClick={onClose}>
      <div className="acc-modal acc-picker" style={{ width: 560, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="acc-modal-head">
          📁 자료관리에서 파일 선택
          <div className="spacer" />
          {canEdit && (
            <>
              <input ref={uploadInput} type="file" style={{ display: 'none' }} onChange={onUpload} />
              <button className="primary" disabled={!curId || progress != null} title={curId ? '현재 폴더에 업로드' : '폴더를 먼저 여세요'} onClick={() => uploadInput.current?.click()}>
                {progress != null ? '업로드 중…' : '⬆ 이 폴더에 업로드'}
              </button>
            </>
          )}
          <button onClick={onClose}>✕</button>
        </div>

        {/* 브레드크럼 */}
        <nav className="acc-crumbs" style={{ padding: '4px 2px' }}>
          <button onClick={() => void goTo(-1)}>{acc?.rootName ?? '최상위'}</button>
          {path.map((c, i) => (
            i === 0 && acc?.rootId ? null : (
              <span key={c.id}>
                <span className="sep">/</span>
                <button onClick={() => void goTo(i)}>{c.name}</button>
              </span>
            )
          ))}
        </nav>

        {progress != null && (
          <div className="upload-progress" title={`${Math.round(progress * 100)}%`}>
            <div className="upload-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}

        <div className="acc-picker-list">
          {folders.map((f) => (
            <button key={f.id} className="acc-picker-row folder" onClick={() => void enter(f)}>
              📁 <span className="acc-picker-name">{f.name}</span>
              <span className="acc-picker-go">열기 ›</span>
            </button>
          ))}
          {items.map((it) => (
            <button key={it.id} className="acc-picker-row" onClick={() => pick(it)} title="이 파일을 첨부">
              {isAccModel(it.name) ? '🧱' : '📄'} <span className="acc-picker-name">{it.name}</span>
              <span className="acc-picker-go">＋ 첨부</span>
            </button>
          ))}
          {folders.length === 0 && items.length === 0 && status === '' && (
            <div className="muted" style={{ padding: 12 }}>이 폴더가 비어 있습니다.</div>
          )}
        </div>

        {status && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{status}</div>}
      </div>
    </div>,
    document.body,
  );
}
