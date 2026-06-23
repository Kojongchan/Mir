import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a hashed asset URL and serves the worker as a module.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FileRecord } from '../../lib/files';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * PDF 미리보기 — 좌측 썸네일(전체 페이지) + 상단 페이지 넘김/점프 + 본문 1페이지.
 * ACC Docs PDF 뷰어와 동등한 탐색(썸네일 클릭/이전·다음/번호 입력).
 */
export function PdfViewer({ url }: { url: string; file: FileRecord }) {
  const mainRef = useRef<HTMLCanvasElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy['render']> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [current, setCurrent] = useState(1);

  // 문서 로드 + 썸네일 생성(한 번).
  useEffect(() => {
    let cancelled = false;
    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setCurrent(1);
        const host = thumbsRef.current;
        if (host) host.innerHTML = '';
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const vp = page.getViewport({ scale: 0.22 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = '100%';
          canvas.style.display = 'block';
          canvas.style.borderRadius = '3px';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: vp }).promise;

          const btn = document.createElement('button');
          btn.className = 'doc-pdf-thumb-btn';
          btn.dataset.page = String(n);
          Object.assign(btn.style, {
            display: 'block',
            width: '100%',
            marginBottom: '8px',
            padding: '4px',
            border: '2px solid transparent',
            borderRadius: '5px',
            background: 'transparent',
            cursor: 'pointer',
          } as CSSStyleDeclaration);
          const num = document.createElement('div');
          num.textContent = String(n);
          Object.assign(num.style, { fontSize: '11px', color: 'var(--muted)', marginTop: '2px' } as CSSStyleDeclaration);
          btn.appendChild(canvas);
          btn.appendChild(num);
          btn.onclick = () => setCurrent(n);
          host?.appendChild(btn);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });

    return () => {
      cancelled = true;
      task.destroy();
      pdfRef.current = null;
    };
  }, [url]);

  // 현재 페이지를 본문에 렌더 + 썸네일 활성표시/스크롤.
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = mainRef.current;
    if (!pdf || !canvas || pageCount === 0) return;
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
      thumbsRef.current?.querySelectorAll<HTMLButtonElement>('.doc-pdf-thumb-btn').forEach((el) => {
        const active = el.dataset.page === String(current);
        el.style.borderColor = active ? 'var(--accent)' : 'transparent';
        if (active) el.scrollIntoView({ block: 'nearest' });
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [current, pageCount]);

  const go = (d: number) => setCurrent((c) => Math.min(pageCount, Math.max(1, c + d)));

  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {error && <p className="doc-error">PDF를 열 수 없습니다: {error}</p>}
      {!error && pageCount === 0 && <p className="muted doc-loading">PDF 불러오는 중…</p>}
      {pageCount > 0 && (
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
            />
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
