import { useRef, useState } from 'react';
import type { MarkupShape, RedlineColor } from '../lib/viewpoints';

export type MarkupTool = 'select' | 'line' | 'rect' | 'arrow' | 'text';

interface Props {
  shapes: MarkupShape[];
  onChange: (shapes: MarkupShape[]) => void;
  /** 그리기 활성(off 면 오버레이는 표시만, 포인터 통과). */
  active: boolean;
  tool: MarkupTool;
  color: RedlineColor;
}

/**
 * 뷰포트 위 2D 마크업(redline) 오버레이(SVG). 좌표는 정규화(0..1)로 저장돼
 * 해상도·뷰포인트와 무관하게 재현된다(D16). active 일 때만 포인터를 받아 그리며,
 * 비활성 시 pointer-events:none 으로 3D 조작을 방해하지 않는다.
 */
export function MarkupOverlay({ shapes, onChange, active, tool, color }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const drawing = useRef(false);

  const norm = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    const p = norm(e);
    if (tool === 'text') {
      const text = window.prompt('주석 텍스트');
      if (text?.trim()) onChange([...shapes, { kind: 'text', x1: p.x, y1: p.y, text: text.trim(), color }]);
      return;
    }
    if (tool === 'select') return;
    drawing.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraft({ kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current || !draft || draft.kind === 'text') return;
    const p = norm(e);
    setDraft({ ...draft, x2: p.x, y2: p.y });
  };

  const onUp = () => {
    if (!drawing.current || !draft) return;
    drawing.current = false;
    if (draft.kind !== 'text') {
      const moved = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
      if (moved > 0.01) onChange([...shapes, draft]);
    }
    setDraft(null);
  };

  const all = draft ? [...shapes, draft] : shapes;

  return (
    <svg
      ref={ref}
      className="markup-overlay"
      style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      preserveAspectRatio="none"
      viewBox="0 0 1000 1000"
    >
      <defs>
        {(['red', 'blue', 'yellow', 'green', 'white'] as RedlineColor[]).map((c) => (
          <marker
            key={c}
            id={`mk-arrow-${c}`}
            markerWidth="10"
            markerHeight="10"
            refX="7"
            refY="5"
            orient="auto"
          >
            <path d="M0,0 L8,5 L0,10 z" fill={`var(--redline-${c})`} />
          </marker>
        ))}
      </defs>
      {all.map((s, i) => (
        <Shape key={i} s={s} />
      ))}
    </svg>
  );
}

function Shape({ s }: { s: MarkupShape }) {
  const stroke = `var(--redline-${s.color})`;
  const W = 1000;
  if (s.kind === 'text') {
    return (
      <text x={s.x1 * W} y={s.y1 * W} fill={stroke} className="markup-text">
        {s.text}
      </text>
    );
  }
  const x1 = s.x1 * W;
  const y1 = s.y1 * W;
  const x2 = s.x2 * W;
  const y2 = s.y2 * W;
  if (s.kind === 'rect') {
    return (
      <rect
        x={Math.min(x1, x2)}
        y={Math.min(y1, y2)}
        width={Math.abs(x2 - x1)}
        height={Math.abs(y2 - y1)}
        fill="none"
        stroke={stroke}
        strokeWidth={4}
      />
    );
  }
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={stroke}
      strokeWidth={4}
      strokeLinecap="round"
      markerEnd={s.kind === 'arrow' ? `url(#mk-arrow-${s.color})` : undefined}
    />
  );
}
