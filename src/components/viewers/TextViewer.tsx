import { useEffect, useState } from 'react';
import type { FileRecord } from '../../lib/files';

/** Plain-text preview — txt/md/json/xml/log/yaml. */
export function TextViewer({ url }: { url: string; file: FileRecord }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        // Guard against accidentally rendering a huge file in one block.
        if (!cancelled) setText(body.length > 2_000_000 ? body.slice(0, 2_000_000) + '\n…(이하 생략)' : body);
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
        <p className="doc-error">파일을 열 수 없습니다: {error}</p>
      </div>
    );
  if (text === null)
    return (
      <div className="doc-stage">
        <p className="muted doc-loading">불러오는 중…</p>
      </div>
    );

  return (
    <div className="doc-stage doc-stage--scroll">
      <pre className="doc-text">{text}</pre>
    </div>
  );
}
