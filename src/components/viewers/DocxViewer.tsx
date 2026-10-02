import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '../../lib/files';
import { sanitizeRendered } from './sanitizeRendered';

/** Word .docx preview rendered in the browser (docx-preview): pages, tables, images. No external service. */
export function DocxViewer({ url }: { url: string; file: FileRecord }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | string>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !bodyRef.current || !styleRef.current) return;
        bodyRef.current.innerHTML = ''; styleRef.current.innerHTML = '';
        await renderAsync(data, bodyRef.current, styleRef.current, {
          className: 'docx', inWrapper: true, breakPages: true, renderHeaders: true, renderFooters: true,
          renderFootnotes: true, renderEndnotes: true, renderComments: false, renderChanges: false,
          renderAltChunks: false, // embedded HTML chunks are not rendered
        });
        if (cancelled) return;
        sanitizeRendered(bodyRef.current);
        setStatus('ready');
      } catch (e) {
        if (!cancelled) setStatus((e as Error).message || '열 수 없습니다');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div className="doc-stage doc-stage--scroll">
      {status === 'loading' && <p className="muted doc-loading">문서 불러오는 중…</p>}
      {status !== 'loading' && status !== 'ready' && <p className="doc-error">문서를 열 수 없습니다: {status}</p>}
      <div ref={styleRef} />
      <div ref={bodyRef} className="docx-preview-host" />
    </div>
  );
}
