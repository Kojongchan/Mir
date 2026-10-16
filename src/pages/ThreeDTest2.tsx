import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { useProjectRole } from '../auth/useProjectRole';
import { supabase } from '../lib/supabase';
import { isAccModel } from '../lib/aps';
import { errMessage, readApiJson } from '../lib/errors';
import { dialogOpen } from '../lib/useEscapeKey';
import { UiIcon } from '../components/icons/UiIcon';
import { ModelTreePanel } from '../components/model/ModelTreePanel';
import { PropertyPanel } from '../components/model/PropertyPanel';
import { useModelIndex, type MetaInfo } from '../viewer/useModelIndex';
import { TilesViewer, type ViewerStats } from '../viewer2/TilesViewer';
import { PROFILES, QUALITIES, type DeviceTier, type Quality } from '../viewer2/deviceProfile';
import { COLOR_MODES, paintFor, type ColorMode } from '../viewer2/colorModes';

const authHeaders = async () => {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ''}` };
};

/**
 * 3D뷰 (신규 테스트 2차) — second viewer engine prototype (decision D23, docs/3D뷰_2차_엔진.md): the model's 3D Tiles
 * (built by Actions diag_only=tiles3d, startable here by project admins) on three.js + 3DTilesRendererJS, next to the
 * xeokit page for comparison.
 */
const narrowScreen = () => window.matchMedia('(max-width: 900px)').matches;
/** The viewer's picture quality is remembered in this browser. */
const QUALITY_KEY = 'mir.viewer2.quality';
const storedQuality = (): Quality => {
  try { const q = localStorage.getItem(QUALITY_KEY); return q && q in QUALITIES ? (q as Quality) : 'standard'; } catch { return 'standard'; }
};

/** Outlines between objects (on unless turned off) and the colour mode, remembered in this browser. */
const OUTLINE_KEY = 'mir.viewer2.outlines', COLOR_KEY = 'mir.viewer2.colorMode';
const storedOutlines = () => { try { return localStorage.getItem(OUTLINE_KEY) !== '0'; } catch { return true; } };
const storedColorMode = (): ColorMode => {
  try { const m = localStorage.getItem(COLOR_KEY); return m && m in COLOR_MODES ? (m as ColorMode) : 'model'; } catch { return 'model'; }
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

export function ThreeDTest2() {
  const { projectId = '' } = useParams();
  const { canEdit, canManage } = useProjectRole(projectId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<TilesViewer | null>(null);
  const urlsRef = useRef<Record<string, string> | null>(null);
  const boxesRef = useRef<Promise<Float32Array> | null>(null);
  const renewAt = useRef<{ urn: string; at: number } | null>(null);
  const index = useModelIndex();
  const tree = index.tree;
  const [initError, setInitError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [modelName, setModelName] = useState('');
  const [stats, setStats] = useState<ViewerStats | null>(null);
  // Property shards download in the background once the view has first settled (tiles first), per opened model.
  const prefetchedFor = useRef<object | null>(null);
  useEffect(() => {
    if (!tree || prefetchedFor.current === tree || !stats || stats.settledMs === null || stats.downloading > 0) return;
    prefetchedFor.current = tree;
    void index.prefetch();
  }, [tree, stats, index]);
  // A model without tiles: whether it is converted at all (tiles come from the converted model) and a build job.
  const [missing, setMissing] = useState<{ file: PickedAccFile; converted: boolean } | null>(null);
  const [job, setJob] = useState<{ since: string; note: string } | null>(null);
  const [terrainOn, setTerrainOn] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [tier, setTier] = useState<DeviceTier | 'auto'>('auto');
  const [quality, setQuality] = useState<Quality>(storedQuality);
  const [outlines, setOutlines] = useState(storedOutlines);
  const [colorMode, setColorMode] = useState<ColorMode>(storedColorMode);
  const [selectedDb, setSelectedDb] = useState<number | null>(null);
  const [revealDb, setRevealDb] = useState<number | null>(null);
  const [hiddenNodes, setHiddenNodes] = useState<ReadonlySet<number>>(new Set());
  const [highlightIds, setHighlightIds] = useState<number[] | null>(null);
  const [statsOpen, setStatsOpen] = useState(false); // narrow screens: one summary line until tapped
  // Phones and narrow tablets: panels start closed and one at a time (side by side they cover the view).
  const [treeOpen, setTreeOpen] = useState(() => !narrowScreen());
  const [propsOpen, setPropsOpen] = useState(() => !narrowScreen());

  useEffect(() => {
    if (!canvasRef.current) return;
    let viewer: TilesViewer;
    try { viewer = new TilesViewer(canvasRef.current); }
    catch (e) { setInitError(errMessage(e)); return; }
    viewer.setQuality(storedQuality());
    viewer.setOutlines(storedOutlines());
    viewer.onStats = next => setStats(prev => prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    viewerRef.current = viewer;
    return () => { viewer.dispose(); viewerRef.current = null; };
  }, []);

  // Narrow screens: the open panel is a bottom sheet; keep the model centred above it.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const update = () => {
      const sheet = narrowScreen() ? document.querySelector<HTMLElement>('.threed-test--v2 .threed-test__panel') : null;
      viewer.setBottomInset(sheet ? sheet.offsetHeight + 8 : 0);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [tree, treeOpen, propsOpen]);

  // Object states → the viewer's state texture (a branch acts on everything under it).
  const expand = useCallback((ids: Iterable<number>) => {
    const out: number[] = [];
    for (const id of ids) { if (tree) out.push(...tree.subtree(id)); else out.push(id); }
    return out;
  }, [tree]);
  const selected = useMemo(() => (selectedDb === null ? [] : expand([selectedDb])), [selectedDb, expand]);
  const highlighted = useMemo(() => expand(highlightIds ?? []), [highlightIds, expand]);
  const hidden = useMemo(() => expand(hiddenNodes), [hiddenNodes, expand]);
  useEffect(() => { viewerRef.current?.setStates(selected, highlighted, hidden); }, [selected, highlighted, hidden]);
  // Colour mode → per-object paint under the states (again for each opened model: its tree arrives after the tiles).
  const painted = useMemo(() => (tree ? paintFor(tree, colorMode) : null), [tree, colorMode]);
  useEffect(() => { viewerRef.current?.setPaint(painted?.paint ?? null); }, [painted]);

  /** Per-object boxes (objects.bin, tileset frame) for zooming; loaded on first use. */
  const zoomTo = useCallback(async (ids: number[]) => {
    const url = urlsRef.current?.['objects.bin'];
    if (!url || !ids.length) return;
    boxesRef.current ??= fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(b => new Float32Array(b));
    try {
      const boxes = await boxesRef.current;
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const id of expand(ids)) {
        if (id * 6 + 5 >= boxes.length || Number.isNaN(boxes[id * 6])) continue;
        for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], boxes[id * 6 + a]); box[a + 3] = Math.max(box[a + 3], boxes[id * 6 + 3 + a]); }
      }
      if (box.every(Number.isFinite)) viewerRef.current?.frameBox(box);
      else setStatus('선택한 객체의 위치 정보가 없습니다.');
    } catch (e) { boxesRef.current = null; setStatus(`위치 정보를 불러오지 못했습니다: ${errMessage(e)}`); }
  }, [expand]);

  // Click (not drag) selects the object under the pointer; double-click flies toward the clicked point.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    const onUp = (e: PointerEvent) => {
      const start = down; down = null;
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 500) return;
      const rect = canvas.getBoundingClientRect();
      const hit = viewerRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top);
      const id = hit?.dbId || null;
      setSelectedDb(id); setRevealDb(id);
    };
    const onDouble = (e: MouseEvent) => {
      const viewer = viewerRef.current, rect = canvas.getBoundingClientRect();
      const hit = viewer?.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (!viewer || !hit) return;
      const eye = viewer.camera.position.clone().lerp(hit.point, 0.6);
      viewer.lookAt(eye, hit.point);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDouble);
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('dblclick', onDouble); };
  }, []);

  // Escape clears the selection (up close there may be no empty spot left to click), unless a dialog or a text field
  // takes it (the search box clears itself on Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || dialogOpen()) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)));
      if (!typing) setSelectedDb(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openModel = useCallback(async (f: PickedAccFile) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!f.accUrn) { setStatus('이 파일은 아직 APS 파생(URN)이 없습니다.'); return; }
    setBusy(true); setStatus(`불러오는 중… ${f.name}`); setModelName(f.name); setMissing(null);
    setSelectedDb(null); setRevealDb(null); setHiddenNodes(new Set()); setHighlightIds(null);
    index.reset(); boxesRef.current = null; urlsRef.current = null;
    try {
      const headers = await authHeaders();
      const urn = encodeURIComponent(f.accUrn);
      const [stateRes, tilesRes] = await Promise.all([fetch(`/api/aps-convert?urn=${urn}`, { headers }), fetch(`/api/aps-convert?urn=${urn}&tiles3d=1`, { headers })]);
      const tiles = await readApiJson<{ urls?: Record<string, string>; builtAt?: string; expiresIn?: number; error?: string; missing?: boolean }>(tilesRes);
      const state = await readApiJson<{ meta?: MetaInfo; tiles?: unknown[] }>(stateRes);
      if (!tilesRes.ok || !tiles.urls?.['tileset.json']) {
        if (tiles.missing) {
          const converted = Array.isArray(state.tiles) && state.tiles.length > 0;
          setMissing({ file: f, converted });
          setStatus(converted ? `${f.name} · 2차 화면용 타일이 아직 없습니다.` : `${f.name} · 아직 변환되지 않은 모델입니다.`);
        } else setStatus(tiles.error ?? '2차 화면용 타일을 불러오지 못했습니다.');
        return;
      }
      urlsRef.current = tiles.urls;
      renewAt.current = { urn: f.accUrn, at: Date.now() + Math.max(60, (tiles.expiresIn ?? 14400) - 900) * 1000 };
      viewer.open(tiles.urls, (state.meta?.objects ?? 0) + 1);
      void index.open(f.accUrn, state.meta);
      setStatus(`${f.name} · 3D Tiles ${Object.keys(tiles.urls).length.toLocaleString()}개 파일${tiles.builtAt ? ` · 생성 ${tiles.builtAt.slice(0, 10)}` : ''}`);
    } catch (e) { setStatus(`열기 실패: ${errMessage(e)}`); }
    finally { setBusy(false); }
  }, [index]);

  // Signed tile URLs last 4 h: renew them 15 min early so a long session keeps loading tiles.
  useEffect(() => {
    const timer = setInterval(async () => {
      const due = renewAt.current;
      if (!due || Date.now() < due.at) return;
      renewAt.current = null;
      try {
        const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(due.urn)}&tiles3d=1`, { headers: await authHeaders() });
        const next = await readApiJson<{ urls?: Record<string, string>; expiresIn?: number }>(r);
        if (!r.ok || !next.urls) throw new Error('renew');
        Object.assign(urlsRef.current ?? {}, next.urls);
        viewerRef.current?.updateUrls(next.urls);
        renewAt.current = { urn: due.urn, at: Date.now() + Math.max(60, (next.expiresIn ?? 14400) - 900) * 1000 };
      } catch { renewAt.current = { urn: due.urn, at: Date.now() + 60_000 }; }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  /** Project admins: build this model's tiles (Actions job, ≈10–20 min), then open it when the job succeeds. */
  const buildTiles = useCallback(async () => {
    if (!missing?.converted || job) return;
    setJob({ since: new Date().toISOString(), note: '2차 화면 타일 생성 요청 중…' });
    try {
      const r = await fetch(`/api/r2-motion?job=tiles3d&projectId=${encodeURIComponent(projectId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ urn: missing.file.accUrn }),
      });
      const result = await readApiJson<{ requestedAt?: string; error?: string }>(r);
      if (!r.ok) throw new Error(result.error ?? '요청 실패');
      setJob({ since: result.requestedAt ?? new Date().toISOString(), note: '2차 화면 타일 생성 중 · 보통 10~20분 걸리며, 끝나면 자동으로 엽니다.' });
    } catch (e) { setJob(null); setStatus(`타일 생성 요청 실패: ${errMessage(e)}`); }
  }, [job, missing, projectId]);
  useEffect(() => {
    if (!job || !missing) return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/r2-motion?job=tiles3d&projectId=${encodeURIComponent(projectId)}&since=${encodeURIComponent(job.since)}`, { headers: await authHeaders() });
        const result = await readApiJson<{ state?: string; error?: string }>(r);
        if (!r.ok) throw new Error(result.error ?? '상태 조회 실패');
        if (result.state === 'success') { setJob(null); void openModel(missing.file); }
        else if (result.state === 'failed') { setJob(null); setStatus('타일 생성 실패 · 기존 모델 파일은 그대로입니다.'); }
      } catch { /* keep polling: a transient error must not drop the job */ }
    }, 20_000);
    return () => clearInterval(timer);
  }, [job, missing, openModel, projectId]);

  /** High-quality still of the current view (2× resolution, finer levels loaded first) saved as a PNG. */
  const capture = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || capturing) return;
    setCapturing(true);
    setStatus('고화질 캡처: 세밀한 단계를 불러오는 중…');
    try {
      const blob = await viewer.capture({ onProgress: p => setStatus(`고화질 캡처: 세밀한 단계를 불러오는 중 ${p.seconds}초 · 남은 타일 ${p.loading}개`) });
      const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
      const name = `${(modelName || '3D').replace(/\.[^.]+$/, '')}_${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.png`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(`고화질 캡처 저장: ${name}`);
    } catch (e) { setStatus(`고화질 캡처 실패: ${errMessage(e)}`); }
    finally { setCapturing(false); }
  }, [capturing, modelName]);

  const toggleNode = useCallback((id: number, visible: boolean) => {
    setHiddenNodes(prev => {
      const next = new Set(prev);
      if (visible) { next.delete(id); if (tree) for (const d of tree.subtree(id)) next.delete(d); } else next.add(id);
      return next;
    });
  }, [tree]);
  const selectNode = useCallback((id: number, zoom: boolean) => {
    setSelectedDb(id);
    if (zoom) void zoomTo([id]);
  }, [zoomTo]);

  const statsText = stats && [
    `${PROFILES[stats.tier].label} · 오차 ${stats.errorTarget}px`,
    `${stats.fps}fps · 드로콜 ${stats.drawCalls} · 삼각형 ${stats.triangles.toLocaleString()}`,
    `타일 표시 ${stats.tilesVisible} · 로드 ${stats.tilesLoaded} · 다운로드 ${stats.downloading} · 해석 ${stats.parsing}${stats.failed ? ` · 실패 ${stats.failed}` : ''}`,
    `캐시 ${stats.cacheMB}MB (화면 ${stats.usedMB}MB)${stats.cacheHits ? ` · 저장본 ${stats.cacheHits}` : ''}${stats.heapMB !== null ? ` · 힙 ${stats.heapMB}MB` : ''}`,
    stats.firstFrameMs !== null ? `첫 화면 ${(stats.firstFrameMs / 1000).toFixed(1)}s${stats.settledMs !== null ? ` · 안정 ${(stats.settledMs / 1000).toFixed(1)}s` : ''}` : '',
  ].filter(Boolean).join(' · ');
  const statsShort = stats && `${PROFILES[stats.tier].label} · ${stats.errorTarget}px · ${stats.fps}fps · 삼각형 ${stats.triangles.toLocaleString()}`;

  return (
    <div className="threed-test threed-test--v2">
      <div className="threed-test__note">
        <UiIcon name="cube" size={16} />
        <span>
          <strong>3D뷰 (신규 테스트 2차)</strong> — 엔진 <strong>three.js + 3D Tiles</strong>(표준 계층형 타일, 화면 크기 기반 단계 선택).
          기존 화면과 같은 모델을 비교하는 시제품입니다. 기기 등급에 따라 그리는 양을 자동으로 조절합니다.
        </span>
      </div>
      <div className="threed-test__viewer">
        <div className="viewer-bar threed-test__bar">
          {/* The tools: in line on wide screens, one scrolling row on phones (status on its own line below). */}
          <div className="threed-test__tools">
          <button className="btn btn--sm btn--primary" onClick={() => setPickerOpen(true)} disabled={busy || !!initError} aria-label="ACC에서 열기">
            <UiIcon name="folder" size={14} /> <span className="threed-test__wide">ACC에서 </span>열기
          </button>
          <button className="btn btn--sm" onClick={() => viewerRef.current?.frameAll()} disabled={!modelName}>전체 맞춤</button>
          <button className="btn btn--sm" onClick={() => selectedDb !== null && void zoomTo([selectedDb])} disabled={selectedDb === null}
            title="선택한 객체로 확대 (선택 해제: 빈 곳 클릭 또는 Esc)">선택 확대</button>
          <button className={`btn btn--sm${terrainOn ? ' btn--primary' : ''}`} disabled={!modelName} title="지형(항공사진) 표시"
            onClick={() => { const next = !terrainOn; setTerrainOn(next); viewerRef.current?.setTerrainVisible(next); }}>지형</button>
          <button className="btn btn--sm" disabled={!modelName || capturing} onClick={() => void capture()}
            title="지금 화면을 2배 해상도로, 멀리 있는 부분까지 세밀한 단계를 불러온 뒤 PNG 로 저장">{capturing ? '캡처 중…' : '고화질 캡처'}</button>
          <label className="threed-test2__tier" title="기기 등급: 화면 오차(px)와 메모리 상한을 정합니다">
            기기
            <select value={tier} onChange={e => {
              const value = e.target.value as DeviceTier | 'auto';
              setTier(value);
              const viewer = viewerRef.current;
              viewer?.setTier(value === 'auto' ? viewer.detectedTier : value);
            }}>
              <option value="auto">자동{stats ? ` (${PROFILES[stats.tier].label})` : ''}</option>
              <option value="high">{PROFILES.high.label}</option>
              <option value="pc">{PROFILES.pc.label}</option>
              <option value="mobile">{PROFILES.mobile.label}</option>
            </select>
          </label>
          <label className="threed-test2__tier" title="화질: 높을수록 멀리 있는 부분도 세밀한 단계로 그리고 메모리를 더 씁니다">
            화질
            <select value={quality} onChange={e => {
              const value = e.target.value as Quality;
              setQuality(value);
              viewerRef.current?.setQuality(value);
              try { localStorage.setItem(QUALITY_KEY, value); } catch { /* private mode */ }
            }}>
              {(Object.keys(QUALITIES) as Quality[]).map(q => <option key={q} value={q}>{QUALITIES[q].label}</option>)}
            </select>
          </label>
          <button className={`btn btn--sm${outlines ? ' btn--primary' : ''}`} aria-pressed={outlines}
            title="객체 사이 경계선: 붙어 있거나 겹친 같은 색 구조물을 구분합니다"
            onClick={() => { const next = !outlines; setOutlines(next); viewerRef.current?.setOutlines(next); remember(OUTLINE_KEY, next ? '1' : '0'); }}>외곽선</button>
          <label className="threed-test2__tier" title="색 구분: 파일별 또는 분류(Revit 범주·도면층)별로 칠합니다">
            색
            <select value={colorMode} onChange={e => { const m = e.target.value as ColorMode; setColorMode(m); remember(COLOR_KEY, m); }}>
              {(Object.keys(COLOR_MODES) as ColorMode[]).map(m => <option key={m} value={m}>{COLOR_MODES[m]}</option>)}
            </select>
          </label>
          {tree && (
            <>
              <button className={`btn btn--sm${treeOpen ? ' btn--primary' : ''}`} onClick={() => { setTreeOpen(o => !o); if (narrowScreen()) setPropsOpen(false); }}>모델 트리</button>
              <button className={`btn btn--sm${propsOpen ? ' btn--primary' : ''}`} onClick={() => { setPropsOpen(o => !o); if (narrowScreen()) setTreeOpen(false); }}>속성</button>
            </>
          )}
          </div>
          {index.note && <span className="muted threed-test__model">{index.note}</span>}
          <div className="spacer" />
          {status && <span className="muted threed-test2__status" title={status}>{status}</span>}
        </div>
        <div className="threed-test__viewport">
          <canvas ref={canvasRef} className="threed-test__canvas" />
          {missing && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              {missing.converted ? (
                <>
                  <p><strong>{missing.file.name}</strong> 은(는) 2차 화면용 타일이 아직 없습니다.</p>
                  <p className="threed-test__empty-sub">2차 화면은 시제품이라 타일을 만든 모델만 열립니다. 변환된 모델로부터 만들며 보통 10~20분 걸립니다.</p>
                  {job ? <p className="threed-test__empty-sub">{job.note}</p>
                    : canManage ? <button className="btn btn--primary btn--sm" onClick={() => void buildTiles()}>2차 타일 만들기</button>
                      : <p className="threed-test__empty-sub">프로젝트 관리자가 이 화면에서 만들 수 있습니다.</p>}
                </>
              ) : (
                <>
                  <p><strong>{missing.file.name}</strong> 은(는) 아직 변환되지 않은 모델입니다.</p>
                  <p className="threed-test__empty-sub">먼저 「3D뷰 (신규 테스트)」에서 이 모델을 열어 변환한 뒤, 여기서 2차 타일을 만들 수 있습니다.</p>
                </>
              )}
            </div>
          )}
          {initError && (
            <div className="threed-test__empty">
              <h3>3D 화면을 시작하지 못했습니다</h3>
              <p>{initError}</p>
            </div>
          )}
          {!modelName && !initError && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              <p>상단 <em>ACC에서 열기</em>로 모델을 여세요. (2차 엔진용 타일이 생성된 모델만 열립니다)</p>
            </div>
          )}
          {tree && treeOpen && (
            <aside className="threed-test__panel threed-test__panel--left" aria-label="모델 트리">
              <div className="threed-test__panel-h">
                <strong>모델 트리</strong>
                <span className="muted">{(tree.n - 1).toLocaleString()}개 객체</span>
                <div className="spacer" />
                <button type="button" className="ic-only" onClick={() => setTreeOpen(false)} aria-label="모델 트리 닫기">✕</button>
              </div>
              <ModelTreePanel tree={tree} hiddenNodes={hiddenNodes} selected={selectedDb} reveal={revealDb}
                onToggle={toggleNode} onSelect={id => { setRevealDb(null); selectNode(id, false); }} />
            </aside>
          )}
          {tree && propsOpen && (
            <aside className="threed-test__panel threed-test__panel--right" aria-label="속성">
              <div className="threed-test__panel-h">
                <strong>속성</strong>
                <div className="spacer" />
                <button type="button" className="ic-only" onClick={() => setPropsOpen(false)} aria-label="속성 닫기">✕</button>
              </div>
              <PropertyPanel tree={tree} selected={selectedDb} loadProps={index.loadProps} searchValues={index.searchValues}
                onSelect={(id, zoom) => { setRevealDb(id); selectNode(id, zoom); }}
                onZoom={ids => void zoomTo(ids)} onHighlight={setHighlightIds} />
            </aside>
          )}
          {painted && (
            <div className="threed-test2__legend" aria-label={`색 구분: ${COLOR_MODES[colorMode]}`}>
              {painted.legend.map(g => (
                <span key={g.name} className="threed-test2__legend-item" title={`${g.name} · 객체 ${g.count.toLocaleString()}개`}>
                  <i style={{ background: `rgb(${g.rgb.join(',')})` }} />{g.name}
                </span>
              ))}
              {painted.others > 0 && <span className="threed-test2__legend-item muted"><i style={{ background: 'rgb(176,176,176)' }} />기타 {painted.others}개</span>}
            </div>
          )}
          {statsText && (
            <button type="button" className={`threed-test2__stats${statsOpen ? ' is-open' : ''}`} onClick={() => setStatsOpen(o => !o)}
              aria-expanded={statsOpen} title="성능 표시 (좁은 화면에서는 눌러서 펼침)">
              <span className="threed-test2__stats-full">{statsText}</span>
              <span className="threed-test2__stats-short">{statsShort}</span>
            </button>
          )}
        </div>
      </div>
      {pickerOpen && (
        <AccFilePicker projectId={projectId} canEdit={canEdit} title="3D 모델 열기" actionLabel="열기" accept={isAccModel}
          onClose={() => setPickerOpen(false)} onPick={f => { setPickerOpen(false); void openModel(f); }} />
      )}
    </div>
  );
}

export default ThreeDTest2;
