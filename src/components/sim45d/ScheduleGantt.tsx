import { useEffect, useMemo, useRef, useState } from 'react';
import type { P6Schedule } from '../../lib/p6/schedule';
import { DAY, phaseAt, type TimedActivity } from '../../lib/sim45d/timeline';
import { formatCell } from './DataGrid';

/**
 * 공정표 탭: 왼쪽 작업 표(WBS 묶음) + 오른쪽 간트. 한 스크롤 안에서 표는 왼쪽에 고정되고 간트만 가로로 움직여
 * 세로 위치가 항상 맞는다(P6·SYNCHRO 와 같은 배치). 막대 색은 기준일 기준(완료·진행·예정), 주공정은 빨간 테두리.
 * 눈금을 누르면 그 날이 기준일. 행을 누르면 그 작업의 객체가 3D 에서 선택된다.
 */
type Zoom = 'day' | 'week' | 'month';
const ZOOM_PX: Record<Zoom, number> = { day: 22, week: 6, month: 1.6 };
const ZOOM_LABEL: Record<Zoom, string> = { day: '일', week: '주', month: '월' };
const ROW_H = 26;
const OVERSCAN = 10;
const COLS = [
  { key: 'code', label: 'Activity ID', width: 112 },
  { key: 'name', label: '작업명', width: 220 },
  { key: 'dur', label: '일수', width: 46, num: true },
  { key: 'start', label: '시작', width: 82 },
  { key: 'finish', label: '종료', width: 82 },
  { key: 'links', label: '연결', width: 50, num: true },
  { key: 'cost', label: '공사비', width: 96, num: true },
] as const;
const GRID_W = COLS.reduce((s, c) => s + c.width, 0);

type Row =
  | { type: 'wbs'; id: string; name: string; depth: number; start: number; end: number; collapsed: boolean; cost: number }
  | { type: 'act'; code: string; name: string; depth: number; act: TimedActivity | undefined; dur: number; start: string; finish: string; critical: boolean };

export function ScheduleGantt({ schedule, acts, range, time, onTime, selected, onSelect, linkCount, cost }: {
  schedule: P6Schedule;
  acts: ReadonlyMap<string, TimedActivity>;
  range: { start: number; end: number };
  time: number;
  onTime: (t: number) => void;
  selected: ReadonlySet<string>;
  onSelect: (code: string, additive: boolean) => void;
  linkCount?: ReadonlyMap<string, number>;
  cost?: ReadonlyMap<string, number>;
}) {
  const [zoom, setZoom] = useState<Zoom>(() => pickZoom(range));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ppd = ZOOM_PX[zoom];
  const days = Math.max(1, Math.ceil((range.end - range.start) / DAY));
  const ganttW = Math.ceil(days * ppd) + 40;
  const xOf = (t: number) => ((t - range.start) / DAY) * ppd;

  const rows = useMemo(() => buildRows(schedule, acts, collapsed, cost), [schedule, acts, collapsed, cost]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const ticks = useMemo(() => scaleTicks(range, zoom), [range, zoom]);

  // 기준일이 화면 밖으로 나가면 따라간다(재생 중).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = GRID_W + xOf(time);
    const viewW = el.clientWidth - GRID_W;
    if (x < el.scrollLeft + GRID_W + 20 || x > el.scrollLeft + GRID_W + viewW - 20) el.scrollLeft = Math.max(0, x - GRID_W - viewW / 3);
    // xOf 는 range·ppd 로 정해지므로 의존성에 둘만으로 충분
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, ppd, range.start]);

  const pickTime = (clientX: number, el: HTMLElement) => {
    const x = clientX - el.getBoundingClientRect().left;
    onTime(Math.min(range.end, Math.max(range.start, range.start + (x / ppd) * DAY)));
  };

  return (
    <div className="sgantt">
      <div className="sgantt__tools">
        <span className="muted">눈금</span>
        <div className="sim-seg" role="group" aria-label="간트 눈금">
          {(Object.keys(ZOOM_PX) as Zoom[]).map(z => (
            <button key={z} type="button" className={zoom === z ? 'is-active' : ''} aria-pressed={zoom === z} onClick={() => setZoom(z)}>{ZOOM_LABEL[z]}</button>
          ))}
        </div>
        <span className="sgantt__legend">
          <i className="sgantt__key sgantt__key--done" />완료 <i className="sgantt__key sgantt__key--active" />진행
          <i className="sgantt__key sgantt__key--future" />예정 <i className="sgantt__key sgantt__key--critical" />주공정
        </span>
        <div className="spacer" />
        <span className="muted tabular">작업 {schedule.activities.length.toLocaleString()}개 · WBS {schedule.wbs.length.toLocaleString()}개</span>
      </div>
      <div className="sgantt__scroll" ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="sgantt__inner" style={{ width: GRID_W + ganttW }}>
          <div className="sgantt__head">
            <div className="sgantt__grid-head" style={{ width: GRID_W }}>
              {COLS.map(c => <div key={c.key} className={`sgantt__th${'num' in c ? ' is-num' : ''}`} style={{ width: c.width }}>{c.label}</div>)}
            </div>
            <div className="sgantt__scale" style={{ width: ganttW }} onClick={e => pickTime(e.clientX, e.currentTarget)} title="눌러서 기준일 옮기기">
              {ticks.major.map(t => <span key={`M${t.t}`} className="sgantt__major" style={{ left: xOf(t.t) }}>{t.label}</span>)}
              {ticks.minor.map(t => <span key={`m${t.t}`} className="sgantt__minor" style={{ left: xOf(t.t) }}>{t.label}</span>)}
              <i className="sgantt__now-head" style={{ left: xOf(time) }} />
            </div>
          </div>
          <div className="sgantt__body" style={{ height: rows.length * ROW_H }}>
            {rows.slice(first, last).map((r, k) => {
              const top = (first + k) * ROW_H;
              if (r.type === 'wbs') {
                return (
                  <div key={`w:${r.id}`} className="sgantt__row sgantt__row--wbs" style={{ top }}>
                    <div className="sgantt__cells" style={{ width: GRID_W }} onClick={() => setCollapsed(prev => toggle(prev, r.id))}>
                      <div className="sgantt__td sgantt__td--wbs" style={{ width: COLS[0].width + COLS[1].width, paddingLeft: 6 + r.depth * 14 }}>
                        {r.collapsed ? '▸' : '▾'} {r.name}
                      </div>
                      <div className="sgantt__td is-num tabular" style={{ width: COLS[2].width }}>{Math.max(0, Math.round((r.end - r.start) / DAY))}</div>
                      <div className="sgantt__td tabular" style={{ width: COLS[3].width }}>{fmtDay(r.start)}</div>
                      <div className="sgantt__td tabular" style={{ width: COLS[4].width }}>{fmtDay(r.end)}</div>
                      <div className="sgantt__td" style={{ width: COLS[5].width }} />
                      <div className="sgantt__td is-num tabular" style={{ width: COLS[6].width }}>{r.cost ? formatCell(r.cost, 'won') : ''}</div>
                    </div>
                    {Number.isFinite(r.start) && <i className="sgantt__wbsbar" style={{ left: GRID_W + xOf(r.start), width: Math.max(2, xOf(r.end) - xOf(r.start)) }} />}
                  </div>
                );
              }
              const a = r.act;
              const phase = a ? phaseAt(a, time) : 'future';
              const isSel = selected.has(r.code);
              return (
                <div key={r.code} className={`sgantt__row${isSel ? ' is-selected' : ''}`} style={{ top }}
                  onClick={e => onSelect(r.code, e.ctrlKey || e.metaKey || e.shiftKey)} aria-selected={isSel || undefined}>
                  <div className="sgantt__cells" style={{ width: GRID_W }}>
                    <div className="sgantt__td tabular" style={{ width: COLS[0].width }} title={r.code}>{r.code}</div>
                    <div className="sgantt__td" style={{ width: COLS[1].width, paddingLeft: 6 + r.depth * 14 }} title={r.name}>{r.name}</div>
                    <div className="sgantt__td is-num tabular" style={{ width: COLS[2].width }}>{r.dur}</div>
                    <div className="sgantt__td tabular" style={{ width: COLS[3].width }}>{r.start}</div>
                    <div className="sgantt__td tabular" style={{ width: COLS[4].width }}>{r.finish}</div>
                    <div className="sgantt__td is-num tabular" style={{ width: COLS[5].width }}>{linkCount?.get(r.code) ?? ''}</div>
                    <div className="sgantt__td is-num tabular" style={{ width: COLS[6].width }}>{cost?.has(r.code) ? formatCell(cost.get(r.code)!, 'won') : ''}</div>
                  </div>
                  {a && (a.milestone
                    ? <i className={`sgantt__ms is-${phase}`} style={{ left: GRID_W + xOf(a.start) - 6 }} title={`${r.name} ${r.start}`} />
                    : <i className={`sgantt__bar is-${phase}${r.critical ? ' is-critical' : ''}`}
                      style={{ left: GRID_W + xOf(a.start), width: Math.max(3, xOf(a.end) - xOf(a.start)) }} title={`${r.name}\n${r.start} ~ ${r.finish} (${r.dur}일)`} />)}
                </div>
              );
            })}
            <i className="sgantt__now" style={{ left: GRID_W + xOf(time) }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** WBS 트리 순서로 묶음 행과 작업 행을 펼친다(접힌 묶음 아래는 생략). */
function buildRows(s: P6Schedule, acts: ReadonlyMap<string, TimedActivity>, collapsed: ReadonlySet<string>, cost?: ReadonlyMap<string, number>): Row[] {
  const wbsById = new Map(s.wbs.map(w => [w.id, w]));
  const children = new Map<string | null, typeof s.wbs>();
  for (const w of s.wbs) {
    if (!w.path) continue; // 프로젝트 노드
    const parent = w.parentId && wbsById.get(w.parentId)?.path ? w.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(w);
    children.set(parent, list);
  }
  const actsByWbs = new Map<string, typeof s.activities>();
  const root: typeof s.activities = [];
  for (const a of s.activities) {
    const w = wbsById.get(a.wbsId);
    if (!w || !w.path) { root.push(a); continue; }
    const list = actsByWbs.get(a.wbsId) ?? [];
    list.push(a);
    actsByWbs.set(a.wbsId, list);
  }
  const byStart = (x: (typeof s.activities)[number], y: (typeof s.activities)[number]) => (x.start ?? '').localeCompare(y.start ?? '') || x.code.localeCompare(y.code);
  const actRow = (a: (typeof s.activities)[number], depth: number): Row => ({
    type: 'act', code: a.code, name: a.name, depth, act: acts.get(a.code), dur: a.durationDays,
    start: (a.start ?? '').slice(0, 10), finish: (a.finish ?? '').slice(0, 10), critical: a.totalFloatDays !== null && a.totalFloatDays <= 0,
  });

  const out: Row[] = [];
  // 묶음의 기간·공사비(하위 전체)를 먼저 모은다.
  const span = (wbsId: string): { start: number; end: number; cost: number } => {
    let start = Infinity, end = -Infinity, c = 0;
    for (const a of actsByWbs.get(wbsId) ?? []) {
      const t = acts.get(a.code);
      if (t) { start = Math.min(start, t.start); end = Math.max(end, t.end); }
      c += cost?.get(a.code) ?? 0;
    }
    for (const w of children.get(wbsId) ?? []) {
      const sub = span(w.id);
      start = Math.min(start, sub.start); end = Math.max(end, sub.end); c += sub.cost;
    }
    return { start, end, cost: c };
  };
  const walk = (parent: string | null, depth: number) => {
    for (const w of children.get(parent) ?? []) {
      const sp = span(w.id);
      const isCollapsed = collapsed.has(w.id);
      out.push({ type: 'wbs', id: w.id, name: `${w.code} ${w.name}`, depth, start: sp.start, end: sp.end, collapsed: isCollapsed, cost: sp.cost });
      if (isCollapsed) continue;
      // 이 WBS 의 작업(착공·준공 같은 마일스톤 포함)을 먼저, 하위 WBS 는 그 뒤에.
      for (const a of [...(actsByWbs.get(w.id) ?? [])].sort(byStart)) out.push(actRow(a, depth + 1));
      walk(w.id, depth + 1);
    }
  };
  for (const a of [...root].sort(byStart)) out.push(actRow(a, 0));
  walk(null, 0);
  return out;
}

function pickZoom(range: { start: number; end: number }): Zoom {
  const days = (range.end - range.start) / DAY;
  return days <= 120 ? 'day' : days <= 900 ? 'week' : 'month';
}

/** 눈금: 위(월/연)와 아래(일/주/월). */
function scaleTicks(range: { start: number; end: number }, zoom: Zoom) {
  const major: { t: number; label: string }[] = [];
  const minor: { t: number; label: string }[] = [];
  const d = new Date(range.start);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  for (let m = new Date(d); m.getTime() <= range.end; m.setMonth(m.getMonth() + 1)) {
    const t = Math.max(m.getTime(), range.start);
    if (zoom === 'month') {
      if (m.getMonth() === 0 || major.length === 0) major.push({ t, label: `${m.getFullYear()}` });
      minor.push({ t, label: `${m.getMonth() + 1}` });
    } else {
      major.push({ t, label: `${m.getFullYear()}.${String(m.getMonth() + 1).padStart(2, '0')}` });
    }
  }
  if (zoom !== 'month') {
    const s = new Date(range.start); s.setHours(0, 0, 0, 0);
    for (let x = new Date(s); x.getTime() <= range.end; x.setDate(x.getDate() + 1)) {
      if (zoom === 'day' || x.getDay() === 1) minor.push({ t: x.getTime(), label: String(x.getDate()) });
    }
  }
  return { major, minor };
}

function fmtDay(t: number): string {
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toggle(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}
