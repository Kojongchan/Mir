import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import type { FileRecord } from '../../lib/files';

interface Sheet {
  name: string;
  rows: string[][];
}

/**
 * Spreadsheet preview (xlsx/xls/csv) via SheetJS, rendered as HTML tables
 * with a tab per worksheet.
 *
 * SECURITY NOTE: the npm `xlsx` package is pinned at 0.18.5 (the latest the
 * registry serves) which carries known prototype-pollution / ReDoS advisories.
 * The patched build (>= 0.20.x) ships only from cdn.sheetjs.com, which the
 * current network policy blocks. Files here are uploaded by authenticated
 * project members (RLS-gated), which bounds exposure — but upgrade to the CDN
 * build once the policy allows it. See docs/STATUS.md (S13).
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
        const wb = XLSX.read(buf, { type: 'array' });
        const parsed: Sheet[] = wb.SheetNames.map((name) => ({
          name,
          rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
            header: 1,
            raw: false,
            defval: '',
          }),
        }));
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
      </div>
    </div>
  );
}
