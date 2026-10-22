import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { sCurve, type TimedActivity } from '../../lib/sim45d/timeline';
import { TOOLTIP_ITEM, TOOLTIP_LABEL, TOOLTIP_STYLE } from '../TrendChart';

/**
 * 차트 탭: 계획 공정률 S-curve(+ 공사비가 연결되면 누적 공사비). 세로선 = 기준일, 차트를 누르면 그 날로.
 * 실적 곡선은 P6 실적일(act_start/end)이 들어온 공정표에서 함께 그린다.
 */
export function ProgressChart({ acts, range, time, onTime, cost }: {
  acts: TimedActivity[];
  range: { start: number; end: number };
  time: number;
  onTime: (t: number) => void;
  cost?: ReadonlyMap<string, number>;
}) {
  const data = useMemo(() => sCurve(acts, range, cost && cost.size ? cost : undefined).map(p => ({
    t: p.t,
    계획: Math.round(p.progress * 1000) / 10,
    ...(p.cost !== null ? { 누적공사비: Math.round(p.cost) } : {}),
  })), [acts, range, cost]);
  const hasCost = !!cost && cost.size > 0;
  const tick = { fill: 'var(--chart-axis)', fontSize: 11 };
  const ticks = useMemo(() => monthTicks(range), [range]);
  return (
    <div className="sim-chart">
      <div className="sim-chart__head">
        <strong>S-curve</strong>
        <span className="muted">계획 공정률{hasCost ? ' · 누적 공사비' : ' (기간 가중 — 내역이 연결되면 공사비 가중으로 바뀝니다)'}</span>
      </div>
      <div className="sim-chart__body">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: hasCost ? 8 : 16, bottom: 0, left: 0 }}
            onClick={e => { const t = Number((e as { activeLabel?: unknown })?.activeLabel); if (Number.isFinite(t)) onTime(t); }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[range.start, range.end]} scale="time" tick={tick} stroke="var(--chart-grid)"
              ticks={ticks} tickFormatter={(v: number) => fmtMonth(v)} minTickGap={8} />
            <YAxis yAxisId="p" tick={tick} stroke="var(--chart-grid)" width={40} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
            {hasCost && <YAxis yAxisId="c" orientation="right" tick={tick} stroke="var(--chart-grid)" width={56} tickFormatter={(v: number) => won(v)} />}
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
              labelFormatter={v => fmtDay(Number(v))}
              formatter={(v, name) => (name === '누적공사비' ? won(Number(v)) : `${v}%`)} />
            {/* 기준일을 움직일 때마다 다시 그려지므로 애니메이션은 끔 */}
            {hasCost && <Area yAxisId="c" type="monotone" dataKey="누적공사비" stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />}
            <Line yAxisId="p" type="monotone" dataKey="계획" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <ReferenceLine yAxisId="p" x={time} stroke="var(--color-error)" strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** 금액을 억/만 단위로. */
export function won(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`;
  return Math.round(v).toLocaleString('ko-KR');
}

/** 매월 1일 눈금(기간이 길면 2·3·6개월 간격). */
function monthTicks(range: { start: number; end: number }): number[] {
  const months = Math.max(1, (range.end - range.start) / (30 * 86_400_000));
  const step = months <= 14 ? 1 : months <= 28 ? 2 : months <= 42 ? 3 : 6;
  const out: number[] = [];
  const d = new Date(range.start);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  if (d.getTime() < range.start) d.setMonth(d.getMonth() + 1);
  for (; d.getTime() <= range.end; d.setMonth(d.getMonth() + step)) out.push(d.getTime());
  return out;
}

function fmtMonth(t: number): string {
  const d = new Date(t);
  return `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function fmtDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
