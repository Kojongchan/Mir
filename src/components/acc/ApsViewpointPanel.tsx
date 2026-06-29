import { useEffect, useRef, useState } from 'react';
import {
  addApsViewpoint,
  deleteApsViewpoint,
  listApsViewpoints,
  type ApsViewpoint,
} from '../../lib/apsViewpoints';

interface Props {
  /** Autodesk.Viewing.GuiViewer3D 인스턴스(없으면 비활성). */
  viewer: any;
  projectId: string;
  isAdmin: boolean;
  onClose: () => void;
}

/**
 * APS(ACC) 통합모델(3D) 전용 관측점(시점 북마크) — IFC 뷰어 ViewpointPanel 의
 * APS 이식판(S52). 현재 카메라·표시상태를 viewer.getState() 로 캡처해 이름 붙여
 * localStorage 에 저장하고, 썸네일로 골라 restoreState 로 재호출한다.
 */
export function ApsViewpointPanel({ viewer, projectId, isAdmin, onClose }: Props) {
  const [win, setWin] = useState({ x: 96, y: 72, w: 320, h: 460 });
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [list, setList] = useState<ApsViewpoint[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => setList(listApsViewpoints(projectId));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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

  // APS getScreenShot 은 콜백/Promise 혼재 — 콜백 기반으로 통일해 썸네일을 얻는다.
  const captureThumb = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (!viewer?.getScreenShot) {
        resolve(null);
        return;
      }
      try {
        viewer.getScreenShot(240, 160, (blobUrl: string) => resolve(blobUrl || null));
      } catch {
        resolve(null);
      }
    });

  const onSave = async () => {
    if (!viewer) return;
    const name = window.prompt('관측점 이름', `시점 ${new Date().toLocaleString('ko-KR')}`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const state = viewer.getState();
      const thumbnail = await captureThumb();
      addApsViewpoint(projectId, { name: name.trim(), state, thumbnail });
      refresh();
      setStatus(`저장됨: ${name.trim()}`);
    } catch (e) {
      setStatus(`저장 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const recall = (vp: ApsViewpoint) => {
    if (!viewer) return;
    try {
      viewer.restoreState(vp.state);
      setStatus(`재호출: ${vp.name}`);
    } catch (e) {
      setStatus(`재호출 실패: ${(e as Error).message}`);
    }
  };

  const onDelete = (vp: ApsViewpoint) => {
    if (!window.confirm(`"${vp.name}" 관측점을 삭제할까요?`)) return;
    deleteApsViewpoint(projectId, vp.id);
    refresh();
    setStatus('삭제됨');
  };

  return (
    <div className="clash-win" style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
      <div className="clash-head" onMouseDown={startDrag('move')}>
        <h3>📌 관측점</h3>
        <button className="clash-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="clash-scroll">
        <div className="vp-toolbar">
          {isAdmin ? (
            <button className="primary" onClick={() => void onSave()} disabled={busy || !viewer}>
              ＋ 현재 시점 저장
            </button>
          ) : (
            <span className="muted vp-hint">멤버는 재호출만 가능</span>
          )}
        </div>

        <div className="vp-list">
          {list.length === 0 && (
            <p className="muted vp-empty">
              저장된 관측점이 없습니다. 카메라를 맞춘 뒤 <b>현재 시점 저장</b> 으로 기록하세요.
            </p>
          )}
          {list.map((vp) => (
            <div className="vp-card" key={vp.id}>
              <button className="vp-thumb" onClick={() => recall(vp)} title="이 시점으로 재호출">
                {vp.thumbnail ? <img src={vp.thumbnail} alt={vp.name} /> : <span className="muted">미리보기 없음</span>}
              </button>
              <div className="vp-card-body">
                <strong className="vp-name" title={vp.name}>
                  {vp.name}
                </strong>
                <span className="muted vp-when">{new Date(vp.created_at).toLocaleDateString('ko-KR')}</span>
                <div className="vp-card-actions">
                  <button onClick={() => recall(vp)}>재호출</button>
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
