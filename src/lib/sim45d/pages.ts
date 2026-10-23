// PDF 쪽 글 다루기(순수 함수) — 브라우저(docText)와 서버(AI 연결 MCP)가 같이 쓴다.

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
export function pageLines(items: { str: string; transform: number[] }[]): string {
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
