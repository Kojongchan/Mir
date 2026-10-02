import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accFetch, uploadToAcc, isAccModel, type AccItem, type AccNamed } from '../lib/aps';
import { recordAccUpload } from '../lib/cde';
import { getProjectAcc } from '../lib/api';

export interface PickedAccFile {
  accProjectId: string;
  accItemId: string;
  accUrn: string | null;
  name: string;
  size: number | null;
  folderId: string | null;
  folderIds: string[];
  folderNames: string[];
}

type Crumb = { id: string; name: string };

/** Last opened folder per project, so reopening the picker returns where the user was. */
const lastPathKey = (projectId: string) => `mir:acc-picker-path:${projectId}`;
function readLastPath(projectId: string): Crumb[] | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(lastPathKey(projectId)) ?? 'null');
    return Array.isArray(v) && v.every(c => c && typeof c.id === 'string' && typeof c.name === 'string') ? v : null;
  } catch { return null; }
}
function writeLastPath(projectId: string, path: Crumb[]) {
  try { sessionStorage.setItem(lastPathKey(projectId), JSON.stringify(path)); } catch { /* storage blocked */ }
}

/**
 * 자료관리(ACC) 파일 선택기 — 폴더를 탐색해 파일을 고르면 폴더 경로(조상 id/이름 체인)와 함께
 * 반환한다. 실무자는 현재 폴더로 직접 업로드할 수도 있다.
 *
 * - 고정 크기 창 + 목록만 스크롤(폴더/파일 수·경로 길이에 따라 창 크기가 바뀌지 않음)
 * - 제목줄을 끌어 창 이동(화면 안으로 제한), Esc 로 닫기
 * - 늦게 도착한 이전 폴더 응답은 버리고, 로딩 중 중복 클릭(더블클릭)으로 경로가 쌓이지 않게
 * - 폴더 내 이름 검색, 프로젝트별 마지막 폴더 기억
 */
export function AccFilePicker({
  projectId,
  canEdit,
  onPick,
  onClose,
  title = '자료관리에서 파일 선택',
  actionLabel = '＋ 첨부',
  accept,
}: {
  projectId: string;
  canEdit: boolean;
  onPick: (f: PickedAccFile) => void;
  onClose: () => void;
  /** Window title (default: issue attachment wording). */
  title?: string;
  /** Row action label, e.g. '열기' when opening a model. */
  actionLabel?: string;
  /** Files that can be picked; others are shown dimmed (e.g. only 3D models). */
  accept?: (name: string) => boolean;
}) {
  const [acc, setAcc] = useState<{ project: string; hub: string; rootId: string | null; rootName: string } | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<AccNamed[]>([]);
  const [items, setItems] = useState<AccItem[]>([]);
  const [status, setStatus] = useState('불러오는 중…');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const requestSeq = useRef(0);

  const curId = path.length ? path[path.length - 1].id : null;

  /** Load a folder and make `nextPath` current — only the latest request may update the view. */
  const show = async (accInfo: { project: string; hub: string }, nextPath: Crumb[]) => {
    const seq = ++requestSeq.current;
    const folderId = nextPath.length ? nextPath[nextPath.length - 1].id : null;
    setPath(nextPath);
    setLoading(true);
    setFilter('');
    setStatus('불러오는 중…');
    try {
      const result = folderId
        ? await accFetch({ action: 'contents', project: accInfo.project, folder: folderId })
        : { ...(await accFetch({ action: 'topFolders', hub: accInfo.hub, project: accInfo.project })), items: [] };
      if (seq !== requestSeq.current) return; // a newer navigation won
      setFolders((result.folders ?? []) as AccNamed[]);
      setItems((result.items ?? []) as AccItem[]);
      setStatus('');
      writeLastPath(projectId, nextPath);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setFolders([]);
      setItems([]);
      setStatus(`폴더 열기 실패: ${(e as Error).message}`);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const a = await getProjectAcc(projectId);
        if (!alive) return;
        if (!a.acc_hub_id || !a.acc_project_id) {
          setLoading(false);
          setStatus('ACC 프로젝트가 지정되지 않았습니다(통합모델 메뉴에서 고정).');
          return;
        }
        const info = { project: a.acc_project_id, hub: a.acc_hub_id, rootId: a.acc_root_folder_id ?? null, rootName: a.acc_root_folder_name || '시작 폴더' };
        setAcc(info);
        const rootPath = info.rootId ? [{ id: info.rootId, name: info.rootName }] : [];
        // Reopen the last folder when it is still under the pinned start folder.
        const last = readLastPath(projectId);
        const resume = last && last.length && (!info.rootId || last[0]?.id === info.rootId) ? last : null;
        await show(info, resume ?? rootPath);
      } catch (e) {
        if (alive) { setLoading(false); setStatus(`ACC 오류: ${(e as Error).message}`); }
      }
    })();
    return () => {
      alive = false;
      requestSeq.current++; // drop any response that arrives after closing
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep the deepest breadcrumb visible.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  const enter = (f: AccNamed) => {
    if (!acc || loading) return; // ignore the second click of a double-click
    void show(acc, [...path, { id: f.id, name: f.name }]);
  };
  const goTo = (index: number) => {
    if (!acc) return;
    if (index < 0) {
      void show(acc, acc.rootId ? [{ id: acc.rootId, name: acc.rootName }] : []);
      return;
    }
    if (index === path.length - 1 && !loading) return;
    void show(acc, path.slice(0, index + 1));
  };

  const pick = (it: AccItem) => {
    if (!acc || (accept && !accept(it.name))) return;
    onPick({
      accProjectId: acc.project,
      accItemId: it.id,
      accUrn: it.urn,
      name: it.name,
      size: it.size ?? null,
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
      await show(acc, path);
      setStatus(`업로드됨: ${file.name} — 아래에서 선택하세요.`);
    } catch (err) {
      setStatus(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  // Drag the window by its title bar (pointer events: mouse, pen and touch), clamped to the viewport.
  const onHeadPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - dx, 80 - rect.width), window.innerWidth - 80);
      const y = Math.min(Math.max(ev.clientY - dy, 8), window.innerHeight - 48);
      setPos({ x, y });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  const q = filter.trim().toLowerCase();
  const shownFolders = useMemo(() => (q ? folders.filter(f => f.name.toLowerCase().includes(q)) : folders), [folders, q]);
  const shownItems = useMemo(() => (q ? items.filter(it => it.name.toLowerCase().includes(q)) : items), [items, q]);

  return createPortal(
    <div className="acc-modal-back acc-picker-back" onClick={onClose}>
      <div
        ref={boxRef}
        className="acc-modal acc-picker"
        role="dialog"
        aria-label={title}
        style={pos ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="acc-modal-head acc-picker-head" onPointerDown={onHeadPointerDown} title="끌어서 이동">
          📁 {title}
          <div className="spacer" />
          {canEdit && (
            <>
              <input ref={uploadInput} type="file" style={{ display: 'none' }} onChange={onUpload} />
              <button className="primary" disabled={!curId || progress != null} title={curId ? '현재 폴더에 업로드' : '폴더를 먼저 여세요'} onClick={() => uploadInput.current?.click()}>
                {progress != null ? '업로드 중…' : '⬆ 이 폴더에 업로드'}
              </button>
            </>
          )}
          <button onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {/* 브레드크럼 — 한 줄, 넘치면 가로 스크롤(창 높이 고정) */}
        <nav className="acc-crumbs acc-picker-crumbs" ref={crumbsRef}>
          <button onClick={() => goTo(-1)}>{acc?.rootName ?? '최상위'}</button>
          {path.map((c, i) => (
            i === 0 && acc?.rootId ? null : (
              <span key={`${i}:${c.id}`}>
                <span className="sep">/</span>
                <button onClick={() => goTo(i)} aria-current={i === path.length - 1 ? 'page' : undefined}>{c.name}</button>
              </span>
            )
          ))}
        </nav>

        <input
          className="acc-picker-filter"
          type="search"
          placeholder="이 폴더에서 이름 검색"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="이름 검색"
        />

        {progress != null && (
          <div className="upload-progress" title={`${Math.round(progress * 100)}%`}>
            <div className="upload-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}

        <div className="acc-picker-list" aria-busy={loading}>
          {shownFolders.map((f) => (
            <button key={f.id} className="acc-picker-row folder" disabled={loading} onClick={() => enter(f)}>
              📁 <span className="acc-picker-name">{f.name}</span>
              <span className="acc-picker-go">열기 ›</span>
            </button>
          ))}
          {shownItems.map((it) => {
            const ok = !accept || accept(it.name);
            return (
              <button key={it.id} className={`acc-picker-row${ok ? '' : ' is-disabled'}`} disabled={!ok}
                onClick={() => pick(it)} title={ok ? it.name : '이 화면에서 열 수 없는 형식입니다'}>
                {isAccModel(it.name) ? '🧱' : '📄'} <span className="acc-picker-name">{it.name}</span>
                {ok && <span className="acc-picker-go">{actionLabel}</span>}
              </button>
            );
          })}
          {!loading && shownFolders.length === 0 && shownItems.length === 0 && !status && (
            <div className="muted" style={{ padding: 12 }}>{q ? '검색 결과가 없습니다.' : '이 폴더가 비어 있습니다.'}</div>
          )}
        </div>

        <div className="muted acc-picker-status" aria-live="polite">{status}</div>
      </div>
    </div>,
    document.body,
  );
}
