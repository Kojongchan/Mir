import { useRef, useState } from 'react';
import type { MarkupShape, RedlineColor } from '../lib/viewpoints';

export type MarkupTool = 'select' | 'line' | 'rect' | 'arrow' | 'text';

interface Props {
  shapes: MarkupShape[];
  onChange: (shapes: MarkupShape[]) => void;
  /** 그리기/선택 활성(off 면 오버레이는 표시만, 포인터 통과). */
  active: boolean;
  tool: MarkupTool;
  color: RedlineColor;
  /** 선택된 도형 인덱스(select 도구) — 외부에서 삭제 버튼 노출용. */
  selected: number | null;
  onSelect: (i: number | null) => void;
}

const HIT = 0.025; // 선택 히트 임계값(정규화)
const VB = 1000; // viewBox 단위

/**
 * 뷰포트 위 2D 마크업(redline) 오버레이(SVG). 좌표는 정규화(0..1)로 저장돼
 * 해상도·뷰포인트와 무관하게 재현된다(D16). active 일 때만 포인터를 받아 그리거나
 * (select 도구) 도형을 선택·이동하며, 비활성 시 pointer-events:none 으로 3D 조작을
 * 방해하지 않는다.
 */
export function MarkupOverlay({ shapes, onChange, active, tool, color, selected, onSelect }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const drawing = useRef(false);
  // select 도구로 도형을 끌어 이동할 때의 상태.
  const moveRef = useRef<{ index: number; sx: number; sy: number; orig: MarkupShape } | null>(null);

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
    if (tool === 'select') {
      const idx = hitTest(shapes, p.x, p.y);
      onSelect(idx);
      if (idx != null) {
        moveRef.current = { index: idx, sx: p.x, sy: p.y, orig: shapes[idx] };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
      return;
    }
    if (tool === 'text') {
      const text = window.prompt('주석 텍스트');
      if (text?.trim()) onChange([...shapes, { kind: 'text', x1: p.x, y1: p.y, text: text.trim(), color }]);
      return;
    }
    drawing.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraft({ kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!active) return;
    const mv = moveRef.current;
    if (mv) {
      const p = norm(e);
      const next = shapes.slice();
      next[mv.index] = translate(mv.orig, p.x - mv.sx, p.y - mv.sy);
      onChange(next);
      return;
    }
    if (!drawing.current || !draft || draft.kind === 'text') return;
    const p = norm(e);
    setDraft({ ...draft, x2: p.x, y2: p.y });
  };

  const onUp = () => {
    if (moveRef.current) {
      moveRef.current = null;
      return;
    }
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
      style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? (tool === 'select' ? 'default' : 'crosshair') : 'default' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      preserveAspectRatio="none"
      viewBox={`0 0 ${VB} ${VB}`}
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
      {selected != null && shapes[selected] && <Selection s={shapes[selected]} />}
    </svg>
  );
}

function Shape({ s }: { s: MarkupShape }) {
  const stroke = `var(--redline-${s.color})`;
  if (s.kind === 'text') {
    return (
      <text x={s.x1 * VB} y={s.y1 * VB} fill={stroke} className="markup-text">
        {s.text}
      </text>
    );
  }
  const x1 = s.x1 * VB;
  const y1 = s.y1 * VB;
  const x2 = s.x2 * VB;
  const y2 = s.y2 * VB;
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

/** 선택 표시(점선 바운딩 박스). */
function Selection({ s }: { s: MarkupShape }) {
  const b = bbox(s);
  const pad = 14;
  return (
    <rect
      className="markup-sel"
      x={b.minX * VB - pad}
      y={b.minY * VB - pad}
      width={(b.maxX - b.minX) * VB + pad * 2}
      height={(b.maxY - b.minY) * VB + pad * 2}
      fill="none"
    />
  );
}

// ---------- 기하 헬퍼(정규화 좌표) ----------------------------------

function translate(s: MarkupShape, dx: number, dy: number): MarkupShape {
  if (s.kind === 'text') return { ...s, x1: s.x1 + dx, y1: s.y1 + dy };
  return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
}

function bbox(s: MarkupShape): { minX: number; minY: number; maxX: number; maxY: number } {
  if (s.kind === 'text') return { minX: s.x1, minY: s.y1 - 0.03, maxX: s.x1 + 0.18, maxY: s.y1 + 0.01 };
  return {
    minX: Math.min(s.x1, s.x2),
    minY: Math.min(s.y1, s.y2),
    maxX: Math.max(s.x1, s.x2),
    maxY: Math.max(s.y1, s.y2),
  };
}

/** 위에 그려진(나중) 도형 우선으로 히트 테스트. 맞으면 인덱스, 없으면 null. */
function hitTest(shapes: MarkupShape[], px: number, py: number): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind === 'text') {
      if (Math.hypot(px - s.x1, py - s.y1) < HIT * 2) return i;
    } else if (s.kind === 'rect') {
      const b = bbox(s);
      const onBorder =
        px > b.minX - HIT &&
        px < b.maxX + HIT &&
        py > b.minY - HIT &&
        py < b.maxY + HIT &&
        (Math.abs(px - b.minX) < HIT ||
          Math.abs(px - b.maxX) < HIT ||
          Math.abs(py - b.minY) < HIT ||
          Math.abs(py - b.maxY) < HIT);
      if (onBorder) return i;
    } else {
      if (distToSeg(px, py, s.x1, s.y1, s.x2, s.y2) < HIT) return i;
    }
  }
  return null;
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
