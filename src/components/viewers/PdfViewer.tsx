import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a hashed asset URL and serves the worker as a module.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FileRecord } from '../../lib/files';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF preview rendered page-by-page to canvases via PDF.js. */
export function PdfViewer({ url }: { url: string; file: FileRecord }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';

    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        setPageCount(pdf.numPages);
        // Render at a device-aware scale for crisp text without huge canvases.
        const scale = Math.min(2, window.devicePixelRatio || 1) * 1.25;
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return;
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.className = 'doc-pdf-page';
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          host.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url]);

  return (
    <div className="doc-stage doc-stage--scroll">
      {error && <p className="doc-error">PDF를 열 수 없습니다: {error}</p>}
      {!error && pageCount === 0 && <p className="muted doc-loading">PDF 불러오는 중…</p>}
      <div className="doc-pdf-pages" ref={hostRef} />
    </div>
  );
}
