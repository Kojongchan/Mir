import { useEffect, useRef, useState } from 'react';
import { init } from 'pptx-preview';
import type { FileRecord } from '../../lib/files';

/**
 * PowerPoint .pptx 미리보기 — pptx-preview 로 슬라이드를 순수 프론트엔드 렌더.
 * 파일 바이트(blob URL)를 ArrayBuffer 로 읽어 컨테이너에 슬라이드를 쌓는다.
 * 외부 서비스로 파일을 보내지 않는다(사내 문서 보호).
 */
export function PptxViewer({ url }: { url: string; file: FileRecord }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const wrap = wrapRef.current;
    if (!wrap) return;
    setError(null);
    setLoading(true);
    wrap.innerHTML = '';
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const width = Math.max(480, Math.min(1280, wrap.clientWidth || 960));
        const previewer = init(wrap, { width, height: Math.round((width * 9) / 16) });
        previewer.preview(buf);
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="doc-stage doc-stage--scroll">
      {error && <p className="doc-error">프레젠테이션을 열 수 없습니다: {error}</p>}
      {loading && !error && <p className="muted doc-loading">슬라이드 불러오는 중…</p>}
      <div ref={wrapRef} className="doc-pptx" style={{ display: error ? 'none' : 'block' }} />
    </div>
  );
}
