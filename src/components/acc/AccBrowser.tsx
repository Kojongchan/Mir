import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  accFetch,
  accFileBlobUrl,
  accFileRedirectUrl,
  isAccModel,
  uploadToAcc,
  type AccItem,
  type AccNamed,
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

const fakeFile = (name: string) => ({ name, size_bytes: null, mime_type: null }) as unknown as FileRecord;

// 펼침 트리 노드(폴더). 자식은 펼칠 때 지연 로드(S46 AccModels 와 동일 패턴).
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

/**
 * 자료관리 — ACC(Autodesk Construction Cloud) 탐색·업로드 (S47).
 *
 * 읽기는 S46 ACC 트리 로직 재사용(펼침 트리·지연로드·자연정렬·시작폴더 고정).
 * 파일 분기: 모델(rvt·nwd·ifc·dwg…)=APS Viewer 페이지로 이동 / 문서·이미지·
 * 오피스·텍스트=우리 뷰어(ACC 원본 바이트 프록시) / 미디어=서명URL.
 * 업로드(관리자)는 2-legged 브로커(/api/aps-upload)로 ACC 폴더에 쓰고, `files`
 * 메타 행(source='acc')을 남겨 CDE 상태·활동로그가 ACC 파일을 가리키게 한다.
 */
export function AccBrowser({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const [accProject, setAccProject] = useState('');
  const [pinned, setPinned] = useState(false);
  const [roots, setRoots] = useState<FolderNode[]>([]);
  const [meta, setMeta] = useState<Map<string, AccFileMeta>>(new Map());
  const [status, setStatus] = useState('ACC 불러오는 중…');
  const [openId, setOpenId] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  // 업로드 대상 폴더(폴더를 클릭하면 선택됨). 시작 폴더가 있으면 기본 선택.
  const [sel, setSel] = useState<{ id: string; name: string } | null>(null);

  // 문서 미리보기 오버레이.
  const [docView, setDocView] = useState<{ url: string; name: string; kind: ViewerKind } | null>(null);
  const docBlobRef = useRef<string | null>(null);
  const clearDoc = () => {
    if (docBlobRef.current) {
      URL.revokeObjectURL(docBlobRef.current);
      docBlobRef.current = null;
    }
    setDocView(null);
  };

  // 업로드 입력(폴더별 트리거).
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acc = await getProjectAcc(projectId);
        if (cancelled) return;
        listAccFileMeta(projectId).then((m) => !cancelled && setMeta(m));
        if (!acc.acc_hub_id || !acc.acc_project_id) {
          setPinned(false);
          setStatus(
            canEdit
              ? "‘🅰 ACC 모델’ 메뉴에서 ACC 프로젝트를 먼저 고정하세요."
              : '관리자가 ACC 프로젝트를 아직 지정하지 않았습니다.',
          );
          return;
        }
        setPinned(true);
        setAccProject(acc.acc_project_id);
        if (acc.acc_root_folder_id) {
          const rootName = acc.acc_root_folder_name ?? '시작 폴더';
          const root = mkFolder(acc.acc_root_folder_id, rootName);
          setRoots([root]);
          setSel({ id: acc.acc_root_folder_id, name: rootName }); // 기본 업로드 대상
          void toggleFolder(root, acc.acc_project_id);
        } else {
          const { folders } = await accFetch({ action: 'topFolders', hub: acc.acc_hub_id, project: acc.acc_project_id });
          if (cancelled) return;
          setRoots((folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)));
        }
        setStatus('폴더에서 파일을 선택하거나 업로드하세요.');
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

  // 폴더 펼치기/접기(처음 펼칠 때만 지연 로드).
  const toggleFolder = async (node: FolderNode, projId?: string) => {
    const p = projId || accProject;
    if (node.loaded) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, expanded: !n.expanded })));
      return;
    }
    setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: true })));
    try {
      const { folders, items } = await accFetch({ action: 'contents', project: p, folder: node.id });
      setRoots((r) =>
        updateFolder(r, node.id, (n) => ({
          ...n,
          loading: false,
          loaded: true,
          expanded: true,
          children: (folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)),
          items: items as AccItem[],
        })),
      );
    } catch (e) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: false })));
      setStatus(`폴더 열기 실패: ${(e as Error).message}`);
    }
  };

  // 펼쳐진(로드된) 폴더 내용을 강제 재조회(업로드 직후 갱신).
  const reloadFolder = async (folderId: string) => {
    try {
      const { folders, items } = await accFetch({ action: 'contents', project: accProject, folder: folderId });
      setRoots((r) =>
        updateFolder(r, folderId, (n) => ({
          ...n,
          loaded: true,
          expanded: true,
          children: (folders as AccNamed[]).map((f) => mkFolder(f.id, f.name)),
          items: items as AccItem[],
        })),
      );
    } catch {
      /* 무시 — 다음 펼침 때 반영 */
    }
  };

  const pickItem = (it: AccItem) => {
    setOpenId(it.id);
    const kind = viewerKindFor(it.name);
    if (kind !== 'unsupported') {
      void openDocument(it, kind);
      return;
    }
    if (isAccModel(it.name)) {
      // 모델/도면 → APS Viewer 페이지로(텍스처·대용량 네이티브).
      if (!it.urn) {
        setStatus(`${it.name}: 변환된 3D 뷰가 아직 없습니다(ACC 처리 중일 수 있음).`);
        return;
      }
      navigate(`/project/${projectId}/acc?urn=${encodeURIComponent(it.urn)}`);
      return;
    }
    // 그 외(ppt·hwp·zip 등) → 다운로드 폴백.
    void openDocument(it, 'unsupported');
  };

  const openDocument = async (it: AccItem, kind: ViewerKind) => {
    setStatus(`${it.name} 여는 중…`);
    try {
      if (kind === 'video' || kind === 'audio' || kind === 'unsupported') {
        clearDoc();
        const url = await accFileRedirectUrl(accProject, it.id);
        setDocView({ url, name: it.name, kind });
      } else {
        const blobUrl = await accFileBlobUrl(accProject, it.id);
        clearDoc();
        docBlobRef.current = blobUrl;
        setDocView({ url: blobUrl, name: it.name, kind });
      }
      setStatus(`완료: ${it.name}`);
    } catch (e) {
      setStatus(`문서 열기 실패: ${(e as Error).message}`);
    }
  };

  const triggerUpload = (folderId: string) => {
    uploadFolder.current = folderId;
    uploadInput.current?.click();
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const folderId = uploadFolder.current;
    if (!file || !folderId) return;
    setProgress(0);
    setStatus(`ACC 업로드 중: ${file.name}`);
    try {
      const res = await uploadToAcc(accProject, folderId, file, { onProgress: setProgress });
      // CDE 상태·활동로그가 ACC 파일을 가리키게 메타 행 기록(0022 미적용이면 무시됨).
      if (res.itemUrn) {
        await recordAccUpload(projectId, null, file.name, res.itemUrn, res.versionUrn, file.size);
      }
      await reloadFolder(folderId);
      await refreshMeta();
      setStatus(`업로드됨(ACC): ${file.name}`);
    } catch (err) {
      setStatus(`ACC 업로드 실패: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      uploadFolder.current = '';
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  const renderDoc = (d: { url: string; name: string; kind: ViewerKind }) => {
    const f = fakeFile(d.name);
    switch (d.kind) {
      case 'image': return <ImageViewer url={d.url} file={f} />;
      case 'pdf': return <PdfViewer url={d.url} file={f} />;
      case 'video': return <VideoViewer url={d.url} file={f} />;
      case 'audio': return <AudioViewer url={d.url} file={f} />;
      case 'sheet': return <SheetViewer url={d.url} file={f} />;
      case 'docx': return <DocxViewer url={d.url} file={f} />;
      case 'text': return <TextViewer url={d.url} file={f} />;
      default: return <DownloadFallback url={d.url} file={f} />;
    }
  };

  const renderFolder = (node: FolderNode, depth: number): React.ReactElement => (
    <li key={node.id}>
      <div className="acc-row" style={{ paddingLeft: depth * 12 }}>
        <button
          className="acc-row-btn"
          onClick={() => {
            setSel({ id: node.id, name: node.name }); // 업로드 대상으로 선택
            void toggleFolder(node);
          }}
          style={{ fontWeight: sel?.id === node.id ? 700 : 400, color: sel?.id === node.id ? 'var(--accent)' : 'var(--text)' }}
        >
          <span className="acc-caret">{node.loading ? '⏳' : node.expanded ? '▾' : '▸'}</span>
          📂 {node.name}
        </button>
        {canEdit && (
          <button className="acc-row-act" title={`'${node.name}'에 업로드`} onClick={() => triggerUpload(node.id)}>
            ⬆
          </button>
        )}
      </div>
      {node.expanded && (
        <ul className="acc-tree-ul">
          {node.children.map((c) => renderFolder(c, depth + 1))}
          {node.items.map((it) => {
            const open = it.id === openId;
            const m = it.urn ? meta.get(it.urn) : undefined;
            return (
              <li key={it.id} style={{ paddingLeft: (depth + 1) * 12 }}>
                <button
                  className="acc-row-btn"
                  title={it.name}
                  onClick={() => pickItem(it)}
                  style={{ opacity: it.urn || !isAccModel(it.name) ? 1 : 0.5, fontWeight: open ? 700 : 400 }}
                >
                  <span className="acc-caret" style={{ color: 'var(--accent)' }}>{open ? '✓' : ''}</span>
                  {isAccModel(it.name) ? '🧱' : '📄'} {it.name}
                </button>
                {m && <StatusBadge status={m.status} />}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );

  return (
    <section className="cde-content acc-browser">
      <div className="cde-toolbar">
        <strong style={{ fontSize: 13 }}>🅰 ACC 자료 (Autodesk)</strong>
        {canEdit && pinned && (
          <button
            className="primary"
            disabled={!sel || progress != null}
            title={sel ? `'${sel.name}' 폴더에 업로드` : '먼저 폴더를 선택하세요'}
            onClick={() => sel && triggerUpload(sel.id)}
          >
            {progress != null ? '업로드 중…' : sel ? `⬆ 업로드 → ${sel.name}` : '⬆ 업로드 (폴더 선택)'}
          </button>
        )}
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{status}</span>
      </div>

      <input ref={uploadInput} type="file" style={{ display: 'none' }} onChange={onUpload} />

      {progress != null && (
        <div className="upload-progress" title={`${Math.round(progress * 100)}%`}>
          <div className="upload-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          <span className="upload-progress-pct">{Math.round(progress * 100)}%</span>
        </div>
      )}

      <div className="acc-browser-body">
        {pinned ? (
          <ul className="acc-tree-ul">{roots.map((n) => renderFolder(n, 0))}</ul>
        ) : (
          <div className="muted empty" style={{ padding: 16 }}>{status}</div>
        )}
      </div>

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
    </section>
  );
}
