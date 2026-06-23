import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a hashed asset URL and serves the worker as a module.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FileRecord } from '../../lib/files';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PDF = pdfjsLib.PDFDocumentProxy;

/** 보일 때만 렌더되는 썸네일(많은 페이지에서도 즉시 목록 표시·빠름). */
function Thumb({ pdf, n, active, onClick }: { pdf: PDF; n: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting || done.current) return;
        done.current = true;
        try {
          const page = await pdf.getPage(n);
          const vp = page.getViewport({ scale: 0.22 });
          el.width = vp.width;
          el.height = vp.height;
          const ctx = el.getContext('2d');
          if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
        } catch {
          /* 렌더 실패 무시 */
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pdf, n]);

  return (
    <button
      data-page={n}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        marginBottom: 8,
        padding: 4,
        border: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 5,
        background: 'transparent',
        cursor: 'pointer',
      }}
    >
      <canvas
        ref={ref}
        style={{ width: '100%', display: 'block', background: '#fff', minHeight: 70, borderRadius: 3 }}
      />
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{n}</div>
    </button>
  );
}

/**
 * PDF 미리보기 — 좌측 썸네일(지연 렌더) + 상단 페이지 넘김/점프 + 본문 1페이지.
 * ACC Docs 와 동등한 탐색. 많은 페이지에서도 사이드바가 즉시 뜬다.
 */
export function PdfViewer({ url }: { url: string; file: FileRecord }) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy['render']> | null>(null);
  const [pdf, setPdf] = useState<PDF | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [current, setCurrent] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then((doc) => {
        if (cancelled) return;
        setPdf(doc);
        setPageCount(doc.numPages);
        setCurrent(1);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url]);

  // 현재 페이지를 본문에 렌더 + 활성 썸네일로 스크롤.
  useEffect(() => {
    const canvas = mainRef.current;
    if (!pdf || !canvas) return;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(current);
      if (cancelled) return;
      const scale = Math.min(2, window.devicePixelRatio || 1) * 1.3;
      const vp = page.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderTaskRef.current?.cancel?.();
      const rt = page.render({ canvasContext: ctx, viewport: vp });
      renderTaskRef.current = rt;
      try {
        await rt.promise;
      } catch {
        /* 렌더 취소 무시 */
      }
      thumbsRef.current?.querySelector(`[data-page="${current}"]`)?.scrollIntoView({ block: 'nearest' });
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, current]);

  const go = (d: number) => setCurrent((c) => Math.min(pageCount, Math.max(1, c + d)));

  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {error && <p className="doc-error">PDF를 열 수 없습니다: {error}</p>}
      {!error && !pdf && <p className="muted doc-loading">PDF 불러오는 중…</p>}
      {pdf && pageCount > 0 && (
        <>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '6px 10px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <button onClick={() => go(-1)} disabled={current <= 1}>
              ◀ 이전
            </button>
            <span style={{ fontSize: 13 }}>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={current}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v) setCurrent(Math.min(pageCount, Math.max(1, v)));
                }}
                style={{ width: 56, marginRight: 4 }}
              />
              / {pageCount}
            </span>
            <button onClick={() => go(1)} disabled={current >= pageCount}>
              다음 ▶
            </button>
          </div>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div
              ref={thumbsRef}
              className="doc-pdf-thumbs"
              style={{ width: 150, overflowY: 'auto', borderRight: '1px solid var(--border)', padding: 8 }}
            >
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                <Thumb key={n} pdf={pdf} n={n} active={n === current} onClick={() => setCurrent(n)} />
              ))}
            </div>
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                padding: 14,
                background: 'var(--bg)',
              }}
            >
              <canvas ref={mainRef} className="doc-pdf-page" style={{ maxWidth: '100%' }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
