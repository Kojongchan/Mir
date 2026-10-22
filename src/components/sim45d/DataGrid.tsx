import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * 엑셀형 표 — 공정·공사비 화면의 내역·물량·연결 탭이 함께 쓴다. 고정 행 높이로 보이는 행만 그려서
 * 내역서 수천 줄도 가볍고, 머리줄·합계줄은 위아래에, 앞쪽 열은 왼쪽에 고정된다. 묶음(공종 등)마다
 * 소계, 머리 클릭 정렬, 행 클릭 선택(Ctrl/Shift 로 여러 개), 엑셀 내보내기.
 */
export type CellKind = 'text' | 'int' | 'num' | 'won' | 'pct' | 'date';

export interface GridColumn<T> {
  key: string;
  label: string;
  width: number;
  kind?: CellKind;
  value: (row: T) => string | number | null;
  /** 합계·소계를 낼 열. */
  sum?: boolean;
  /** 표시만 바꿀 때(정렬·합계·내보내기는 value 기준). */
  render?: (row: T) => ReactNode;
  title?: string;
}

const ROW_H = 28;
const OVERSCAN = 12;

export function formatCell(v: string | number | null, kind: CellKind = 'text'): string {
  if (v === null || v === '') return '';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '';
  switch (kind) {
    case 'int': case 'won': return Math.round(v).toLocaleString('ko-KR');
    case 'num': return v.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
    case 'pct': return `${(v * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;
    default: return String(v);
  }
}

type Line<T> = { type: 'group'; label: string; count: number; sums: Map<string, number>; collapsed: boolean } | { type: 'row'; row: T; key: string };

export function DataGrid<T>({
  columns, rows, rowKey, groupBy, frozen = 1, selected, onRowClick, empty, footerLabel = '합계',
}: {
  columns: GridColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  groupBy?: (row: T) => string;
  frozen?: number;
  selected?: ReadonlySet<string>;
  onRowClick?: (row: T, additive: boolean) => void;
  empty?: ReactNode;
  footerLabel?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 보이는 높이(도크 높이를 바꾸면 따라감) — 그릴 행 범위를 정한다.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);

  const template = columns.map(c => `${c.width}px`).join(' ');
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = 0;
    for (const c of columns) { out.push(x); x += c.width; }
    return out;
  }, [columns]);
  const sumCols = columns.filter(c => c.sum);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    return [...rows].sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      if (x === y) return 0;
      if (x === null || x === '') return 1;
      if (y === null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko')) * sort.dir;
    });
  }, [rows, columns, sort]);

  const lines = useMemo<Line<T>[]>(() => {
    if (!groupBy) return sorted.map(row => ({ type: 'row', row, key: rowKey(row) }));
    const groups = new Map<string, T[]>();
    for (const r of sorted) {
      const g = groupBy(r);
      const list = groups.get(g);
      if (list) list.push(r); else groups.set(g, [r]);
    }
    const out: Line<T>[] = [];
    for (const [label, list] of groups) {
      const sums = new Map<string, number>();
      for (const c of sumCols) sums.set(c.key, list.reduce((s, r) => s + num(c.value(r)), 0));
      const isCollapsed = collapsed.has(label);
      out.push({ type: 'group', label, count: list.length, sums, collapsed: isCollapsed });
      if (!isCollapsed) for (const row of list) out.push({ type: 'row', row, key: rowKey(row) });
    }
    return out;
  }, [sorted, groupBy, rowKey, collapsed, sumCols]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of sumCols) m.set(c.key, rows.reduce((s, r) => s + num(c.value(r)), 0));
    return m;
  }, [rows, sumCols]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  const stick = (i: number) => (i < frozen ? { position: 'sticky' as const, left: lefts[i], zIndex: 1 } : undefined);
  const cellClass = (c: GridColumn<T>, i: number) =>
    `dgrid__cell${c.kind && c.kind !== 'text' && c.kind !== 'date' ? ' is-num tabular' : ''}${i < frozen ? ' is-frozen' : ''}${i === frozen - 1 ? ' is-frozen-last' : ''}`;

  if (!rows.length && empty) return <div className="dgrid dgrid--empty">{empty}</div>;

  return (
    <div className="dgrid" ref={bodyRef} role="grid" aria-rowcount={lines.length}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="dgrid__head" style={{ gridTemplateColumns: template }} role="row">
        {columns.map((c, i) => (
          <button key={c.key} type="button" role="columnheader" className={cellClass(c, i)} style={stick(i)} title={c.title ?? c.label}
            aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            onClick={() => setSort(s => (s?.key !== c.key ? { key: c.key, dir: 1 } : s.dir === 1 ? { key: c.key, dir: -1 } : null))}>
            {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>
      <div className="dgrid__body" style={{ height: lines.length * ROW_H }}>
        {lines.slice(first, last).map((line, k) => {
          const top = (first + k) * ROW_H;
          if (line.type === 'group') {
            return (
              <div key={`g:${line.label}`} className="dgrid__row dgrid__row--group" style={{ top, gridTemplateColumns: template }} role="row"
                onClick={() => setCollapsed(prev => toggle(prev, line.label))}>
                {columns.map((c, i) => (
                  <div key={c.key} className={cellClass(c, i)} style={stick(i)}>
                    {i === 0 ? <span className="dgrid__group-label">{line.collapsed ? '▸' : '▾'} {line.label} <span className="muted">({line.count})</span></span>
                      : c.sum ? formatCell(line.sums.get(c.key) ?? 0, c.kind) : ''}
                  </div>
                ))}
              </div>
            );
          }
          const isSel = selected?.has(line.key);
          return (
            <div key={line.key} className={`dgrid__row${isSel ? ' is-selected' : ''}`} style={{ top, gridTemplateColumns: template }} role="row"
              aria-selected={isSel || undefined} onClick={e => onRowClick?.(line.row, e.ctrlKey || e.metaKey || e.shiftKey)}>
              {columns.map((c, i) => (
                <div key={c.key} className={cellClass(c, i)} style={stick(i)} role="gridcell">
                  {c.render ? c.render(line.row) : formatCell(c.value(line.row), c.kind)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {sumCols.length > 0 && (
        <div className="dgrid__foot" style={{ gridTemplateColumns: template }} role="row">
          {columns.map((c, i) => (
            <div key={c.key} className={cellClass(c, i)} style={stick(i)}>
              {i === 0 ? `${footerLabel} (${rows.length.toLocaleString()})` : c.sum ? formatCell(totals.get(c.key) ?? 0, c.kind) : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function num(v: string | number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toggle(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** 표 그대로 엑셀로(묶음·정렬과 무관하게 모든 행, 숫자는 숫자 칸). */
export async function exportGridXlsx<T>(filename: string, sheet: string, columns: GridColumn<T>[], rows: T[]): Promise<void> {
  const XLSX = await import('xlsx');
  const aoa: (string | number)[][] = [columns.map(c => c.label)];
  for (const r of rows) aoa.push(columns.map(c => c.value(r) ?? ''));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(c => ({ wpx: c.width }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, filename);
}
