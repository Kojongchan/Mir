import { useEffect, useMemo, useState } from 'react';
import type { FileRecord } from '../../lib/files';
import type { SheetData } from '../../workers/sheetParse.worker';

type Sheet = SheetData;

/** Rendering caps: a 100k-row sheet as one HTML table freezes the tab. */
const MAX_ROWS = 5000, MAX_COLS = 200, PARSE_TIMEOUT_MS = 20000;

/** Parse in an isolated worker with a hard timeout (see sheetParse.worker.ts). */
function parseInWorker(buf: ArrayBuffer): Promise<Sheet[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/sheetParse.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('파일 해석 시간이 초과되었습니다')); }, PARSE_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; sheets?: Sheet[]; error?: string }>) => {
      clearTimeout(timer); worker.terminate();
      if (e.data.ok && e.data.sheets) resolve(e.data.sheets); else reject(new Error(e.data.error || '해석 실패'));
    };
    worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message || '해석 실패')); };
    worker.postMessage({ buf, maxRows: MAX_ROWS, maxCols: MAX_COLS }, [buf]);
  });
}

/**
 * Spreadsheet preview (xlsx/xls/csv) via SheetJS, rendered as HTML tables
 * with a tab per worksheet.
 *
 * SECURITY NOTE: the npm `xlsx` package is pinned at 0.18.5 (the latest the
 * registry serves) which carries known prototype-pollution / ReDoS advisories.
 * The patched build (>= 0.20.x) ships only from cdn.sheetjs.com, which the
 * current network policy blocks. Parsing therefore runs in a dedicated worker
 * with a timeout, and only plain strings cross back to the page. Upgrade to the
 * CDN build once the policy allows it.
 */
export function SheetViewer({ url }: { url: string; file: FileRecord }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const parsed = await parseInWorker(buf);
        if (!cancelled) {
          setSheets(parsed);
          setActive(0);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const current = useMemo(() => (sheets ? sheets[active] : null), [sheets, active]);

  if (error) return <div className="doc-stage"><p className="doc-error">스프레드시트를 열 수 없습니다: {error}</p></div>;
  if (!sheets) return <div className="doc-stage"><p className="muted doc-loading">스프레드시트 불러오는 중…</p></div>;

  return (
    <div className="doc-stage doc-stage--scroll">
      {sheets.length > 1 && (
        <div className="doc-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              className={i === active ? 'doc-sheet-tab is-active' : 'doc-sheet-tab'}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="doc-sheet-wrap">
        <table className="doc-sheet-table">
          <tbody>
            {current?.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {current && current.rows.length === 0 && <p className="muted">빈 시트입니다.</p>}
        {current && (current.truncatedRows > 0 || current.truncatedCols > 0) && (
          <p className="muted">
            미리보기는 {MAX_ROWS.toLocaleString()}행 × {MAX_COLS}열까지만 표시합니다
            {current.truncatedRows > 0 ? ` (행 ${current.truncatedRows.toLocaleString()}개 생략)` : ''}
            {current.truncatedCols > 0 ? ` (열 ${current.truncatedCols}개 생략)` : ''}. 전체는 파일을 내려받아 확인하세요.
          </p>
        )}
      </div>
    </div>
  );
}
