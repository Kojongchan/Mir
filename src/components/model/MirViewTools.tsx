import { useCallback, useEffect, useRef, useState } from 'react';
import type { TilesViewer } from '../../viewer2/TilesViewer';
import { MarkupOverlay, type MarkupTool } from '../MarkupOverlay';
import { REDLINE_COLORS, bakeMarkup, type MarkupShape, type RedlineColor } from '../../lib/viewpoints';

// =====================================================================
// 통합모델(3D) 자체 엔진 도구 — 기존 Autodesk 뷰어의 홈뷰·관측점·측정·마크업을 옮긴 것.
// 홈뷰·관측점은 기존 뷰어처럼 이 브라우저에 현장별로 저장한다(시점 = 카메라 위치·바라보는 점).
// =====================================================================

export type MirView = { position: [number, number, number]; target: [number, number, number] };
type Viewpoint = { id: string; name: string; view: MirView; thumbnail: string | null; created_at: string };

const HOME_KEY = (projectId: string) => `mir.own.homeview.${projectId}`;
const VP_KEY = (projectId: string) => `mir.own.viewpoints.${projectId}`;
const read = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export const loadHomeView = (projectId: string): MirView | null => read<MirView | null>(HOME_KEY(projectId), null);

async function thumbnailOf(viewer: TilesViewer): Promise<string | null> {
  try {
    const blob = await viewer.snapshot(240);
    return await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(typeof r.result === 'string' ? r.result : null); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
  } catch { return null; }
}

/** 홈뷰(이 모델을 열면 처음 보이는 시점)와 관측점(이름 붙인 시점) 창. */
export function MirViewpointPanel({ viewer, projectId, onClose, onStatus }: {
  viewer: TilesViewer; projectId: string; onClose: () => void; onStatus: (text: string) => void;
}) {
  const [list, setList] = useState<Viewpoint[]>(() => read<Viewpoint[]>(VP_KEY(projectId), []));
  const [hasHome, setHasHome] = useState(() => !!loadHomeView(projectId));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = (next: Viewpoint[]) => { if (write(VP_KEY(projectId), next)) setList(next); else onStatus('이 브라우저 저장 공간이 부족해 관측점을 저장하지 못했습니다.'); };

  const add = async () => {
    if (busy) return;
    setBusy(true);
    const view = viewer.getView();
    const item: Viewpoint = { id: `vp_${Date.now().toString(36)}`, name: name.trim() || `관측점 ${list.length + 1}`, view, thumbnail: await thumbnailOf(viewer), created_at: new Date().toISOString() };
    save([item, ...list]);
    setName('');
    setBusy(false);
  };
  return (
    <aside className="mir-vp" aria-label="홈뷰·관측점">
      <div className="threed-test__panel-h">
        <strong>홈뷰·관측점</strong>
        <div className="spacer" />
        <button type="button" className="ic-only" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      <div className="mir-vp__body">
        <div className="mir-vp__home">
          <button type="button" className="btn btn--sm" onClick={() => { const h = loadHomeView(projectId); if (h) viewer.setView(h); else viewer.frameAll(); }}>홈뷰로</button>
          <button type="button" className="btn btn--sm" onClick={() => { write(HOME_KEY(projectId), viewer.getView()); setHasHome(true); onStatus('지금 시점을 홈뷰로 저장했습니다. 이 모델을 열면 이 시점에서 시작합니다.'); }}>지금 시점을 홈뷰로</button>
          {hasHome && <button type="button" className="btn btn--sm" onClick={() => { write(HOME_KEY(projectId), null); setHasHome(false); onStatus('홈뷰를 지웠습니다(처음엔 현장 전체).'); }}>홈뷰 초기화</button>}
        </div>
        <div className="mir-vp__add">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="관측점 이름 (예: P12 교각 하부)" onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()} disabled={busy}>지금 시점 추가</button>
        </div>
        {list.length === 0 && <p className="muted mir-vp__empty">저장한 관측점이 없습니다. 이 브라우저에만 저장됩니다.</p>}
        <ul className="mir-vp__list">
          {list.map(vp => (
            <li key={vp.id}>
              <button type="button" className="mir-vp__item" onClick={() => viewer.setView(vp.view)} title={`${vp.name}로 이동`}>
                {vp.thumbnail ? <img src={vp.thumbnail} alt="" /> : <span className="mir-vp__noimg" />}
                <span className="mir-vp__name">{vp.name}</span>
              </button>
              <button type="button" className="ic-only" onClick={() => save(list.filter(x => x.id !== vp.id))} aria-label={`${vp.name} 삭제`}>✕</button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** 측정 종류: 거리(두 점)·각도(세 점, 가운데가 꼭짓점)·면적(여러 점, 첫 점을 다시 누르거나 Enter 로 닫음). */
export type MeasureKind = 'distance' | 'angle' | 'area';
/** 측정 한 건: 장면 좌표 점들과 각 점의 모델 높이(Z). */
export type Measure = { kind: MeasureKind; pts: [number, number, number][]; zs: number[] };
type P3 = [number, number, number];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: P3) => Math.hypot(v[0], v[1], v[2]);
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 한 건의 결과 문구. */
export function measureLabel(m: Measure): string {
  if (m.kind === 'distance') {
    const d = len(sub(m.pts[1], m.pts[0])), dz = m.zs[1] - m.zs[0];
    return `${d.toFixed(3)} m${Math.abs(dz) >= 0.001 ? ` · 높이차 ${dz >= 0 ? '+' : ''}${dz.toFixed(3)} m` : ''}`;
  }
  if (m.kind === 'angle') {
    const u = sub(m.pts[0], m.pts[1]), v = sub(m.pts[2], m.pts[1]);
    const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.max(1e-9, len(u) * len(v));
    return `${(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI).toFixed(2)}°`;
  }
  // 면적: 다각형(3D, 평면에 가깝다고 보고) 법선 방향 넓이 = |Σ pᵢ × pᵢ₊₁| / 2, 둘레 함께.
  let s: P3 = [0, 0, 0], perimeter = 0;
  for (let i = 0; i < m.pts.length; i++) {
    const a = m.pts[i], b = m.pts[(i + 1) % m.pts.length];
    const c = cross(a, b); s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
    perimeter += len(sub(b, a));
  }
  return `${(len(s) / 2).toFixed(3)} m² · 둘레 ${perimeter.toFixed(2)} m`;
}

/** 측정선·결과 표시(카메라를 따라 다시 그린다). `pending`: 그리는 중인 점들. */
export function MirMeasureLayer({ viewer, measures, pending, kind }: { viewer: TilesViewer; measures: Measure[]; pending: P3[]; kind: MeasureKind }) {
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => viewer.onViewChange(redraw), [viewer, redraw]);
  const scr = (p: P3) => viewer.sceneToScreen(p[0], p[1], p[2]);
  const shape = (pts: P3[], closed: boolean, key: string, label: string | null) => {
    const s = pts.map(scr);
    if (s.some(p => !p)) return null;
    const xy = s as { x: number; y: number }[];
    const path = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + (closed ? ' Z' : '');
    const anchor = closed ? { x: xy.reduce((a, p) => a + p.x, 0) / xy.length, y: xy.reduce((a, p) => a + p.y, 0) / xy.length }
      : xy.length === 3 ? xy[1] : { x: (xy[0].x + xy[xy.length - 1].x) / 2, y: (xy[0].y + xy[xy.length - 1].y) / 2 };
    return (
      <g key={key}>
        <path d={path} className={`mir-measure__line${closed ? ' is-area' : ''}`} />
        {xy.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4} className="mir-measure__dot" />)}
        {label && <text x={anchor.x} y={anchor.y - 10} className="mir-measure__label" textAnchor="middle">{label}</text>}
      </g>
    );
  };
  return (
    <svg className="mir-measure" aria-label="측정">
      {measures.map((m, i) => shape(m.pts, m.kind === 'area', `m${i}`, measureLabel(m)))}
      {pending.length > 0 && shape(pending, false, 'pending', kind === 'area' && pending.length >= 3 ? measureLabel({ kind, pts: pending, zs: pending.map(() => 0) }) : null)}
    </svg>
  );
}

const TOOLS: { tool: MarkupTool; label: string }[] = [
  { tool: 'arrow', label: '화살표' }, { tool: 'line', label: '선' }, { tool: 'rect', label: '사각형' }, { tool: 'text', label: '글자' }, { tool: 'select', label: '선택·이동' },
];

/** 마크업: 지금 화면 위에 도형·글자를 그려 PNG 로 저장. */
export function MirMarkupEditor({ image, fileName, onClose }: { image: string; fileName: string; onClose: () => void }) {
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [tool, setTool] = useState<MarkupTool>('arrow');
  const [color, setColor] = useState<RedlineColor>('red');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const url = await bakeMarkup(image, shapes);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
    } finally { setBusy(false); }
  };
  return (
    <div className="mir-markup" role="dialog" aria-label="마크업">
      <div className="mir-markup__bar">
        <strong>마크업</strong>
        {TOOLS.map(t => <button key={t.tool} type="button" className={`btn btn--sm${tool === t.tool ? ' btn--primary' : ''}`} onClick={() => setTool(t.tool)}>{t.label}</button>)}
        <span className="mir-markup__colors">
          {REDLINE_COLORS.map(c => <button key={c} type="button" className={`mir-markup__color${color === c ? ' is-on' : ''}`} style={{ background: `var(--redline-${c})` }} onClick={() => setColor(c)} aria-label={c} />)}
        </span>
        {selected !== null && <button type="button" className="btn btn--sm" onClick={() => { setShapes(s => s.filter((_, i) => i !== selected)); setSelected(null); }}>선택 삭제</button>}
        <button type="button" className="btn btn--sm" disabled={!shapes.length} onClick={() => { setShapes(s => s.slice(0, -1)); setSelected(null); }}>되돌리기</button>
        <div className="spacer" />
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void download()} disabled={busy}>{busy ? '저장 중…' : 'PNG 저장'}</button>
        <button type="button" className="btn btn--sm" onClick={onClose}>닫기</button>
      </div>
      <div className="mir-markup__stage">
        <div className="mir-markup__frame">
          <img src={image} alt="마크업할 3D 화면" />
          <MarkupOverlay shapes={shapes} onChange={setShapes} active tool={tool} color={color} selected={selected} onSelect={setSelected} />
        </div>
      </div>
    </div>
  );
}

/** 미니맵: 구조물 평면 배치(객체 상자 중심)와 카메라 위치·바라보는 방향. 누르면 그곳으로 시점을 옮긴다. */
export function MirMinimap({ viewer, boxes, bounds, onClose }: {
  viewer: TilesViewer; boxes: Float32Array; bounds: [number, number, number, number, number, number]; onClose: () => void;
}) {
  const W = 260, H = 160, PAD = 8;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const sx = (W - PAD * 2) / Math.max(1e-6, bounds[3] - bounds[0]), sy = (H - PAD * 2) / Math.max(1e-6, bounds[4] - bounds[1]);
  const scale = Math.min(sx, sy);
  const ox = PAD + ((W - PAD * 2) - (bounds[3] - bounds[0]) * scale) / 2, oy = PAD + ((H - PAD * 2) - (bounds[4] - bounds[1]) * scale) / 2;
  const toPx = useCallback((x: number, y: number) => ({ x: ox + (x - bounds[0]) * scale, y: H - (oy + (y - bounds[1]) * scale) }), [bounds, scale, ox, oy]);
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!baseRef.current) {
      const b = document.createElement('canvas');
      b.width = W * dpr; b.height = H * dpr;
      const bg = b.getContext('2d')!;
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.fillStyle = 'rgba(120,130,145,0.55)';
      for (let id = 1; id * 6 + 5 < boxes.length; id++) {
        const o = id * 6;
        if (Number.isNaN(boxes[o])) continue;
        const p = toPx((boxes[o] + boxes[o + 3]) / 2, (boxes[o + 1] + boxes[o + 4]) / 2);
        bg.fillRect(p.x, p.y, 1, 1);
      }
      baseRef.current = b;
    }
    g.clearRect(0, 0, W, H);
    g.drawImage(baseRef.current, 0, 0, W, H);
    const cam = viewer.camera.position, t = viewer.target;
    const pc = viewer.sceneToModel(cam.x, cam.y, cam.z), pt = viewer.sceneToModel(t.x, t.y, t.z);
    const a = toPx(pc[0], pc[1]), b = toPx(pt[0], pt[1]);
    g.strokeStyle = '#dc2626'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.fillStyle = '#dc2626';
    g.beginPath(); g.arc(a.x, a.y, 4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(b.x, b.y, 3, 0, Math.PI * 2); g.stroke();
  }, [viewer, boxes, toPx]);
  useEffect(() => { baseRef.current = null; draw(); }, [draw]);
  useEffect(() => viewer.onViewChange(draw), [viewer, draw]);
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const x = bounds[0] + (px - ox) / scale, y = bounds[1] + (H - py - oy) / scale;
    const t = viewer.target, cur = viewer.sceneToModel(t.x, t.y, t.z);
    const next = viewer.modelToScene(x, y, cur[2]);
    const shift = next.clone().sub(t);
    viewer.lookAt(viewer.camera.position.clone().add(shift), next);
  };
  return (
    <div className="mir-minimap" aria-label="미니맵">
      <canvas ref={canvasRef} style={{ width: W, height: H }} onClick={onClick} title="누르면 그곳으로 시점을 옮깁니다" />
      <button type="button" className="ic-only mir-minimap__close" onClick={onClose} aria-label="미니맵 닫기">✕</button>
    </div>
  );
}

/** 층 필터: 객체 속성의 층(레벨) 값 목록 — 누르면 그 층만 보이기. */
export function MirLevelPanel({ load, onPick, onShowAll, onClose }: {
  load: (onProgress: (done: number, total: number) => void) => Promise<{ value: string; count: number }[]>;
  onPick: (value: string) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const [levels, setLevels] = useState<{ value: string; count: number }[] | null>(null);
  const [progress, setProgress] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    load((done, total) => { if (alive) setProgress(`속성 색인 읽는 중 ${done}/${total}`); })
      .then(list => { if (alive) setLevels(list); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [load]);
  return (
    <aside className="mir-vp mir-levels" aria-label="층 필터">
      <div className="threed-test__panel-h">
        <strong>층 필터</strong>
        <div className="spacer" />
        {picked && <button type="button" className="btn btn--sm" onClick={() => { setPicked(null); onShowAll(); }}>모두 보이기</button>}
        <button type="button" className="ic-only" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      <div className="mir-vp__body">
        {error && <p className="muted">층 정보를 읽지 못했습니다: {error}</p>}
        {!levels && !error && <p className="muted">{progress || '층 정보 읽는 중…'}</p>}
        {levels && levels.length === 0 && <p className="muted">이 모델에는 층(레벨) 속성이 없습니다. 토목 모델은 보통 층 대신 「단면」이나 모델 트리로 나눠 봅니다.</p>}
        {levels && levels.length > 0 && (
          <ul className="mir-vp__list">
            {levels.map(l => (
              <li key={l.value}>
                <button type="button" className={`mir-vp__item${picked === l.value ? ' is-on' : ''}`} onClick={() => { setPicked(l.value); onPick(l.value); }}>
                  <span className="mir-vp__name">{l.value}</span>
                  <span className="muted">{l.count.toLocaleString()}개</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
