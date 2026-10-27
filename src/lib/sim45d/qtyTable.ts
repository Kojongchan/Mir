// 수량산출서 '개소별 집계표'를 표로 읽는다(5번 수량분개, 10-27). 집계표는 칸이 비어 있는 행이 많아(예: 교대공만 있는 항목) 글 순서만으로는
// 숫자가 어느 열인지 모른다 — PDF 글 조각의 위치로 정한다. 열 제목은 칸 가운데, 숫자는 칸 오른쪽에 붙어 있으므로 쪽마다
// '숫자 오른쪽 끝 − 왼쪽 가까운 제목 가운데'의 중앙값(칸 폭의 절반쯤)을 구해, 숫자 오른쪽 끝과 (제목 가운데 + 그 값)이 가장 가까운 열로 넣는다.
// 순수 함수 — 서버(AI 연결)와 시험이 같이 쓴다. 쪽 조각: [x, y, 너비, 글](pt, 왼쪽 아래 원점, pdf.js getTextContent).

export type Cell = [number, number, number, string];

export interface SheetRow {
  page: number;
  /** 위 제목들(예 ['2-1 연제교', '2-1-3 교각공', '2-1-3-1 콘크리트타설']). */
  path: string[];
  name: string;
  spec: string;
  unit: string;
  /** 열 이름 → 값(빈 칸·'-'는 없음). 열 이름은 제목 글에서 띄어쓰기를 뺀 것(예 '교각공(상선)', '사재교·하로교'). */
  cols: Record<string, number>;
}

const NUM = /^-?[\d,]+(?:\.\d+)?$/;
const LEFT = /^(공종|규격|단위|비고)$/;
const HEADING = /^(\d+(?:-\d+)+|\d+\))\s*\S/;
const norm = (s: string) => s.replace(/\s+/g, '');
const center = (c: Cell) => c[0] + c[2] / 2;
const right = (c: Cell) => c[0] + c[2];

/** 같은 줄(세로 2.5pt 안)끼리, 위에서 아래로. */
function lines(cells: Cell[]): Cell[][] {
  const sorted = [...cells].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out: Cell[][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0][1] - c[1]) <= 2.5) last.push(c); else out.push([c]);
  }
  for (const l of out) l.sort((a, b) => a[0] - b[0]);
  return out;
}

interface Layout { columns: { name: string; x: number }[]; left: { name: number; spec: number; unit: number; note: number | null }; offset: number; top: number }

/**
 * 쪽의 열: 첫 숫자 줄보다 위의 글 중 아래에 다른 제목이 없는 것(묶음 제목 '연 제 교'·'구 조 물 공'·표 이름은 아래에 제목이 있다).
 * 세로로 겹친 두 글(예 '사재교' / '하로교')은 한 열 제목으로 합친다. 공종·규격·단위·비고는 글 열 위치로.
 */
function layout(rows: Cell[][]): Layout | null {
  // 본문 첫 줄: 숫자가 있거나(쪽 오른쪽 절반) 맨 앞 글이 제목('2-1-4 상부공', '3) 말뚝두부보강')인 줄 — 그 위가 머리
  const firstData = rows.findIndex(l => l.some(c => NUM.test(c[3].trim()) && c[0] > 400) || HEADING.test(l[0][3].trim()));
  if (firstData < 1) return null;
  const head = rows.slice(0, firstData).flat();
  const top = rows[firstData][0][1];
  // 묶음 제목은 아래 칸 제목과 20pt 넘게 떨어져 있다(두 줄로 쓴 한 제목 '사재교'/'하로교'는 12pt 남짓)
  const below = (c: Cell) => head.some(d => d !== c && d[1] < c[1] - 20 && Math.abs(center(d) - center(c)) < Math.max(c[2], d[2]) / 2 + 4);
  const leaves = head.filter(c => !below(c));
  const find = (re: RegExp) => leaves.find(c => re.test(norm(c[3])));
  const name = find(/^공종$/) ?? find(/^(공|종)$/), spec = find(/^규격$/), unit = find(/^단위$/);
  if (!name || !spec || !unit) return null;
  // '공'·'종'이 따로 있으면 둘의 가운데
  const gong = leaves.filter(c => /^(공|종)$/.test(norm(c[3])));
  const nameX = gong.length === 2 ? (center(gong[0]) + center(gong[1])) / 2 : center(name);
  const note = find(/^비고$/);
  const cols: { name: string; x: number; y: number }[] = [];
  for (const c of leaves) {
    const t = norm(c[3]);
    if (LEFT.test(t) || /^(공|종)$/.test(t) || center(c) <= center(unit) + 10) continue;
    const same = cols.find(k => Math.abs(k.x - center(c)) < 6 && Math.abs(k.y - c[1]) < 16);
    if (same) { same.name = same.y > c[1] ? `${same.name}·${t}` : `${t}·${same.name}`; same.y = Math.max(same.y, c[1]); continue; }
    cols.push({ name: t, x: center(c), y: c[1] });
  }
  cols.sort((a, b) => a.x - b.x);
  if (!cols.length) return null;
  // 숫자 오른쪽 끝 − 왼쪽 가까운 제목 가운데: 칸마다 같다(제목 가운데, 숫자 오른쪽 맞춤)
  const gaps: number[] = [];
  for (const l of rows.slice(firstData)) {
    for (const c of l) {
      if (!NUM.test(c[3].trim()) || center(c) <= center(unit) + 10) continue;
      const r = right(c), left = cols.filter(k => k.x <= r);
      if (left.length) gaps.push(r - left[left.length - 1].x);
    }
  }
  gaps.sort((a, b) => a - b);
  const offset = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return { columns: cols.map(k => ({ name: k.name, x: k.x })), left: { name: nameX, spec: center(spec), unit: center(unit), note: note ? center(note) : null }, offset, top };
}

const value = (s: string) => Number(s.replace(/,/g, ''));

/**
 * 집계표 쪽들 → 항목 행. 제목 줄('2-1-3 교각공', '1) 콘크리트타설')은 경로로, 이어지는 쪽은 앞 쪽 경로를 잇는다.
 * 열이 없는 쪽(표지·목차)은 건너뛴다. 단위가 없는 줄은 항목이 아니다.
 */
export function parseSheetPages(pages: { page: number; cells: Cell[] }[]): SheetRow[] {
  const out: SheetRow[] = [];
  let path: { level: number; text: string }[] = [];
  for (const p of pages) {
    const rows = lines(p.cells);
    const lay = layout(rows);
    if (!lay) continue;
    const { left, columns, offset } = lay;
    const firstCol = columns[0].x - 10;
    for (const l of rows) {
      if (l[0][1] > lay.top + 0.1) continue; // 머리줄
      const texts: { part: 'name' | 'spec' | 'unit' | 'note'; s: string }[] = [], nums: { col: string; v: number }[] = [];
      for (const c of l) {
        const s = c[3].trim();
        if (!s) continue;
        if ((NUM.test(s) || s === '-') && right(c) > firstCol) {
          if (s === '-') continue;
          const r = right(c);
          const col = columns.reduce((b, k) => (Math.abs(k.x + offset - r) < Math.abs(b.x + offset - r) ? k : b));
          nums.push({ col: col.name, v: value(s) });
          continue;
        }
        const x = center(c);
        const cand: [typeof texts[number]['part'], number][] = [['name', left.name], ['spec', left.spec], ['unit', left.unit]];
        if (left.note !== null) cand.push(['note', left.note]);
        // 이름은 왼쪽 정렬(긴 이름의 가운데가 규격 쪽으로 감) — 왼쪽 끝이 규격 열보다 왼쪽이면서 넓게 걸치면 이름
        const part = c[0] < left.name + 40 && x < left.spec - 20 ? 'name' : cand.reduce((b, k) => (Math.abs(k[1] - x) < Math.abs(b[1] - x) ? k : b))[0];
        texts.push({ part, s });
      }
      const nameText = texts.filter(t => t.part === 'name').map(t => t.s).join(' ');
      const unit = texts.filter(t => t.part === 'unit').map(t => t.s).join('');
      if (!unit && !nums.length && HEADING.test(nameText)) {
        const m = /^(\d+(?:-\d+)+)/.exec(nameText);
        const level = m ? m[1].split('-').length : 99;
        path = [...path.filter(h => h.level < level), { level, text: nameText.replace(/\s+/g, ' ') }];
        continue;
      }
      if (!unit || !nums.length) continue;
      const cols: Record<string, number> = {};
      for (const n of nums) cols[n.col] = (cols[n.col] ?? 0) + n.v;
      out.push({ page: p.page, path: path.map(h => h.text), name: nameText, spec: texts.filter(t => t.part === 'spec').map(t => t.s).join(' '), unit, cols });
    }
  }
  return out;
}

/** 행 비교 키: 이름·규격·단위에서 띄어쓰기·괄호 안 '표준시장' 같은 꼬리를 빼고. */
export function rowKey(name: string, spec: string, unit: string): string {
  const k = (s: string) => norm(s).replace(/\(표준시장\)/g, '').replace(/[㎥]/g, 'm3').replace(/[㎡]/g, 'm2').replace(/㎜/g, 'mm').toLowerCase();
  return `${k(name)}|${k(spec)}|${k(unit)}`;
}
