// 자료관리(ACC) 문서에서 AI 에 넘길 글을 뽑는다 — PDF 는 쪽별 글(텍스트 층, OCR 아님), 내역서는 시트 행.
// 문서는 브라우저에서만 읽고, AI 에는 고른 쪽·행만 보낸다.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { accFileBlobUrl } from '../aps';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageText {
  page: number;
  text: string;
}

/** '9-38, 1179-1210, 45' → 쪽 번호 목록(1부터). 빈 글이면 null(전부). */
export function parsePageRange(text: string, max: number): number[] | null {
  if (!text.trim()) return null;
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(max, Math.max(a, b)); p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

/** 한 쪽의 글: 같은 줄(세로 위치)끼리 모아 위에서 아래로. */
function pageLines(items: { str: string; transform: number[] }[]): string {
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3);
    (rows.get(y) ?? rows.set(y, []).get(y)!).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([, r]) => r.sort((a, b) => a.x - b.x).map(c => c.s.trim()).join('  '))
    .join('\n');
}

/**
 * ACC PDF 의 쪽 글. pages 를 주면 그 쪽만, keep 을 주면 그 글을 담은 쪽만 남긴다.
 */
export async function accPdfPages(
  accProjectId: string, accItemId: string,
  opts: { pages?: string; keep?: RegExp; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ pages: PageText[]; total: number }> {
  const url = await accFileBlobUrl(accProjectId, accItemId);
  try {
    const doc = await pdfjsLib.getDocument({ url }).promise;
    const wanted = parsePageRange(opts.pages ?? '', doc.numPages) ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const out: PageText[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const page = await doc.getPage(wanted[i]);
      const tc = await page.getTextContent();
      const text = pageLines(tc.items as { str: string; transform: number[] }[]).replace(/[ \t]{3,}/g, '  ');
      if (!opts.keep || opts.keep.test(text)) out.push({ page: wanted[i], text });
      opts.onProgress?.(i + 1, wanted.length);
    }
    await doc.destroy();
    return { pages: out, total: doc.numPages };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** AI 한 번에 보낼 만큼씩 쪽을 나눈다(글자 수 기준). */
export function chunkPages(pages: PageText[], maxChars = 200_000): PageText[][] {
  const out: PageText[][] = [];
  let cur: PageText[] = [], size = 0;
  for (const p of pages) {
    if (cur.length && size + p.text.length > maxChars) { out.push(cur); cur = []; size = 0; }
    cur.push(p); size += p.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface BoqLine {
  id: string;
  name: string;
  spec: string;
  unit: string;
  qty: number;
  amount: number;
}

/**
 * 산출내역서(xls/xlsx)의 '내역서' 시트에서 section(예 '2-1. 연제교')부터 같은 깊이의 다음 제목 전까지의 항목 행.
 * 열: 공종명·규격·수량·단위 … 합계 금액(12번째 칸). 단위가 있고 수량이 있는 행만('식' 묶음 행 제외).
 */
export async function accBoqLines(accProjectId: string, accItemId: string, section: string): Promise<BoqLine[]> {
  const url = await accFileBlobUrl(accProjectId, accItemId);
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await (await fetch(url)).arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets['내역서'] ?? wb.Sheets[wb.SheetNames.find(n => /내역/.test(n)) ?? wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    const cell = (r: unknown[], i: number) => String(r[i] ?? '').trim();
    const key = section.replace(/\s/g, '');
    // 같은 제목이 요약표·본문에 여러 번 나온다 — 항목 행이 가장 많은 곳을 쓴다.
    const linesFrom = (startIdx: number): BoqLine[] => {
      const head = /^(\d+(?:-\d+)*)\./.exec(cell(rows[startIdx], 0))?.[1];
      const depth = head ? head.split('-').length : 0;
      const lines: BoqLine[] = [];
      for (let i = startIdx + 1; i < rows.length; i++) {
        const r = rows[i], c0 = cell(r, 0);
        const h = /^(\d+(?:-\d+)*)\.\s/.exec(c0)?.[1];
        if (h && depth && h.split('-').length <= depth && h !== head) break;
        const unit = cell(r, 3), qty = Number(r[2]);
        if (!unit || !Number.isFinite(qty) || qty <= 0 || unit === '식') continue;
        const amount = Number(r[11]);
        lines.push({ id: String(i + 1), name: c0, spec: cell(r, 1), unit, qty, amount: Number.isFinite(amount) ? amount : 0 });
      }
      return lines;
    };
    let out: BoqLine[] = [];
    rows.forEach((r, i) => {
      if (!cell(r, 0).replace(/\s/g, '').includes(key)) return;
      const lines = linesFrom(i);
      if (lines.length > out.length) out = lines;
    });
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
