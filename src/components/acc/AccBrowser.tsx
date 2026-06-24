import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  accFetch,
  accFileBlobUrl,
  accFileRedirectUrl,
  accItemVersions,
  deleteAccItem,
  downloadAccItem,
  isAccModel,
  moveAccItem,
  renameAccItem,
  uploadToAcc,
  type AccItem,
  type AccNamed,
  type AccVersion,
} from '../../lib/aps';
import { getProjectAcc } from '../../lib/api';
import { listAccFileMeta, recordAccUpload, type AccFileMeta } from '../../lib/cde';
import { viewerKindFor, type ViewerKind, type FileRecord } from '../../lib/files';
import { StatusBadge } from '../cde/StatusBadge';
import { ImageViewer } from '../viewers/ImageViewer';
import { VideoViewer } from '../viewers/VideoViewer';
import { AudioViewer } from '../viewers/AudioViewer';
import { TextViewer } from '../viewers/TextViewer';
import { DownloadFallback } from '../viewers/DownloadFallback';
import { PdfViewer } from '../viewers/PdfViewer';
import { SheetViewer } from '../viewers/SheetViewer';
import { DocxViewer } from '../viewers/DocxViewer';
import { PptxViewer } from '../viewers/PptxViewer';

const fakeFile = (name: string) => ({ name, size_bytes: null, mime_type: null }) as unknown as FileRecord;
const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' }) : '';

// 펼침 트리 노드(폴더). 자식은 펼칠 때 지연 로드(S46 패턴).
type FolderNode = {
  id: string;
  name: string;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: FolderNode[];
  items: AccItem[];
};

const mkFolder = (id: string, name: string): FolderNode => ({
  id, name, expanded: false, loaded: false, loading: false, children: [], items: [],
});

function updateFolder(nodes: FolderNode[], id: string, fn: (n: FolderNode) => FolderNode): FolderNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children.length) return { ...n, children: updateFolder(n.children, id, fn) };
    return n;
  });
}
function findNode(nodes: FolderNode[], id: string): FolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return null;
}
function findPath(nodes: FolderNode[], id: string, trail: FolderNode[] = []): FolderNode[] | null {
  for (const n of nodes) {
    const next = [...trail, n];
    if (n.id === id) return next;
    const c = findPath(n.children, id, next);
    if (c) return c;
  }
  return null;
}
function flattenFolders(nodes: FolderNode[], depth = 0): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children.length) out.push(...flattenFolders(n.children, depth + 1));
  }
  return out;
}

/**
 * 자료관리 — ACC 파일 관리자(트리 + 파일표 + 툴바). S48.
 *
 * 좌측 폴더트리 + 우측 파일표(체크박스·이름·상태·수정일·⋮ 메뉴) + 상단 툴바
 * (업로드·다운로드·이름변경·이동·삭제·검색). 모델=APS Viewer, 문서=우리 뷰어.
 * 쓰기(업로드/다운로드/편집)는 실무자(editor) 이상(canEdit). 뷰어는 미리보기만,
 * 다운로드 버튼 숨김(D19/RBAC). 업로드 시 files 메타 행(source='acc')도 기록.
 */
export function AccBrowser({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const [accProject, setAccProject] = useState('');
  const [rootLabel, setRootLabel] = useState('ACC');
  const [pinned, setPinned] = useState(false);
  const [roots, setRoots] = useState<FolderNode[]>([]);
  const [selId, setSelId] = useState<string | null>(null); // 현재 폴더(null=최상위)
  const [meta, setMeta] = useState<Map<string, AccFileMeta>>(new Map());
  const [status, setStatus] = useState('ACC 불러오는 중…');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const [docView, setDocView] = useState<{ url: string; name: string; kind: ViewerKind } | null>(null);
  const [versionsFor, setVersionsFor] = useState<{ item: AccItem; list: AccVersion[] } | null>(null);
  const [moveFor, setMoveFor] = useState<AccItem | null>(null);
  const [versionTarget, setVersionTarget] = useState<AccItem | null>(null);
  const docBlobRef = useRef<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const clearDoc = () => {
    if (docBlobRef.current) {
      URL.revokeObjectURL(docBlobRef.current);
      docBlobRef.current = null;
    }
    setDocView(null);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acc = await getProjectAcc(projectId);
        if (cancelled) return;
        listAccFileMeta(projectId).then((m) => !cancelled && setMeta(m));
        if (!acc.acc_hub_id || !acc.acc_project_id) {
          setPinned(false);
          setStatus(canEdit ? "‘🅰 ACC 모델’ 메뉴에서 ACC 프로젝트를 먼저 고정하세요." : '관리자가 ACC 프로젝트를 아직 지정하지 않았습니다.');
          return;
        }
        setPinned(true);
        setAccProject(acc.acc_project_id);
        setRootLabel(acc.acc_root_folder_name || 'ACC');
        if (acc.acc_root_folder_id) {
          const root = mkFolder(acc.acc_root_folder_id, acc.acc_root_folder_name ?? '시작 폴더');
          setRoots([root]);
          await ensureLoaded(root, acc.acc_project_id);
          setSelId(acc.acc_root_folder_id);
        } else {
          const { folders } = await accFetch({ action: 'topFolders', hub: acc.acc_hub_id, project: acc.acc_project_id });
          if (cancelled) return;
          setRoots((folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)));
          setSelId(null);
        }
        setStatus('');
      } catch (e) {
        if (!cancelled) setStatus(`ACC 오류: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      if (docBlobRef.current) URL.revokeObjectURL(docBlobRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refreshMeta = () => listAccFileMeta(projectId).then(setMeta).catch(() => {});

  // 폴더 내용을 지연 로드(이미 로드됐으면 펼침만 보장).
  const ensureLoaded = async (node: FolderNode, projId?: string) => {
    const p = projId || accProject;
    if (node.loaded) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, expanded: true })));
      return;
    }
    setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: true })));
    try {
      const { folders, items } = await accFetch({ action: 'contents', project: p, folder: node.id });
      setRoots((r) =>
        updateFolder(r, node.id, (n) => ({
          ...n, loading: false, loaded: true, expanded: true,
          children: (folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)),
          items: items as AccItem[],
        })),
      );
    } catch (e) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: false })));
      setStatus(`폴더 열기 실패: ${(e as Error).message}`);
    }
  };

  const reloadFolder = async (folderId: string) => {
    try {
      const { folders, items } = await accFetch({ action: 'contents', project: accProject, folder: folderId });
      setRoots((r) =>
        updateFolder(r, folderId, (n) => ({
          ...n, loaded: true, expanded: true,
          children: (folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)),
          items: items as AccItem[],
        })),
      );
    } catch { /* 무시 */ }
  };

  // 폴더 진입(트리/표/브레드크럼 공통).
  const enterFolder = async (id: string | null) => {
    setMenuFor(null);
    setChecked(new Set());
    setSearch('');
    if (id === null) {
      setSelId(null);
      return;
    }
    const node = findNode(roots, id);
    if (node) await ensureLoaded(node);
    setSelId(id);
  };

  const toggleCaret = async (e: React.MouseEvent, node: FolderNode) => {
    e.stopPropagation();
    if (node.loaded) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, expanded: !n.expanded })));
    } else {
      await ensureLoaded(node);
    }
  };

  // ---- 현재 폴더 컨텐츠 ----
  const selNode = selId ? findNode(roots, selId) : null;
  const curFolders = selNode ? selNode.children : roots;
  const curItems = selNode ? selNode.items : [];
  const q = search.trim().toLowerCase();
  const viewFolders = useMemo(
    () => (q ? curFolders.filter((f) => f.name.toLowerCase().includes(q)) : curFolders),
    [curFolders, q],
  );
  const viewItems = useMemo(
    () => (q ? curItems.filter((it) => it.name.toLowerCase().includes(q)) : curItems),
    [curItems, q],
  );
  const crumbs = selId ? findPath(roots, selId) ?? [] : [];
  const uploadTarget = selId; // 업로드는 현재 폴더로

  // ---- 파일 열기/미리보기 ----
  const openItem = (it: AccItem) => {
    setMenuFor(null);
    const kind = viewerKindFor(it.name);
    if (kind !== 'unsupported') return void openDocument(it, kind);
    if (isAccModel(it.name)) {
      if (!it.urn) return setStatus(`${it.name}: 변환된 3D 뷰가 아직 없습니다(ACC 처리 중).`);
      navigate(`/project/${projectId}/acc?urn=${encodeURIComponent(it.urn)}`);
      return;
    }
    void openDocument(it, 'unsupported');
  };
  const openDocument = async (it: AccItem, kind: ViewerKind) => {
    setStatus(`${it.name} 여는 중…`);
    try {
      if (kind === 'video' || kind === 'audio' || kind === 'unsupported') {
        clearDoc();
        setDocView({ url: await accFileRedirectUrl(accProject, it.id), name: it.name, kind });
      } else {
        const blobUrl = await accFileBlobUrl(accProject, it.id);
        clearDoc();
        docBlobRef.current = blobUrl;
        setDocView({ url: blobUrl, name: it.name, kind });
      }
      setStatus('');
    } catch (e) {
      setStatus(`열기 실패: ${(e as Error).message}`);
    }
  };

  // ---- 업로드 ----
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;
    setProgress(0);
    setStatus(`업로드 중: ${file.name}`);
    try {
      const res = await uploadToAcc(accProject, uploadTarget, file, { onProgress: setProgress, mirProject: projectId });
      if (res.itemUrn) await recordAccUpload(projectId, null, file.name, res.itemUrn, res.versionUrn, file.size);
      await reloadFolder(uploadTarget);
      await refreshMeta();
      setStatus(`업로드됨: ${file.name}`);
    } catch (err) {
      setStatus(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  // 기존 아이템의 새 버전 올리기: 대상 지정 후 파일 선택 트리거.
  const startVersionUpload = (it: AccItem) => {
    setMenuFor(null);
    setVersionTarget(it);
    versionInput.current?.click();
  };
  const onPickVersion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const it = versionTarget;
    const folder = selId; // 새 버전은 아이템이 속한 현재 폴더로 스토리지 생성
    if (!file || !it || !folder) {
      setVersionTarget(null);
      if (versionInput.current) versionInput.current.value = '';
      return;
    }
    setProgress(0);
    setStatus(`새 버전 업로드 중: ${it.name}`);
    try {
      // 원본 아이템 이름을 유지해 같은 파일의 새 버전으로 등록.
      const res = await uploadToAcc(accProject, folder, file, {
        itemId: it.id,
        fileName: it.name,
        onProgress: setProgress,
        mirProject: projectId,
      });
      if (res.itemUrn) await recordAccUpload(projectId, null, it.name, res.itemUrn, res.versionUrn, file.size);
      await reloadFolder(folder);
      await refreshMeta();
      setStatus(`새 버전 등록됨: ${it.name}`);
      if (versionsFor && versionsFor.item.id === it.id) await openVersions(it);
    } catch (err) {
      setStatus(`새 버전 실패: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      setVersionTarget(null);
      if (versionInput.current) versionInput.current.value = '';
    }
  };

  // ---- 다운로드/이름변경/삭제/이동/버전 ----
  const onDownload = async (its: AccItem[]) => {
    setMenuFor(null);
    for (const it of its) {
      try { await downloadAccItem(accProject, it.id, it.name); } catch (e) { setStatus(`다운로드 실패: ${(e as Error).message}`); }
    }
  };
  const onRename = async (it: AccItem) => {
    setMenuFor(null);
    const name = window.prompt('새 이름', it.name);
    if (!name?.trim() || name.trim() === it.name) return;
    setBusy(true);
    try {
      await renameAccItem(accProject, it.id, name.trim(), projectId);
      if (selId) await reloadFolder(selId);
      setStatus(`이름 변경: ${name.trim()}`);
    } catch (e) { setStatus(`이름 변경 실패: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const onDelete = async (its: AccItem[]) => {
    setMenuFor(null);
    if (!its.length) return;
    if (!window.confirm(`${its.length}개 항목을 삭제(휴지통)할까요?\n${its.map((i) => i.name).join(', ')}`)) return;
    setBusy(true);
    try {
      for (const it of its) await deleteAccItem(accProject, it.id, projectId);
      if (selId) await reloadFolder(selId);
      setChecked(new Set());
      setStatus(`삭제됨: ${its.length}개`);
    } catch (e) { setStatus(`삭제 실패: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const doMove = async (dest: string) => {
    const it = moveFor;
    setMoveFor(null);
    if (!it) return;
    setBusy(true);
    try {
      await moveAccItem(accProject, it.id, dest, projectId);
      if (selId) await reloadFolder(selId);
      await reloadFolder(dest);
      setStatus(`이동됨: ${it.name}`);
    } catch (e) { setStatus(`이동 실패(ACC 미지원일 수 있음): ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const openVersions = async (it: AccItem) => {
    setMenuFor(null);
    setVersionsFor({ item: it, list: [] });
    try {
      const list = await accItemVersions(accProject, it.id);
      setVersionsFor({ item: it, list });
    } catch (e) { setStatus(`버전 조회 실패: ${(e as Error).message}`); }
  };

  // ---- 선택 ----
  const toggleCheck = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allChecked = viewItems.length > 0 && viewItems.every((it) => checked.has(it.id));
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(viewItems.map((it) => it.id)));
  const selectedItems = curItems.filter((it) => checked.has(it.id));

  // ---- 트리 렌더 ----
  const renderTree = (node: FolderNode, depth: number): React.ReactElement => (
    <li key={node.id}>
      <div
        className={`acc-tree-row${selId === node.id ? ' sel' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => void enterFolder(node.id)}
      >
        <span className="acc-caret" onClick={(e) => void toggleCaret(e, node)}>
          {node.loading ? '⏳' : node.expanded ? '▾' : '▸'}
        </span>
        📁 <span className="acc-tree-name">{node.name}</span>
      </div>
      {node.expanded && node.children.length > 0 && (
        <ul className="acc-tree-ul">{node.children.map((c) => renderTree(c, depth + 1))}</ul>
      )}
    </li>
  );

  const renderDoc = (d: { url: string; name: string; kind: ViewerKind }) => {
    const f = fakeFile(d.name);
    switch (d.kind) {
      case 'image': return <ImageViewer url={d.url} file={f} />;
      case 'pdf': return <PdfViewer url={d.url} file={f} />;
      case 'video': return <VideoViewer url={d.url} file={f} />;
      case 'audio': return <AudioViewer url={d.url} file={f} />;
      case 'sheet': return <SheetViewer url={d.url} file={f} />;
      case 'docx': return <DocxViewer url={d.url} file={f} />;
      case 'pptx': return <PptxViewer url={d.url} file={f} />;
      case 'text': return <TextViewer url={d.url} file={f} />;
      default: return <DownloadFallback url={d.url} file={f} />;
    }
  };

  if (!pinned) {
    return (
      <section className="cde-content acc-browser">
        <div className="cde-toolbar"><strong style={{ fontSize: 13 }}>🅰 ACC 자료</strong></div>
        <div className="muted empty" style={{ padding: 16 }}>{status}</div>
      </section>
    );
  }

  return (
    <div className="acc-fm" onClick={() => menuFor && setMenuFor(null)}>
      <input ref={uploadInput} type="file" style={{ display: 'none' }} onChange={onUpload} />
      <input ref={versionInput} type="file" style={{ display: 'none' }} onChange={onPickVersion} />

      {/* 좌측 폴더 트리 */}
      <aside className="acc-fm-tree">
        <div className="acc-fm-tree-head">🅰 ACC 폴더</div>
        <ul className="acc-tree-ul">
          <li>
            <div className={`acc-tree-row${selId === null ? ' sel' : ''}`} onClick={() => void enterFolder(null)}>
              <span className="acc-caret" /> 🏠 <span className="acc-tree-name">{rootLabel}</span>
            </div>
          </li>
          {roots.map((n) => renderTree(n, 0))}
        </ul>
      </aside>

      {/* 우측 메인 */}
      <section className="acc-fm-main">
        <div className="acc-fm-toolbar">
          <nav className="acc-crumbs">
            <button onClick={() => void enterFolder(null)}>{rootLabel}</button>
            {crumbs.map((c) => (
              <span key={c.id}>
                <span className="sep">/</span>
                <button onClick={() => void enterFolder(c.id)}>{c.name}</button>
              </span>
            ))}
          </nav>
          <div className="spacer" />
          <input
            className="acc-fm-search"
            placeholder="이름 검색…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canEdit && (
            <button
              className="primary"
              disabled={!uploadTarget || progress != null || busy}
              title={uploadTarget ? '현재 폴더에 업로드' : '폴더를 먼저 선택하세요'}
              onClick={() => uploadInput.current?.click()}
            >
              {progress != null ? '업로드 중…' : '⬆ 업로드'}
            </button>
          )}
          <button onClick={() => selId && reloadFolder(selId)} title="새로고침">⟳</button>
        </div>

        {/* 선택 일괄 작업줄 */}
        {canEdit && selectedItems.length > 0 && (
          <div className="acc-fm-bulk">
            <span>{selectedItems.length}개 선택</span>
            <button onClick={() => onDownload(selectedItems)}>⬇ 다운로드</button>
            <button className="danger" onClick={() => onDelete(selectedItems)}>🗑 삭제</button>
            <button onClick={() => setChecked(new Set())}>선택 해제</button>
          </div>
        )}

        {progress != null && (
          <div className="upload-progress" title={`${Math.round(progress * 100)}%`}>
            <div className="upload-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            <span className="upload-progress-pct">{Math.round(progress * 100)}%</span>
          </div>
        )}

        <div className="acc-fm-table-wrap">
          <table className="acc-table">
            <thead>
              <tr>
                <th className="chk">
                  {canEdit && <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="전체 선택" />}
                </th>
                <th>이름</th>
                <th>상태</th>
                <th className="nowrap">수정일</th>
                <th className="right">작업</th>
              </tr>
            </thead>
            <tbody>
              {viewFolders.map((f) => (
                <tr key={f.id} className="acc-trow folder" onClick={() => void enterFolder(f.id)}>
                  <td className="chk" />
                  <td className="acc-name">📁 {f.name}</td>
                  <td />
                  <td />
                  <td className="right muted">폴더</td>
                </tr>
              ))}
              {viewItems.map((it) => {
                const m = it.urn ? meta.get(it.urn) : undefined;
                const model = isAccModel(it.name);
                return (
                  <tr key={it.id} className="acc-trow">
                    <td className="chk" onClick={(e) => e.stopPropagation()}>
                      {canEdit && (
                        <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggleCheck(it.id)} aria-label="선택" />
                      )}
                    </td>
                    <td className="acc-name">
                      <button
                        className="acc-link"
                        title={it.name}
                        onClick={() => openItem(it)}
                        style={{ opacity: model && !it.urn ? 0.5 : 1 }}
                      >
                        {model ? '🧱' : '📄'} {it.name}
                      </button>
                    </td>
                    <td>{m && <StatusBadge status={m.status} />}</td>
                    <td className="nowrap muted">{fmtDate(it.lastModified)}</td>
                    <td className="right acc-actions" onClick={(e) => e.stopPropagation()}>
                      <button title="작업" onClick={() => setMenuFor(menuFor === it.id ? null : it.id)}>⋮</button>
                      {menuFor === it.id && (
                        <div className="acc-menu" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => openItem(it)}>{model ? '3D 열기' : '미리보기'}</button>
                          <button onClick={() => openVersions(it)}>버전 이력</button>
                          {canEdit && <button onClick={() => startVersionUpload(it)}>새 버전 올리기</button>}
                          {canEdit && <button onClick={() => onDownload([it])}>다운로드</button>}
                          {canEdit && <button onClick={() => onRename(it)}>이름 변경</button>}
                          {canEdit && <button onClick={() => { setMenuFor(null); setMoveFor(it); }}>이동</button>}
                          {canEdit && <button className="danger" onClick={() => onDelete([it])}>삭제</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {viewFolders.length === 0 && viewItems.length === 0 && (
                <tr><td colSpan={5} className="muted empty">{q ? '검색 결과 없음' : '이 폴더가 비어 있습니다.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="acc-fm-status muted">{status}</div>
      </section>

      {/* 문서 미리보기 */}
      {docView && (
        <div className="acc-doc-overlay">
          <div className="acc-doc-head">
            <strong className="cde-view-name">📄 {docView.name}</strong>
            <div className="spacer" />
            <button onClick={clearDoc}>✕ 닫기</button>
          </div>
          <div className="acc-doc-body">{renderDoc(docView)}</div>
        </div>
      )}

      {/* 버전 이력 */}
      {versionsFor && (
        <div className="acc-modal-back" onClick={() => setVersionsFor(null)}>
          <div className="acc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="acc-modal-head">📑 버전 이력 — {versionsFor.item.name}<div className="spacer" />
              {canEdit && (
                <button className="primary" disabled={progress != null || busy} onClick={() => startVersionUpload(versionsFor.item)}>＋ 새 버전 올리기</button>
              )}
              <button onClick={() => setVersionsFor(null)}>✕</button>
            </div>
            <ul className="acc-ver-list">
              {versionsFor.list.length === 0 && <li className="muted">불러오는 중…</li>}
              {versionsFor.list.map((v) => (
                <li key={v.id}>
                  <strong>v{v.versionNumber ?? '?'}</strong>
                  <span className="muted">{fmtDate(v.lastModified)}</span>
                  <span className="acc-ver-name">{v.name ?? ''}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 이동 대상 선택 */}
      {moveFor && (
        <div className="acc-modal-back" onClick={() => setMoveFor(null)}>
          <div className="acc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="acc-modal-head">↦ 이동 — {moveFor.name}<div className="spacer" /><button onClick={() => setMoveFor(null)}>✕</button></div>
            <p className="muted" style={{ margin: '4px 0' }}>대상 폴더 선택 (ACC 환경에 따라 미지원일 수 있음)</p>
            <ul className="acc-move-list">
              {flattenFolders(roots).map((f) => (
                <li key={f.id}>
                  <button style={{ paddingLeft: 8 + f.depth * 14 }} disabled={f.id === selId} onClick={() => doMove(f.id)}>
                    📁 {f.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
