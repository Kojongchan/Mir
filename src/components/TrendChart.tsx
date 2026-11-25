import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Recharts 툴팁 — 토큰 기반(라이트/다크 자동). 텍스트는 ink 토큰, 마크만 계열색.
export const TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-default)',
  borderRadius: '8px',
  fontSize: '12px',
  boxShadow: 'var(--shadow-md)',
};
export const TOOLTIP_LABEL = { color: 'var(--color-text-secondary)' };
export const TOOLTIP_ITEM = { color: 'var(--color-text-primary)' };

export interface TrendSeries {
  /** Field of each row, also the name in the tooltip and legend. */
  key: string;
  color: string;
  kind?: 'line' | 'area' | 'bar';
  dashed?: boolean;
}

interface Props {
  data: Record<string, string | number>[];
  /** Field holding the x label (e.g. 'YYYY-MM'). */
  x: string;
  series: TrendSeries[];
  height?: number;
  /** Tick and tooltip text of a value (e.g. amounts in 억/만). */
  format?: (v: number) => string;
  /** Fixed value range (e.g. [0, 100] for percentages). */
  domain?: [number, number];
}

/**
 * Month-by-month chart with axes, grid and tooltip, in the dashboard's style (same tokens in light and dark). Text keeps
 * its size whatever the chart's width (the old SVG mini chart stretched its labels with the picture).
 */
export function TrendChart({ data, x, series, height = 220, format, domain }: Props) {
  if (!data.length) return <div className="chart-empty muted">데이터 없음</div>;
  const tick = { fill: 'var(--chart-axis)', fontSize: 11 };
  return (
    <div className="trend-chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey={x} tick={tick} stroke="var(--chart-grid)" minTickGap={16} />
          <YAxis tick={tick} stroke="var(--chart-grid)" width={format ? 56 : 40} domain={domain ?? [0, 'auto']}
            tickFormatter={format ? (v: number) => format(v) : undefined} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
            formatter={format ? (v) => format(Number(v)) : undefined} />
          {series.map(s => s.kind === 'bar'
            ? <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={36} />
            : s.kind === 'area'
              ? <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.12} dot={{ r: 2 }} />
              : <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 2 }}
                strokeDasharray={s.dashed ? '5 4' : undefined} />)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
