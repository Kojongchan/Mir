import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  drawingFileUrl,
  listPins,
  createPin,
  updatePin,
  deletePin,
  type Drawing,
  type DrawingPin,
} from '../lib/drawings';
import { renderDxfToCanvas } from '../lib/dxfRender';
import { createIssue } from '../lib/issues';
import { errMessage } from '../lib/errors';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  drawing: Drawing;
  projectId: string;
  isAdmin: boolean;
  authorName: string | null;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 2D 도면 뷰어 — PDF(pdf.js) / DXF(자체 렌더)를 캔버스에 그리고, 캔버스+핀 레이어를
 * 함께 CSS 변환(휠 줌·드래그 팬)한다. 핀은 캔버스 정규화 좌표(0..1)로 저장돼 줌/팬과
 * 무관하게 정합. admin 은 '핀 추가'로 좌표를 찍고 라벨/이슈를 연결할 수 있다(D11).
 */
export function DrawingSheet({ drawing, projectId, isAdmin, authorName }: Props) {
  const navigate = useNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [pins, setPins] = useState<DrawingPin[]>([]);
  const [addMode, setAddMode] = useState(false);
  const [sel, setSel] = useState<DrawingPin | null>(null);

  // 캔버스 콘텐츠를 뷰포트에 맞춰 초기 스케일/중앙정렬.
  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const cv = canvasRef.current;
    if (!vp || !cv || !cv.width) return;
    const s = Math.min(vp.clientWidth / cv.width, vp.clientHeight / cv.height) * 0.95;
    const scale = clamp(s || 1, 0.02, 20);
    setView({
      scale,
      tx: (vp.clientWidth - cv.width * scale) / 2,
      ty: (vp.clientHeight - cv.height * scale) / 2,
    });
  }, []);

  // 도면/페이지 로드 → 캔버스 렌더.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNote('');
    (async () => {
      try {
        const url = await drawingFileUrl(drawing.storage_path);
        if (cancelled) return;
        if (drawing.kind === 'pdf') {
          if (!pdfDocRef.current) {
            pdfDocRef.current = await pdfjsLib.getDocument({ url }).promise;
          }
          const pdf = pdfDocRef.current;
          const pg = await pdf.getPage(page);
          if (cancelled) return;
          const scale = Math.min(2, window.devicePixelRatio || 1) * 1.5;
          const viewport = pg.getViewport({ scale });
          const cv = canvasRef.current!;
          cv.width = viewport.width;
          cv.height = viewport.height;
          const ctx = cv.getContext('2d')!;
          await pg.render({ canvasContext: ctx, viewport }).promise;
        } else {
          const res = await fetch(url);
          const text = await res.text();
          if (cancelled) return;
          const r = renderDxfToCanvas(text, canvasRef.current!);
          if (!r.ok) {
            setError(r.error);
          } else {
            const skips = Object.entries(r.skipped);
            if (skips.length > 0) {
              const n = skips.reduce((a, [, v]) => a + v, 0);
              setNote(`일부 요소 미표시(${n}): ${skips.map(([k, v]) => `${k}×${v}`).join(', ')} — INSERT/SPLINE 등은 MVP 미지원`);
            }
          }
        }
        if (!cancelled) {
          fit();
          const all = await listPins(drawing.id);
          if (!cancelled) setPins(all);
        }
      } catch (e) {
        if (!cancelled) setError(errMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drawing.id, drawing.storage_path, drawing.kind, page, fit]);

  // 도면이 바뀌면 PDF 문서 캐시 해제.
  useEffect(() => {
    return () => {
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    };
  }, [drawing.id]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const vp = viewportRef.current!;
    const rect = vp.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const ns = clamp(v.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.02, 20);
      const k = ns / v.scale;
      return { scale: ns, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };

  // 빈 곳 드래그 = 팬.
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const onPanDown = (e: React.MouseEvent) => {
    if (addMode) return; // 핀 추가 모드에선 클릭=핀
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.sx), ty: p.ty + (e.clientY - p.sy) }));
    };
    const onUp = () => (panRef.current = null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const pageOf = (p: DrawingPin) => p.page === page;

  // 캔버스 위 클릭 → 정규화 좌표(줌/팬 무관, 캔버스 화면 사각형 기준).
  const onSheetClick = async (e: React.MouseEvent) => {
    if (!addMode || !isAdmin) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    const y = clamp((e.clientY - r.top) / r.height, 0, 1);
    try {
      const pin = await createPin({ drawingId: drawing.id, projectId, page, x, y });
      setPins((ps) => [...ps, pin]);
      setSel(pin);
      setAddMode(false);
    } catch (err) {
      setNote(`핀 추가 실패: ${errMessage(err)}`);
    }
  };

  const onSaveLabel = async (label: string) => {
    if (!sel) return;
    await updatePin(sel.id, { label: label || null });
    setPins((ps) => ps.map((p) => (p.id === sel.id ? { ...p, label: label || null } : p)));
    setSel((s) => (s ? { ...s, label: label || null } : s));
  };

  const onCreateIssue = async () => {
    if (!sel) return;
    const title = (sel.label || `도면 핀 (${drawing.name})`).slice(0, 120);
    try {
      const issueId = await createIssue(
        projectId,
        { title, description: `도면: ${drawing.name} (p.${sel.page})`, priority: 'normal' },
        authorName,
      );
      await updatePin(sel.id, { issue_id: issueId });
      setPins((ps) => ps.map((p) => (p.id === sel.id ? { ...p, issue_id: issueId } : p)));
      setSel((s) => (s ? { ...s, issue_id: issueId } : s));
      setNote('이슈가 생성되어 핀에 연결되었습니다.');
    } catch (err) {
      setNote(`이슈 생성 실패: ${errMessage(err)}`);
    }
  };

  const onDeletePin = async () => {
    if (!sel) return;
    try {
      await deletePin(sel.id);
      setPins((ps) => ps.filter((p) => p.id !== sel.id));
      setSel(null);
    } catch (err) {
      setNote(`핀 삭제 실패: ${errMessage(err)}`);
    }
  };

  const goToIssue = (issueId: string) =>
    navigate(`/project/${projectId}/issues`, { state: { focusIssueId: issueId } });

  return (
    <div className="draw-sheet-wrap">
      <div className="draw-toolbar">
        <span className="draw-title" title={drawing.name}>
          {drawing.kind.toUpperCase()} · {drawing.name}
        </span>
        {drawing.kind === 'pdf' && drawing.page_count > 1 && (
          <span className="draw-pager">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              ‹
            </button>
            <span className="muted">
              {page} / {drawing.page_count}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(drawing.page_count, p + 1))}
              disabled={page >= drawing.page_count}
            >
              ›
            </button>
          </span>
        )}
        <span className="spacer" />
        <button onClick={fit} title="화면에 맞춤">
          ⤢ 맞춤
        </button>
        {isAdmin && (
          <button
            className={addMode ? 'primary' : ''}
            onClick={() => setAddMode((a) => !a)}
            title="클릭하여 도면 위에 핀 추가"
          >
            📌 {addMode ? '핀 추가 중…' : '핀 추가'}
          </button>
        )}
        <span className="draw-pincount muted">핀 {pins.filter(pageOf).length}</span>
      </div>

      <div
        ref={viewportRef}
        className={`draw-viewport${addMode ? ' is-adding' : ''}`}
        onWheel={onWheel}
        onMouseDown={onPanDown}
      >
        {loading && <div className="draw-loading muted">도면 불러오는 중…</div>}
        {error && <div className="draw-error">도면을 열 수 없습니다: {error}</div>}
        <div
          className="draw-sheet"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          <canvas ref={canvasRef} className="draw-canvas" onClick={onSheetClick} />
          <div className="draw-pins">
            {pins.filter(pageOf).map((p) => (
              <button
                key={p.id}
                className={`draw-pin${p.issue_id ? ' has-issue' : ''}${sel?.id === p.id ? ' is-sel' : ''}`}
                style={{
                  left: `${p.x * 100}%`,
                  top: `${p.y * 100}%`,
                  transform: `translate(-50%, -50%) scale(${1 / view.scale})`,
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSel(p);
                }}
                title={p.label || (p.issue_id ? '이슈 연결됨' : '핀')}
              >
                {p.issue_id ? '!' : '•'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {note && <div className="draw-note muted">{note}</div>}

      {sel && (
        <PinEditor
          pin={sel}
          isAdmin={isAdmin}
          onClose={() => setSel(null)}
          onSaveLabel={onSaveLabel}
          onCreateIssue={onCreateIssue}
          onDelete={onDeletePin}
          onGoIssue={goToIssue}
        />
      )}
    </div>
  );
}

function PinEditor({
  pin,
  isAdmin,
  onClose,
  onSaveLabel,
  onCreateIssue,
  onDelete,
  onGoIssue,
}: {
  pin: DrawingPin;
  isAdmin: boolean;
  onClose: () => void;
  onSaveLabel: (label: string) => void | Promise<void>;
  onCreateIssue: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onGoIssue: (issueId: string) => void;
}) {
  const [label, setLabel] = useState(pin.label ?? '');
  useEffect(() => setLabel(pin.label ?? ''), [pin.id, pin.label]);

  return (
    <div className="draw-pin-editor">
      <div className="draw-pin-editor-head">
        <strong>📌 핀</strong>
        <button className="clash-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>
      <label className="clash-field">
        <span>라벨</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="예: 슬리브 누락"
          disabled={!isAdmin}
          onBlur={() => isAdmin && void onSaveLabel(label)}
        />
      </label>
      <div className="draw-pin-actions">
        {pin.issue_id ? (
          <button className="primary" onClick={() => onGoIssue(pin.issue_id!)}>
            이슈로 이동 →
          </button>
        ) : (
          isAdmin && (
            <button className="primary" onClick={() => void onCreateIssue()}>
              이슈 생성
            </button>
          )
        )}
        {isAdmin && (
          <button className="danger" onClick={() => void onDelete()}>
            핀 삭제
          </button>
        )}
      </div>
    </div>
  );
}
