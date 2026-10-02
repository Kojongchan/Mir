/// <reference lib="webworker" />
// Spreadsheet parsing runs here, never on the main thread: the npm `xlsx` build (0.18.5) has
// prototype-pollution and ReDoS advisories, and the patched build is only on cdn.sheetjs.com.
// A polluted prototype stays inside this worker, and the page terminates it on a timeout.
import * as XLSX from 'xlsx';

export interface SheetData { name: string; rows: string[][]; truncatedRows: number; truncatedCols: number }

self.onmessage = (event: MessageEvent<{ buf: ArrayBuffer; maxRows: number; maxCols: number }>) => {
  const { buf, maxRows, maxCols } = event.data;
  try {
    const wb = XLSX.read(buf, { type: 'array' });
    const sheets: SheetData[] = wb.SheetNames.map(name => {
      const all = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      let truncatedCols = 0;
      const rows = all.slice(0, maxRows).map(row => {
        if (row.length > maxCols) truncatedCols = Math.max(truncatedCols, row.length - maxCols);
        // Plain strings only cross back to the page (no objects from the parser).
        return row.slice(0, maxCols).map(cell => (cell == null ? '' : String(cell)));
      });
      return { name: String(name), rows, truncatedRows: Math.max(0, all.length - maxRows), truncatedCols };
    });
    (self as unknown as Worker).postMessage({ ok: true, sheets });
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
