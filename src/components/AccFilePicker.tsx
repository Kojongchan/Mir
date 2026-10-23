import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accFetch, createAccFolder, uploadToAcc, isAccModel, type AccItem, type AccNamed } from '../lib/aps';
import { recordAccUpload } from '../lib/cde';
import { getProjectAcc } from '../lib/api';
import { ModalBackdrop } from './ModalBackdrop';

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
 * - 실무자는 현재 폴더 아래에 새 폴더를 만들 수 있고(`allowNewFolder`), 올린 파일을 바로 고를 수 있다(`pickUploaded`)
 * - 업로드는 여러 파일을 한 번에(선택 창 다중 선택 또는 창에 끌어놓기), 차례로 올린다. 같은 이름이 있으면 확인 후 새 버전
 */
export function AccFilePicker({
  projectId,
  canEdit,
  onPick,
  onPickMany,
  onClose,
  title = '자료관리에서 파일 선택',
  actionLabel = '＋ 첨부',
  accept,
  pickUploaded = false,
  allowNewFolder = false,
  hint,
}: {
  projectId: string;
  canEdit: boolean;
  onPick: (f: PickedAccFile) => void;
  /** pickUploaded 로 여러 파일을 올렸을 때 한 번에 받는다(형식 검사는 받는 쪽). 없으면 한 개일 때만 onPick. */
  onPickMany?: (files: PickedAccFile[]) => void;
  onClose: () => void;
  /** Window title (default: issue attachment wording). */
  title?: string;
  /** Row action label, e.g. '열기' when opening a model. */
  actionLabel?: string;
  /** Files that can be picked; others are shown dimmed (e.g. only 3D models). */
  accept?: (name: string) => boolean;
  /** 업로드가 끝나면 그 파일을 바로 고른 것으로 한다(onPick). */
  pickUploaded?: boolean;
  /** 실무자에게 '새 폴더' 를 보인다. */
  allowNewFolder?: boolean;
  /** 목록 위 안내 한 줄(예: 받을 수 있는 형식). */
  hint?: string;
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
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
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
    const seq = requestSeq;
    return () => {
      alive = false;
      seq.current++; // drop any response that arrives after closing
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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

  const uploading = progress != null;

  /**
   * 현재 폴더에 차례로 올린다(진행률은 전체 기준). 같은 이름이 이미 있으면 확인 후 그 파일의 새 버전으로 —
   * ACC 는 같은 폴더에 같은 이름의 새 파일을 거부하고, 이전 버전은 남는다.
   * 모두 성공했고 pickUploaded 면 바로 고른 것으로 넘기고, 하나라도 실패하면 창을 그대로 두고 실패를 보여 준다.
   */
  const uploadFiles = async (files: File[], note = '') => {
    if (!acc || !curId || !files.length || uploading) return;
    const existing = new Map(items.map((it) => [it.name, it.id]));
    const dupes = files.filter((f) => existing.has(f.name));
    if (dupes.length && !window.confirm(
      `이 폴더에 같은 이름의 파일이 ${dupes.length}개 있습니다: ${dupes.slice(0, 3).map((f) => f.name).join(', ')}${dupes.length > 3 ? ' …' : ''}\n` +
      '새 버전으로 올릴까요? 이전 버전은 자료관리에 남습니다.',
    )) {
      if (uploadInput.current) uploadInput.current.value = '';
      return;
    }
    const here = { folderId: curId, folderIds: path.map((p) => p.id), folderNames: path.map((p) => p.name) };
    const done: PickedAccFile[] = [];
    const failed: string[] = [];
    setProgress(0);
    for (const [i, file] of files.entries()) {
      setStatus(`업로드 중 (${i + 1}/${files.length}): ${file.name}`);
      try {
        const res = await uploadToAcc(acc.project, curId, file, {
          itemId: existing.get(file.name),
          onProgress: (p) => setProgress((i + p) / files.length),
          mirProject: projectId,
        });
        if (res.itemUrn) {
          await recordAccUpload(projectId, null, file.name, res.itemUrn, res.versionUrn, file.size).catch(() => {});
          done.push({ accProjectId: acc.project, accItemId: res.itemUrn, accUrn: res.urn, name: file.name, size: file.size, ...here });
        }
      } catch (err) {
        failed.push(`${file.name}(${(err as Error).message})`);
      }
    }
    setProgress(null);
    if (uploadInput.current) uploadInput.current.value = '';

    const usable = done.filter((f) => !accept || accept(f.name));
    if (pickUploaded && !failed.length && usable.length) {
      if (onPickMany) { onPickMany(done); return; }
      if (done.length === 1) { onPick(done[0]); return; }
    }
    await show(acc, path);
    const wrong = done.length - usable.length;
    setStatus([
      `올림 ${done.length}/${files.length}`,
      wrong ? `${wrong}개는 이 칸에 넣을 수 없는 형식(자료관리에만 올라감)` : '',
      failed.length ? `실패: ${failed.join(', ')}` : '',
      note,
      usable.length ? '아래에서 선택하세요.' : '',
    ].filter(Boolean).join(' · '));
  };

  // 끌어놓기: 창 어디에 놓아도 현재 폴더로 올린다. 파일이 아닌 끌기(글자 등)와 폴더는 무시.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = curId && !uploading ? 'copy' : 'none';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!canEdit || !hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!curId) { setStatus('폴더를 먼저 연 뒤 놓으세요.'); return; }
    if (uploading) { setStatus('지금 올리는 중입니다. 끝난 뒤 다시 놓으세요.'); return; }
    const files: File[] = [];
    let dirs = 0;
    const entries = Array.from(e.dataTransfer.items ?? []).filter((it) => it.kind === 'file');
    if (entries.length) {
      for (const it of entries) {
        if (it.webkitGetAsEntry?.()?.isDirectory) { dirs++; continue; }
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    } else {
      files.push(...Array.from(e.dataTransfer.files));
    }
    const note = dirs ? `폴더 ${dirs}개는 건너뜀(파일만 올릴 수 있음)` : '';
    if (!files.length) { setStatus(note || '올릴 파일이 없습니다.'); return; }
    void uploadFiles(files, note);
  };

  // 창 밖(뒤 배경)에 잘못 놓아 브라우저가 파일을 열고 화면을 떠나지 않게 한다.
  useEffect(() => {
    if (!canEdit) return;
    const guard = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') || boxRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, [canEdit]);

  const onCreateFolder = async () => {
    const name = (newFolder ?? '').trim();
    if (!acc || !curId || !name || creating) return;
    setCreating(true);
    setStatus(`폴더 만드는 중: ${name}`);
    try {
      const f = await createAccFolder(acc.project, curId, name, projectId);
      setNewFolder(null);
      await show(acc, [...path, { id: f.id, name: f.name }]);
      setStatus(`새 폴더: ${f.name} — 여기에 올리세요.`);
    } catch (err) {
      setStatus(`폴더 만들기 실패: ${(err as Error).message}`);
    } finally {
      setCreating(false);
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
    <ModalBackdrop className="acc-modal-back acc-picker-back" onClose={onClose}>
      <div
        ref={boxRef}
        className={`acc-modal acc-picker${dragging ? ' is-dragging' : ''}`}
        role="dialog"
        aria-label={title}
        style={pos ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 } : undefined}
        onClick={(e) => e.stopPropagation()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="acc-modal-head acc-picker-head" onPointerDown={onHeadPointerDown} title="끌어서 이동">
          📁 {title}
          <div className="spacer" />
          {canEdit && allowNewFolder && (
            <button disabled={!curId || creating || newFolder != null} title={curId ? '현재 폴더 아래에 새 폴더' : '폴더를 먼저 여세요'}
              onClick={() => setNewFolder('')}>＋ 새 폴더</button>
          )}
          {canEdit && (
            <>
              <input ref={uploadInput} type="file" multiple style={{ display: 'none' }}
                onChange={(e) => void uploadFiles(Array.from(e.target.files ?? []))} />
              <button className="primary" disabled={!curId || uploading}
                title={curId ? '현재 폴더에 업로드 — 여러 개 선택 가능, 파일을 이 창에 끌어놓아도 됩니다' : '폴더를 먼저 여세요'}
                onClick={() => uploadInput.current?.click()}>
                {uploading ? '업로드 중…' : '⬆ 이 폴더에 업로드'}
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

        {newFolder != null && (
          <form className="acc-picker-newfolder" onSubmit={(e) => { e.preventDefault(); void onCreateFolder(); }}>
            <input autoFocus value={newFolder} maxLength={120} placeholder="새 폴더 이름" aria-label="새 폴더 이름"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNewFolder(null); } }} />
            <button type="submit" className="primary" disabled={!newFolder.trim() || creating}>{creating ? '만드는 중…' : '만들기'}</button>
            <button type="button" onClick={() => setNewFolder(null)} disabled={creating}>취소</button>
          </form>
        )}

        {hint && <div className="muted acc-picker-hint">{hint}</div>}

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

        {dragging && (
          <div className={`acc-picker-drop${curId && !uploading ? '' : ' is-blocked'}`} aria-hidden>
            {!curId ? '폴더를 먼저 여세요' : uploading ? '지금 올리는 중입니다' : `여기에 놓으면 「${path[path.length - 1].name}」 폴더에 올립니다`}
          </div>
        )}
      </div>
    </ModalBackdrop>,
    document.body,
  );
}
