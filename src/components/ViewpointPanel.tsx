import { useEffect, useRef, useState } from 'react';
import type { IfcViewer } from '../viewer/IfcViewer';
import {
  bakeMarkup,
  createViewpoint,
  dataUrlToFile,
  deleteViewpoint,
  listViewpoints,
  type DisplayState,
  type MarkupShape,
  type Viewpoint,
} from '../lib/viewpoints';
import { createIssue } from '../lib/issues';
import { uploadAttachment } from '../lib/attachments';

interface Props {
  viewer: IfcViewer | null;
  projectId: string;
  /** 저장 컨텍스트로 기록할 DB 모델 uuid(없으면 장면 전체). */
  modelDbId: string | null;
  isAdmin: boolean;
  authorName: string | null;
  /** 현재 표시상태를 캡처(저장 시) / 복원(재호출 시). */
  getDisplayState: () => DisplayState;
  applyDisplayState: (d: DisplayState) => void;
  /** 현재 마크업(저장 시 캡처) + 재호출 시 교체. */
  markup: MarkupShape[];
  setMarkup: (shapes: MarkupShape[]) => void;
  /** 딥링크: 이 뷰포인트를 열자마자 자동 재호출(이슈→뷰포인트). */
  autoOpenId?: string | null;
  onClose: () => void;
}

/**
 * 저장 뷰포인트 — 이동/크기 조절 가능한 팝업 창. 현재 카메라·표시상태·마크업을
 * 이름 붙여 저장하고, 목록에서 썸네일로 골라 재호출한다(Navisworks Saved Viewpoints).
 * 뷰포인트 → 이슈(스냅샷에 마크업을 구워 첨부 + viewpoint_id 연결)도 한 창에서.
 */
export function ViewpointPanel({
  viewer,
  projectId,
  modelDbId,
  isAdmin,
  authorName,
  getDisplayState,
  applyDisplayState,
  markup,
  setMarkup,
  autoOpenId,
  onClose,
}: Props) {
  const [win, setWin] = useState({ x: 96, y: 72, w: 320, h: 480 });
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const [list, setList] = useState<Viewpoint[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const autoDoneRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      setWin((w) =>
        d.mode === 'move'
          ? { ...w, x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) }
          : { ...w, w: Math.max(280, d.ox + dx), h: Math.max(240, d.oy + dy) },
      );
    };
    const onUp = () => (dragRef.current = null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = (mode: 'move' | 'resize') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      ox: mode === 'move' ? win.x : win.w,
      oy: mode === 'move' ? win.y : win.h,
    };
  };

  const refresh = async () => {
    try {
      setList(await listViewpoints(projectId));
    } catch {
      /* 0017 미적용/권한 — 무시 */
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 딥링크(이슈→뷰포인트): 목록 로드 후 한 번 자동 재호출.
  useEffect(() => {
    if (!autoOpenId || autoDoneRef.current || list.length === 0 || !viewer) return;
    const vp = list.find((v) => v.id === autoOpenId);
    if (vp) {
      autoDoneRef.current = true;
      recall(vp);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenId, list, viewer]);

  const onSave = async () => {
    if (!viewer) return;
    const name = window.prompt('뷰포인트 이름', `뷰 ${new Date().toLocaleString()}`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const camera = viewer.getCameraState();
      const thumbnail = viewer.captureThumbnail();
      await createViewpoint({
        projectId,
        modelId: modelDbId,
        name: name.trim(),
        camera,
        display: getDisplayState(),
        markup,
        thumbnail,
      });
      await refresh();
      setStatus(`저장됨: ${name.trim()}`);
    } catch (e) {
      setStatus(`저장 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const recall = (vp: Viewpoint) => {
    if (!viewer) return;
    viewer.applyCameraState(vp.camera);
    if (vp.display) applyDisplayState(vp.display);
    setMarkup(vp.markup ?? []);
    setStatus(`재호출: ${vp.name}`);
  };

  const onDelete = async (vp: Viewpoint) => {
    if (!window.confirm(`"${vp.name}" 뷰포인트를 삭제할까요?`)) return;
    try {
      await deleteViewpoint(vp.id);
      await refresh();
      setStatus('삭제됨');
    } catch (e) {
      setStatus(`삭제 실패: ${(e as Error).message}`);
    }
  };

  // 뷰포인트 → 이슈: 재호출 후 스냅샷에 마크업을 구워 첨부 + viewpoint_id 연결.
  const onMakeIssue = async (vp: Viewpoint) => {
    if (!viewer) return;
    const title = window.prompt('이슈 제목', vp.name);
    if (!title?.trim()) return;
    setBusy(true);
    try {
      recall(vp);
      const issueId = await createIssue(
        projectId,
        {
          title: title.trim(),
          description: `뷰포인트 "${vp.name}" 에서 생성된 이슈.`,
          priority: 'normal',
          model_id: vp.model_id,
          viewpoint_id: vp.id,
        },
        authorName,
      );
      // 마크업을 박은 스냅샷을 첨부(있으면 굽고, 없으면 깨끗한 스냅샷).
      try {
        const base = viewer.captureSnapshot();
        const baked = vp.markup.length > 0 ? await bakeMarkup(base, vp.markup) : base;
        await uploadAttachment(projectId, 'issue', issueId, dataUrlToFile(baked, `viewpoint_${vp.id}.png`));
      } catch {
        /* 첨부 실패는 비치명적 */
      }
      setStatus(`이슈 생성됨: ${title.trim()} — 협업·이슈에서 확인`);
    } catch (e) {
      setStatus(`이슈 생성 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clash-win" style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
      <div className="clash-head" onMouseDown={startDrag('move')}>
        <h3>📌 뷰포인트</h3>
        <button className="clash-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="clash-scroll">
        <div className="vp-toolbar">
          {isAdmin ? (
            <button className="primary" onClick={onSave} disabled={busy || !viewer}>
              ＋ 현재 뷰 저장
            </button>
          ) : (
            <span className="muted">멤버는 저장된 뷰를 재호출할 수 있습니다.</span>
          )}
        </div>

        <div className="vp-list">
          {list.length === 0 && (
            <p className="muted vp-empty">
              저장된 뷰포인트가 없습니다. 카메라·표시상태·마크업을 맞춘 뒤{' '}
              <b>현재 뷰 저장</b> 으로 기록하세요.
            </p>
          )}
          {list.map((vp) => (
            <div className="vp-card" key={vp.id}>
              <button className="vp-thumb" onClick={() => recall(vp)} title="이 뷰로 재호출">
                {vp.thumbnail ? (
                  <img src={vp.thumbnail} alt={vp.name} />
                ) : (
                  <span className="muted">미리보기 없음</span>
                )}
                {vp.markup.length > 0 && <span className="vp-markup-badge">✎ {vp.markup.length}</span>}
              </button>
              <div className="vp-card-body">
                <strong className="vp-name" title={vp.name}>
                  {vp.name}
                </strong>
                <span className="muted vp-when">{new Date(vp.created_at).toLocaleDateString('ko-KR')}</span>
                <div className="vp-card-actions">
                  <button onClick={() => recall(vp)}>재호출</button>
                  {isAdmin && (
                    <button onClick={() => onMakeIssue(vp)} disabled={busy} title="이 뷰로 이슈 생성">
                      이슈
                    </button>
                  )}
                  {isAdmin && (
                    <button className="danger" onClick={() => onDelete(vp)}>
                      삭제
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {status && <div className="clash-status-bar muted">{status}</div>}
      </div>

      <div className="clash-resize" onMouseDown={startDrag('resize')} title="크기 조절" />
    </div>
  );
}
