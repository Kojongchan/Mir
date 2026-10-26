import { useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '../EmptyState';
import { UiIcon } from '../icons/UiIcon';
import { DataGrid, exportGridXlsx, type GridColumn } from './DataGrid';
import { ScheduleGantt } from './ScheduleGantt';
import { ProgressChart, fmtDay, won } from './ProgressChart';
import { PLAY_SPEED_LABEL, type PlaySpeed, type Sim45d } from './useSim45d';
import { DAY, progressAt } from '../../lib/sim45d/timeline';
import { QTY_CLASS_LABEL, QTY_TOLERANCE, qtyVariance, type BoqLine, type QtyRow } from '../../lib/sim45d/types';

/**
 * 공정·공사비(4D/5D) 하단 도크 — 3D 아래에 붙는 탭 패널(Navisworks TimeLiner·SYNCHRO 의 하단 간트 배치).
 * 위: 재생 줄(기준일 슬라이더 — 3D·간트·차트가 같은 날을 봄). 아래: 탭(공정표·차트·5D 내역·물량·연결 현황).
 * 윗변을 끌어 높이를 바꾸고, 접으면 재생 줄만 남는다. 높이·탭은 이 브라우저에 기억.
 */
type Tab = 'schedule' | 'chart' | 'boq' | 'qty' | 'links';
const TABS: { key: Tab; label: string }[] = [
  { key: 'schedule', label: '공정표' },
  { key: 'chart', label: '차트' },
  { key: 'boq', label: '5D 내역' },
  { key: 'qty', label: '물량' },
  { key: 'links', label: '연결 현황' },
];
const TAB_KEY = 'mir.sim45d.tab', HEIGHT_KEY = 'mir.sim45d.height';
const MIN_H = 180;

const stored = <T,>(key: string, fallback: T, ok: (v: string) => boolean, map: (v: string) => T): T => {
  try { const v = localStorage.getItem(key); return v !== null && ok(v) ? map(v) : fallback; } catch { return fallback; }
};
const remember = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* 비공개 창 */ } };

export function Sim45dDock({ sim, onOpenXer, objectCount, onSelectActivity }: {
  sim: Sim45d;
  onOpenXer: () => void;
  /** 3D 에서 선택한 객체 수(연결 현황 안내용). */
  objectCount: number;
  /** 작업 선택(페이지가 3D 선택까지 맞춤). 없으면 도크 안에서만 선택. */
  onSelectActivity?: (code: string, additive: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>(() => stored(TAB_KEY, 'schedule', v => TABS.some(t => t.key === v), v => v as Tab));
  const [height, setHeight] = useState(() => stored(HEIGHT_KEY, 340, v => Number(v) >= MIN_H, Number));
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ y: number; h: number } | null>(null);

  const s = sim.schedule;
  const range = sim.range;
  const progress = useMemo(() => (range ? progressAt(sim.acts, sim.time, sim.cost.size ? sim.cost : undefined) : null), [sim.acts, sim.time, sim.cost, range]);
  const linkCount = useMemo(() => new Map([...sim.links].map(([k, v]) => [k, v.length])), [sim.links]);

  const pickTab = (t: Tab) => { setTab(t); remember(TAB_KEY, t); if (collapsed) setCollapsed(false); };
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, h: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const max = Math.max(MIN_H, window.innerHeight - 220);
    setHeight(Math.min(max, Math.max(MIN_H, drag.current.h + drag.current.y - e.clientY)));
    if (collapsed) setCollapsed(false);
  };
  const onResizeUp = () => { if (drag.current) remember(HEIGHT_KEY, String(height)); drag.current = null; };

  const style = maximized ? undefined : collapsed ? undefined : { height };
  const cls = `sim-dock${collapsed ? ' is-collapsed' : ''}${maximized ? ' is-maximized' : ''}`;

  return (
    <section className={cls} style={style} aria-label="공정·공사비 패널">
      {!maximized && <div className="sim-dock__resize" role="separator" aria-orientation="horizontal" aria-label="패널 높이 조절"
        onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onDoubleClick={() => setCollapsed(c => !c)} />}

      {/* 재생 줄 — 접어도 남는다 */}
      <div className="sim-play">
        <button type="button" className="btn btn--sm ic-only" disabled={!range} onClick={() => range && sim.setTime(range.start)} title="처음으로" aria-label="처음으로">⏮</button>
        <button type="button" className="btn btn--sm btn--primary sim-play__toggle" disabled={!range} onClick={() => {
          if (!range) return;
          if (!sim.playing && sim.time >= range.end) sim.setTime(range.start);
          sim.setPlaying(!sim.playing);
        }} aria-label={sim.playing ? '멈춤' : '재생'}>{sim.playing ? '❚❚' : '▶'}</button>
        <button type="button" className="btn btn--sm ic-only" disabled={!range} onClick={() => range && sim.setTime(range.end)} title="끝으로" aria-label="끝으로">⏭</button>
        <select className="sim-play__speed" value={sim.speed} disabled={!range} onChange={e => sim.setSpeed(Number(e.target.value) as PlaySpeed)} aria-label="재생 속도">
          {(Object.keys(PLAY_SPEED_LABEL) as unknown as PlaySpeed[]).map(v => <option key={v} value={v}>{PLAY_SPEED_LABEL[v]}</option>)}
        </select>
        <input className="sim-play__slider" type="range" disabled={!range} min={range?.start ?? 0} max={range?.end ?? 1} step={DAY}
          value={range ? Math.min(Math.max(sim.time, range.start), range.end) : 0} onChange={e => sim.setTime(Number(e.target.value))} aria-label="기준일" />
        <span className="sim-play__date tabular">{range ? fmtDay(sim.time) : '—'}</span>
        {range && <span className="muted tabular sim-play__dday">D+{Math.max(0, Math.floor((sim.time - range.start) / DAY))}</span>}
        <span className="sim-play__sep" />
        <label className="sim-play__check" title="3D 객체를 기준일의 시공 상태로 칠합니다(연결된 객체만)">
          <input type="checkbox" checked={sim.fourD} onChange={e => sim.setFourD(e.target.checked)} /> 4D 표시
        </label>
        <label className="sim-play__check" title="아직 시작하지 않은 작업의 객체: 숨김 또는 회색">
          <input type="checkbox" checked={sim.hideFuture} disabled={!sim.fourD} onChange={e => sim.setHideFuture(e.target.checked)} /> 미시공 숨김
        </label>
      </div>

      {/* 탭 줄 */}
      <div className="sim-dock__tabs" role="tablist" aria-label="공정·공사비 보기">
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`sim-dock__tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => pickTab(t.key)}>
            {t.label}
            {t.key === 'schedule' && s && <span className="sim-dock__count tabular">{s.activities.length}</span>}
            {t.key === 'boq' && sim.boq.length > 0 && <span className="sim-dock__count tabular">{sim.boq.length}</span>}
            {t.key === 'qty' && sim.qty.length > 0 && <span className="sim-dock__count tabular">{sim.qty.length}</span>}
          </button>
        ))}
        <div className="spacer" />
        {progress && (
          <span className="sim-dock__kpi tabular" title="기준일의 계획 공정률 · 진행 중 작업 · 완료 작업">
            계획 공정률 <strong>{(progress.progress * 100).toFixed(1)}%</strong>
            <span className="muted"> · 진행 {progress.activeCount} · 완료 {progress.doneCount}</span>
            {progress.cost !== null && <span className="muted"> · 누적 공사비 {won(progress.cost)} / {won(progress.costTotal ?? 0)}</span>}
          </span>
        )}
        <button type="button" className="btn btn--sm btn--ghost ic-only" onClick={() => { setMaximized(m => !m); setCollapsed(false); }}
          title={maximized ? '원래 크기' : '크게 보기'} aria-label={maximized ? '원래 크기' : '크게 보기'}>{maximized ? '▾' : '▴'}</button>
        <button type="button" className="btn btn--sm btn--ghost ic-only" onClick={() => { setCollapsed(c => !c); setMaximized(false); }}
          title={collapsed ? '펼치기' : '접기'} aria-label={collapsed ? '펼치기' : '접기'}>{collapsed ? '⌃' : '⌄'}</button>
      </div>

      {!collapsed && (
        <div className="sim-dock__body" role="tabpanel">
          {!s || !range ? (
            <EmptyState icon={<UiIcon name="file-text" size={32} />} title="공정표가 없습니다"
              desc={<>단계 시트(5·6단계)의 「확정 공정표 열기」로 4단계에서 채택한 개략 IPS(또는 올린 P6 공정표)를 열면 공정표·간트·S-curve 가 나타나고,
                연결된 객체가 기준일에 맞춰 3D 에서 칠해집니다. 다른 XER 을 잠깐 볼 때는 아래 버튼으로 엽니다.
                {sim.error && <><br /><span className="sim-error">{sim.error}</span></>}</>}
              cta={<button type="button" className="btn btn--sm" onClick={onOpenXer}>XER 파일 열기</button>} />
          ) : tab === 'schedule' ? (
            <ScheduleGantt schedule={s} acts={sim.actsByCode} range={range} time={sim.time} onTime={sim.setTime}
              selected={sim.selected} onSelect={onSelectActivity ?? sim.selectActivity} linkCount={linkCount} cost={sim.cost} />
          ) : tab === 'chart' ? (
            <ProgressChart acts={sim.acts} range={range} time={sim.time} onTime={sim.setTime} cost={sim.cost} />
          ) : tab === 'boq' ? (
            <BoqTab rows={sim.boq} />
          ) : tab === 'qty' ? (
            <QtyTab rows={sim.qty} />
          ) : (
            <LinksTab sim={sim} objectCount={objectCount} />
          )}
        </div>
      )}
    </section>
  );
}

// --- 5D 내역 ---------------------------------------------------------------

const BOQ_COLUMNS: GridColumn<BoqLine>[] = [
  { key: 'name', label: '품명', width: 200, value: r => r.name },
  { key: 'spec', label: '규격', width: 160, value: r => r.spec },
  { key: 'unit', label: '단위', width: 52, value: r => r.unit },
  { key: 'qty', label: '수량', width: 96, kind: 'num', value: r => r.qty },
  { key: 'unitPrice', label: '단가', width: 104, kind: 'won', value: r => r.unitPrice },
  { key: 'amount', label: '금액', width: 128, kind: 'won', sum: true, value: r => r.amount },
  { key: 'class', label: '수량 분류', width: 84, value: r => (r.qtyClass ? QTY_CLASS_LABEL[r.qtyClass] : '') },
  { key: 'objects', label: '연결 객체', width: 76, kind: 'int', value: r => r.objects?.length ?? 0 },
  { key: 'activity', label: '연결 작업', width: 120, value: r => r.activity ?? '' },
];

function BoqTab({ rows }: { rows: BoqLine[] }) {
  return (
    <TabFrame title="5D 내역" note="공사내역서 항목 ↔ 객체 연결과 객체별 공사비(계약 기준). 금액 = 수량 × 단가(코드 계산)."
      actions={rows.length > 0 && <button type="button" className="btn btn--sm" onClick={() => void exportGridXlsx('5D_내역.xlsx', '5D 내역', BOQ_COLUMNS, rows)}><UiIcon name="download" size={14} /> 엑셀</button>}>
      <DataGrid columns={BOQ_COLUMNS} rows={rows} rowKey={r => r.id} groupBy={r => r.path.join(' › ')} frozen={1}
        empty={<EmptyState compact icon={<UiIcon name="clipboard" size={28} />} title="공사내역서가 아직 연결되지 않았습니다"
          desc="엑셀 공사내역서를 올리면 공종별로 묶여 표시되고, 항목마다 연결 객체·연결 작업·수량 분류(형상 직접·형상 계산·모델 없음·간접비)가 붙습니다." />} />
    </TabFrame>
  );
}

// --- 물량(3D 수량 ↔ 산출서) -------------------------------------------------

const QTY_COLUMNS: GridColumn<QtyRow>[] = [
  { key: 'group', label: '구조물·부위', width: 160, value: r => r.group },
  { key: 'item', label: '항목', width: 180, value: r => r.item },
  { key: 'unit', label: '단위', width: 52, value: r => r.unit },
  { key: 'model', label: '3D 수량', width: 100, kind: 'num', sum: true, value: r => r.modelQty },
  { key: 'sheet', label: '산출서 수량', width: 100, kind: 'num', sum: true, value: r => r.sheetQty },
  { key: 'diff', label: '차이', width: 96, kind: 'num', value: r => (r.modelQty !== null && r.sheetQty !== null ? r.modelQty - r.sheetQty : null) },
  { key: 'ratio', label: '오차', width: 72, kind: 'pct', value: r => qtyVariance(r),
    render: r => { const v = qtyVariance(r); return v === null ? '' : <span className={Math.abs(v) > QTY_TOLERANCE ? 'sim-bad' : ''}>{(v * 100).toFixed(1)}%</span>; } },
  { key: 'key', label: '연결 키', width: 140, value: r => r.key },
  { key: 'objects', label: '객체', width: 60, kind: 'int', value: r => r.objects.length },
];

function QtyTab({ rows }: { rows: QtyRow[] }) {
  const over = rows.filter(r => { const v = qtyVariance(r); return v !== null && Math.abs(v) > QTY_TOLERANCE; }).length;
  return (
    <TabFrame title="물량" note={`3D 수량을 기준으로 수량산출서와 대사합니다. 오차 ±${QTY_TOLERANCE * 100}% 초과 ${over}건은 오차 보고서 대상.`}
      actions={rows.length > 0 && <button type="button" className="btn btn--sm" onClick={() => void exportGridXlsx('물량_대사.xlsx', '물량 대사', QTY_COLUMNS, rows)}><UiIcon name="download" size={14} /> 엑셀</button>}>
      <DataGrid columns={QTY_COLUMNS} rows={rows} rowKey={r => `${r.key}|${r.item}`} groupBy={r => r.group.split(' ')[0]} frozen={2}
        empty={<EmptyState compact icon={<UiIcon name="ruler" size={28} />} title="수량 자료가 아직 없습니다"
          desc="IFC 모델의 객체 수량(체적·면적·길이·개수)과 수량산출서를 연결 키(구조물·부위·STA)로 맞춰 차이와 오차율을 보여줍니다." />} />
    </TabFrame>
  );
}

// --- 연결 현황 -------------------------------------------------------------

function LinksTab({ sim, objectCount }: { sim: Sim45d; objectCount: number }) {
  const acts = sim.schedule?.activities.filter(a => a.taskType !== 'TT_LOE' && a.taskType !== 'TT_WBS' && a.taskType !== 'TT_Mile' && a.taskType !== 'TT_FinMile') ?? [];
  const linkedActs = acts.filter(a => (sim.links.get(a.code)?.length ?? 0) > 0).length;
  const linkedBoq = sim.boq.filter(b => (b.objects?.length ?? 0) > 0).length;
  const objects = [...sim.links.values()].reduce((n, ids) => n + ids.length, 0);
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');
  const info = sim.linkInfo, actuals = sim.actualsInfo;
  return (
    <TabFrame title="연결 현황" note="작업·내역·객체가 얼마나 이어졌는지. 3D 객체는 6단계 연결(요소 IfcGUID)과 모델의 IPS 코드(A3)로 찾습니다.">
      <div className="sim-links">
        <div className="kpi-card"><span className="kpi-card__label">작업 ↔ 객체</span><span className="kpi-card__value tabular">{pct(linkedActs, acts.length)}</span>
          <span className="kpi-card__meta tabular">{linkedActs} / {acts.length} 작업 · 객체 {objects.toLocaleString()}</span></div>
        <div className="kpi-card"><span className="kpi-card__label">6단계 연결 → 이 모델</span>
          <span className="kpi-card__value tabular">{info ? info.found.toLocaleString() : '—'}</span>
          <span className="kpi-card__meta tabular">{info ? `못 찾음 ${info.missing.toLocaleString()} · 모델 코드로 ${info.byModelCode.toLocaleString()}` : '모델을 열면 찾습니다'}</span></div>
        <div className="kpi-card"><span className="kpi-card__label">모델 실적 반영</span>
          <span className="kpi-card__value tabular">{actuals ? actuals.filled.toLocaleString() : '—'}</span>
          <span className="kpi-card__meta tabular">{actuals ? `작업 · 실적 날짜 객체 ${actuals.dated.toLocaleString()} 중 ${actuals.linked.toLocaleString()} 이음` : '모델에 A5 실시 날짜가 없거나 아직 안 읽음'}</span></div>
        <div className="kpi-card"><span className="kpi-card__label">내역 ↔ 객체</span><span className="kpi-card__value tabular">{pct(linkedBoq, sim.boq.length)}</span>
          <span className="kpi-card__meta tabular">{linkedBoq} / {sim.boq.length} 항목</span></div>
        <div className="kpi-card"><span className="kpi-card__label">3D 선택</span><span className="kpi-card__value tabular">{objectCount.toLocaleString()}</span>
          <span className="kpi-card__meta">3D 에서 고른 객체가 걸린 작업이 공정표에서 선택됩니다</span></div>
      </div>
    </TabFrame>
  );
}

function TabFrame({ title, note, actions, children }: { title: string; note: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="sim-tab">
      <div className="sim-tab__head">
        <strong>{title}</strong>
        <span className="muted">{note}</span>
        <div className="spacer" />
        {actions}
      </div>
      <div className="sim-tab__body">{children}</div>
    </div>
  );
}
