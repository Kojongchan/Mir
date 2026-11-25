import { useCallback, useEffect, useState } from 'react';
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

/** 측정 한 건: 장면 좌표 두 점(+ 높이 차이용 모델 좌표 Z). */
export type Measure = { a: [number, number, number]; b: [number, number, number]; za: number; zb: number };

/** 측정선·거리 표시(카메라를 따라 다시 그린다). */
export function MirMeasureLayer({ viewer, measures, pending }: { viewer: TilesViewer; measures: Measure[]; pending: [number, number, number] | null }) {
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => viewer.onViewChange(redraw), [viewer, redraw]);
  const scr = (p: [number, number, number]) => viewer.sceneToScreen(p[0], p[1], p[2]);
  return (
    <svg className="mir-measure" aria-label="측정">
      {measures.map((m, i) => {
        const a = scr(m.a), b = scr(m.b);
        if (!a || !b) return null;
        const d = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
        const dz = m.zb - m.za;
        const label = `${d.toFixed(3)} m${Math.abs(dz) >= 0.001 ? ` · 높이차 ${dz >= 0 ? '+' : ''}${dz.toFixed(3)} m` : ''}`;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        return (
          <g key={i}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="mir-measure__line" />
            <circle cx={a.x} cy={a.y} r={4} className="mir-measure__dot" />
            <circle cx={b.x} cy={b.y} r={4} className="mir-measure__dot" />
            <text x={mx} y={my - 8} className="mir-measure__label" textAnchor="middle">{label}</text>
          </g>
        );
      })}
      {pending && (() => { const p = scr(pending); return p ? <circle cx={p.x} cy={p.y} r={5} className="mir-measure__dot is-pending" /> : null; })()}
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
