// 산출내역서 시트 행 → 구간(번호 제목)·항목 행. 화면·파일 읽기와 분리(테스트용) — 읽기는 docText.accBoqSheet.

export interface BoqLine {
  id: string;
  name: string;
  spec: string;
  unit: string;
  qty: number;
  amount: number;
}

const cell = (r: unknown[] | undefined, i: number) => String(r?.[i] ?? '').trim();
const HEAD = /^(\d+(?:-\d+)*)\.\s/;

/**
 * 제목 행(예 '2-1. 연제교')부터 같은 깊이의 다음 제목 전까지의 항목 행.
 * 열: 공종명·규격·수량·단위 … 합계 금액(12번째 칸). 단위가 있고 수량이 있는 행만('식' 묶음 행 제외).
 */
function linesFrom(rows: unknown[][], startIdx: number): BoqLine[] {
  const head = /^(\d+(?:-\d+)*)\./.exec(cell(rows[startIdx], 0))?.[1];
  const depth = head ? head.split('-').length : 0;
  const lines: BoqLine[] = [];
  for (let i = startIdx + 1; i < rows.length; i++) {
    const r = rows[i], c0 = cell(r, 0);
    const h = HEAD.exec(c0)?.[1];
    if (h && depth && h.split('-').length <= depth && h !== head) break;
    const unit = cell(r, 3), qty = Number(r[2]);
    if (!unit || !Number.isFinite(qty) || qty <= 0 || unit === '식') continue;
    const amount = Number(r[11]);
    lines.push({ id: String(i + 1), name: c0, spec: cell(r, 1), unit, qty, amount: Number.isFinite(amount) ? amount : 0 });
  }
  return lines;
}

/** section 제목의 항목 행. 같은 제목이 요약표·본문에 여러 번 나온다 — 항목 행이 가장 많은 곳을 쓴다. */
export function boqLines(rows: unknown[][], section: string): BoqLine[] {
  const key = section.replace(/\s/g, '');
  let out: BoqLine[] = [];
  rows.forEach((r, i) => {
    if (!cell(r, 0).replace(/\s/g, '').includes(key)) return;
    const lines = linesFrom(rows, i);
    if (lines.length > out.length) out = lines;
  });
  return out;
}

/** 내역서의 번호 제목(예 '2-1. 연제교')과 항목 수 — 항목이 있는 것만, 같은 제목은 많은 쪽 하나. */
export function boqSections(rows: unknown[][]): { title: string; lines: number }[] {
  const best = new Map<string, number>();
  rows.forEach((r, i) => {
    const title = cell(r, 0).replace(/\s+/g, ' ');
    if (!HEAD.test(title)) return;
    const n = linesFrom(rows, i).length;
    if (n > (best.get(title) ?? 0)) best.set(title, n);
  });
  return [...best].map(([title, lines]) => ({ title, lines }));
}

/** 대상 이름(예 '연제교 상선')에 맞는 제목 — 상·하선 표기를 뺀 이름이 든 제목 중 항목이 가장 많은 것. */
export function guessBoqSection(sections: { title: string; lines: number }[], structure: string): string | null {
  const base = structure.replace(/\(.*?\)|상선|하선|상행|하행/g, '').replace(/\s/g, '');
  if (!base) return null;
  const hits = sections.filter(s => s.title.replace(/\s/g, '').includes(base));
  return hits.length ? hits.reduce((a, b) => (b.lines > a.lines ? b : a)).title : null;
}
