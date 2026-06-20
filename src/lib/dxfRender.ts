import DxfParser from 'dxf-parser';
import type {
  IEntity,
  ILineEntity,
  ILwpolylineEntity,
  IPolylineEntity,
  IArcEntity,
  ICircleEntity,
  IEllipseEntity,
  ITextEntity,
  IMtextEntity,
  IPointEntity,
} from 'dxf-parser';

// =====================================================================
// 경량 DXF → 2D 캔버스 렌더러 (S41). 현장 2D 도면 열람용.
// three.js 의존 없이 흔한 2D 엔티티(LINE/POLYLINE/ARC/CIRCLE/ELLIPSE/TEXT)를
// 흰 시트에 검정 선으로 그린다. 좌표는 DXF y-up → 캔버스 y-down 으로 뒤집는다.
// 한계(MVP): INSERT(블록 참조)·SPLINE·해치는 미전개. 필요 시 후속.
// 핀 좌표는 캔버스 정규화(0..1)라 줌/팬과 무관하게 정합한다.
// =====================================================================

export interface DxfRenderOk {
  ok: true;
  width: number;
  height: number;
  /** 미지원(건너뜀) 엔티티 종류와 개수(안내용). */
  skipped: Record<string, number>;
}
export interface DxfRenderErr {
  ok: false;
  error: string;
}

const SUPPORTED = new Set([
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'ARC',
  'CIRCLE',
  'ELLIPSE',
  'TEXT',
  'MTEXT',
  'POINT',
]);

type Ext = (x: number, y: number) => void;

function polyPoints(e: ILwpolylineEntity | IPolylineEntity): { x: number; y: number }[] {
  return (e.vertices ?? []).map((v) => ({ x: v.x, y: v.y }));
}

function accumulateBounds(e: IEntity, ext: Ext) {
  switch (e.type) {
    case 'LINE':
      for (const v of (e as ILineEntity).vertices ?? []) ext(v.x, v.y);
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      for (const p of polyPoints(e as ILwpolylineEntity)) ext(p.x, p.y);
      break;
    case 'CIRCLE':
    case 'ARC': {
      const c = e as ICircleEntity;
      ext(c.center.x - c.radius, c.center.y - c.radius);
      ext(c.center.x + c.radius, c.center.y + c.radius);
      break;
    }
    case 'ELLIPSE': {
      const el = e as IEllipseEntity;
      const r = Math.hypot(el.majorAxisEndPoint.x, el.majorAxisEndPoint.y);
      ext(el.center.x - r, el.center.y - r);
      ext(el.center.x + r, el.center.y + r);
      break;
    }
    case 'TEXT':
      ext((e as ITextEntity).startPoint.x, (e as ITextEntity).startPoint.y);
      break;
    case 'MTEXT':
      ext((e as IMtextEntity).position.x, (e as IMtextEntity).position.y);
      break;
    case 'POINT':
      ext((e as IPointEntity).position.x, (e as IPointEntity).position.y);
      break;
  }
}

/**
 * DXF 텍스트를 파싱해 캔버스에 렌더. 성공 시 캔버스 크기/스킵 통계, 실패 시 에러.
 * `maxPx` 는 긴 변 픽셀 상한(선명도/메모리 균형).
 */
export function renderDxfToCanvas(
  text: string,
  canvas: HTMLCanvasElement,
  maxPx = 2400,
): DxfRenderOk | DxfRenderErr {
  let dxf: ReturnType<DxfParser['parseSync']>;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const entities = dxf?.entities ?? [];
  if (entities.length === 0) return { ok: false, error: 'DXF에 엔티티가 없습니다.' };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ext: Ext = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of entities) accumulateBounds(e, ext);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { ok: false, error: '도면 좌표 범위를 계산할 수 없습니다.' };
  }

  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = Math.max(1e-9, Math.min(maxPx / w, maxPx / h));
  const pad = 16;
  const cw = Math.max(1, Math.ceil(w * scale) + pad * 2);
  const ch = Math.max(1, Math.ceil(h * scale) + pad * 2);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, error: '캔버스 컨텍스트를 만들 수 없습니다.' };

  // 흰 시트 + 검정 선(현장 도면 출력 느낌).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = '#101418';
  ctx.fillStyle = '#101418';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tx = (x: number) => (x - minX) * scale + pad;
  const ty = (y: number) => ch - ((y - minY) * scale + pad); // y-up → y-down

  const skipped: Record<string, number> = {};
  for (const e of entities) {
    if (!SUPPORTED.has(e.type)) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    drawEntity(ctx, e, tx, ty, scale);
  }

  return { ok: true, width: cw, height: ch, skipped };
}

function drawEntity(
  ctx: CanvasRenderingContext2D,
  e: IEntity,
  tx: (x: number) => number,
  ty: (y: number) => number,
  scale: number,
) {
  switch (e.type) {
    case 'LINE': {
      const vs = (e as ILineEntity).vertices ?? [];
      if (vs.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(tx(vs[0].x), ty(vs[0].y));
      for (let i = 1; i < vs.length; i++) ctx.lineTo(tx(vs[i].x), ty(vs[i].y));
      ctx.stroke();
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const pts = polyPoints(e as ILwpolylineEntity);
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(tx(pts[0].x), ty(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(tx(pts[i].x), ty(pts[i].y));
      if ((e as ILwpolylineEntity).shape) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'CIRCLE': {
      const c = e as ICircleEntity;
      ctx.beginPath();
      ctx.arc(tx(c.center.x), ty(c.center.y), c.radius * scale, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'ARC': {
      const a = e as IArcEntity;
      // dxf-parser 는 startAngle/endAngle 를 라디안으로 보관. 캔버스 y 반전 →
      // 각도 부호가 뒤집히므로 anticlockwise 로 -start..-end 를 그린다.
      ctx.beginPath();
      ctx.arc(tx(a.center.x), ty(a.center.y), a.radius * scale, -a.startAngle, -a.endAngle, true);
      ctx.stroke();
      break;
    }
    case 'ELLIPSE': {
      const el = e as IEllipseEntity;
      const rx = Math.hypot(el.majorAxisEndPoint.x, el.majorAxisEndPoint.y);
      const ry = rx * el.axisRatio;
      const rot = Math.atan2(el.majorAxisEndPoint.y, el.majorAxisEndPoint.x);
      ctx.beginPath();
      ctx.ellipse(tx(el.center.x), ty(el.center.y), rx * scale, ry * scale, -rot, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'TEXT': {
      const t = e as ITextEntity;
      if (!t.text) break;
      drawLabel(ctx, t.text, tx(t.startPoint.x), ty(t.startPoint.y), (t.textHeight || 2) * scale);
      break;
    }
    case 'MTEXT': {
      const t = e as IMtextEntity;
      if (!t.text) break;
      drawLabel(ctx, t.text.replace(/\\[A-Za-z][^;]*;?|[{}]/g, ''), tx(t.position.x), ty(t.position.y), (t.height || 2) * scale);
      break;
    }
    case 'POINT': {
      const p = e as IPointEntity;
      ctx.beginPath();
      ctx.arc(tx(p.position.x), ty(p.position.y), 1.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number) {
  const size = Math.max(7, Math.min(48, px));
  ctx.save();
  ctx.font = `${size}px sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, x, y);
  ctx.restore();
}
