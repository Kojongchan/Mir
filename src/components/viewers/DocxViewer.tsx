import { useEffect, useState } from 'react';
import mammoth from 'mammoth';
import type { FileRecord } from '../../lib/files';

/** Word .docx preview — mammoth.js converts to semantic HTML. */
export function DocxViewer({ url }: { url: string; file: FileRecord }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) setHtml(value);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error)
    return (
      <div className="doc-stage">
        <p className="doc-error">문서를 열 수 없습니다: {error}</p>
      </div>
    );
  if (html === null)
    return (
      <div className="doc-stage">
        <p className="muted doc-loading">문서 불러오는 중…</p>
      </div>
    );

  return (
    <div className="doc-stage doc-stage--scroll">
      {/* mammoth output is derived from a member-uploaded .docx; rendered as a
          document preview. */}
      <article className="doc-docx" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
