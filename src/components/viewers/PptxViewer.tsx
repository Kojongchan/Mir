import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '../../lib/files';
import { sanitizeRendered } from './sanitizeRendered';

/** PowerPoint .pptx preview rendered in the browser (pptx-preview): all slides in a scrollable list. */
export function PptxViewer({ url }: { url: string; file: FileRecord }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | string>('loading');

  useEffect(() => {
    let cancelled = false;
    let previewer: { destroy(): void } | null = null;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const { init } = await import('pptx-preview');
        const host = hostRef.current;
        if (cancelled || !host) return;
        host.innerHTML = '';
        const width = Math.max(320, Math.min(host.clientWidth - 24, 1280));
        const p = init(host, { width, height: Math.round(width * 9 / 16), mode: 'list' });
        previewer = p;
        await p.preview(data);
        if (cancelled) return;
        sanitizeRendered(host);
        setStatus('ready');
      } catch (e) {
        if (!cancelled) setStatus((e as Error).message || '열 수 없습니다');
      }
    })();
    return () => { cancelled = true; try { previewer?.destroy(); } catch { /* already gone */ } };
  }, [url]);

  return (
    <div className="doc-stage doc-stage--scroll">
      {status === 'loading' && <p className="muted doc-loading">슬라이드 불러오는 중…</p>}
      {status !== 'loading' && status !== 'ready' && <p className="doc-error">프레젠테이션을 열 수 없습니다: {status}</p>}
      <div ref={hostRef} className="pptx-preview-host" style={{ display: 'flex', justifyContent: 'center' }} />
    </div>
  );
}
