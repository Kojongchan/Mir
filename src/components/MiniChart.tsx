// Tiny dependency-free SVG charts for the dashboard (the bundle already
// carries three.js + web-ifc, so we avoid pulling in a charting library).

interface Series {
  values: number[];
  color: string;
  fill?: boolean; // area under the line
}

interface Props {
  series: Series[];
  labels?: string[];
  height?: number;
  type?: 'line' | 'bar';
}

const W = 520; // viewBox width; scales responsively via CSS width:100%
const PAD = 6;

export function MiniChart({ series, labels, height = 120, type = 'line' }: Props) {
  const H = height;
  const all = series.flatMap((s) => s.values);
  const hasData = all.length > 0 && series.some((s) => s.values.length > 0);
  if (!hasData) {
    return <div className="chart-empty muted">데이터 없음</div>;
  }
  const max = Math.max(1, ...all);
  const n = Math.max(...series.map((s) => s.values.length));
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const x = (i: number) => PAD + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => PAD + innerH - (innerH * v) / max;

  return (
    <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      {/* baseline */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="chart-axis" />
      {type === 'bar'
        ? series.map((s, si) =>
            s.values.map((v, i) => {
              const bw = innerW / (n * series.length) * 0.7;
              const bx = PAD + (innerW * i) / Math.max(1, n) + si * bw;
              return (
                <rect
                  key={`${si}-${i}`}
                  x={bx}
                  y={y(v)}
                  width={bw}
                  height={H - PAD - y(v)}
                  fill={s.color}
                  rx={1}
                />
              );
            }),
          )
        : series.map((s, si) => {
            const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
            const area = `${PAD},${H - PAD} ${pts} ${x(s.values.length - 1)},${H - PAD}`;
            return (
              <g key={si}>
                {s.fill && <polygon points={area} fill={s.color} opacity={0.14} />}
                <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} />
              </g>
            );
          })}
      {labels && (
        <>
          <text x={PAD} y={H - 1} className="chart-label" textAnchor="start">
            {labels[0]}
          </text>
          <text x={W - PAD} y={H - 1} className="chart-label" textAnchor="end">
            {labels[labels.length - 1]}
          </text>
        </>
      )}
    </svg>
  );
}
