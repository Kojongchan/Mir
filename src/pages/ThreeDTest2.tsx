import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { listIssues, createIssue, logIssueEvent, type Issue } from '../lib/issues';
import { listIssueCategories, type IssueCategory } from '../lib/issueCategories';
import { addIssueViewpoint } from '../lib/issueViewpoints';
import { MirIssueForm, MirIssuePins, MirIssuePopup, isMirView, type MirViewState } from '../components/model/MirIssueLayer';
import { MirClashPanel } from '../components/model/MirClashPanel';
import { MirMarkupEditor, MirMeasureLayer, MirViewpointPanel, loadHomeView, type Measure } from '../components/model/MirViewTools';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { useProjectRole } from '../auth/useProjectRole';
import { supabase } from '../lib/supabase';
import { accFetch, isAccModel } from '../lib/aps';
import { getProjectAcc } from '../lib/api';
import { openOrder, type OpenCandidate } from '../lib/accVersions';
import { errMessage, readApiJson } from '../lib/errors';
import { dialogOpen } from '../lib/useEscapeKey';
import { UiIcon } from '../components/icons/UiIcon';
import { ModelTreePanel } from '../components/model/ModelTreePanel';
import { PropertyPanel } from '../components/model/PropertyPanel';
import { useModelIndex, type MetaInfo } from '../viewer/useModelIndex';
import { TilesViewer, type ViewerStats, type WalkInfo } from '../viewer2/TilesViewer';
import { PROFILES, QUALITIES, type DeviceTier, type Quality } from '../viewer2/deviceProfile';
import { COLOR_MODES, paintFor, type ColorMode } from '../viewer2/colorModes';
import { readSignedTiles, saveSignedTiles, type SignedTiles } from '../viewer2/signedTiles';

const authHeaders = async () => {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ''}` };
};

/**
 * 3D뷰 (신규 테스트 2차) — second viewer engine prototype (decision D23, docs/3D뷰_2차_엔진.md): the model's 3D Tiles
 * (built by Actions diag_only=tiles3d, startable here by project admins) on three.js + 3DTilesRendererJS, next to the
 * xeokit page for comparison. variant "svf" is 3D뷰 (신규 테스트 3차): the same viewer on the trial tileset whose
 * original level comes from the SVF's exact coordinates (diag_options svf=1, built from Actions only).
 */
const narrowScreen = () => window.matchMedia('(max-width: 900px)').matches;
/** The viewer's picture quality is remembered in this browser. */
const QUALITY_KEY = 'mir.viewer2.quality';
const storedQuality = (): Quality => {
  try { const q = localStorage.getItem(QUALITY_KEY); return q && q in QUALITIES ? (q as Quality) : 'standard'; } catch { return 'standard'; }
};

/** Outlines between objects (on unless turned off) and the colour mode, remembered in this browser. */
const OUTLINE_KEY = 'mir.viewer2.outlines', COLOR_KEY = 'mir.viewer2.colorMode', STATS_KEY = 'mir.viewer2.stats';
const storedOutlines = () => { try { return localStorage.getItem(OUTLINE_KEY) !== '0'; } catch { return true; } };
const storedColorMode = (): ColorMode => {
  try { const m = localStorage.getItem(COLOR_KEY); return m && m in COLOR_MODES ? (m as ColorMode) : 'model'; } catch { return 'model'; }
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

/** A click on one object (null: empty space): it alone, or with Ctrl/Shift/⌘ toggled in the current selection. */
function choose(prev: readonly number[], id: number | null, additive: boolean): readonly number[] {
  if (!additive) return id ? [id] : [];
  if (!id) return prev;
  return prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
}
/** Visibility changes kept for 되돌리기 (Ctrl+Z). */
const UNDO_STEPS = 30;
type Visibility = { hidden: ReadonlySet<number>; past: ReadonlySet<number>[] };
const NO_HIDDEN: Visibility = { hidden: new Set(), past: [] };

/** Why the project's model cannot be shown in this engine (통합모델(3D) then opens the Autodesk viewer instead). */
export type ViewerUnavailable = 'no-mapping' | 'no-model' | 'no-tiles';

/** 통합모델(3D) status line: which version opened, and why not the newest when its tiles are not built yet. */
function versionNote(opened: OpenCandidate, latest: OpenCandidate | undefined): string {
  const v = (n: number | null) => (n ? `V${n}` : '지정한 버전');
  if (!latest || latest.urn === opened.urn) return opened.versionNumber ? `최신 버전(${v(opened.versionNumber)})` : '';
  return `최신 버전(${v(latest.versionNumber)})은 자체 엔진 타일 준비 전이라 ${v(opened.versionNumber)}을 표시합니다`;
}

/**
 * `project`: the project's 통합모델(3D) page — opens the model the admin designated (its newest version that has
 * tiles), without the test notes; `onUnavailable` when there is nothing to show here.
 */
export function ThreeDTest2({ variant, project = false, purpose = 'model', onUnavailable }: {
  variant?: 'svf'; project?: boolean;
  /** Which designated model a project page opens: 통합모델(3D) (acc_default) or 간섭검토 (acc_clash, with the clash panel). */
  purpose?: 'model' | 'clash';
  onUnavailable?: (why: ViewerUnavailable) => void;
} = {}) {
  const { projectId = '' } = useParams();
  const tilesQuery = variant ? `tiles3d=1&variant=${variant}` : 'tiles3d=1';
  const tilesName = project ? '자체 엔진용 타일' : variant ? '3차 화면용(SVF 정밀) 타일' : '2차 화면용 타일';
  const { canEdit, canManage } = useProjectRole(projectId);
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;
  const [params] = useSearchParams();
  const location = useLocation();
  // Links from 협업·이슈: an object to show (?focusGlobalId=) or a viewpoint saved in this engine.
  const focusGlobalId = project ? params.get('focusGlobalId') ?? '' : '';
  // 간섭 이슈의 「위치 보기」: 두 부재(?focusClashA=&focusClashB=).
  const focusClashA = project ? params.get('focusClashA') ?? '' : '', focusClashB = project ? params.get('focusClashB') ?? '' : '';
  const [clashOpen, setClashOpen] = useState(project && purpose === 'clash');
  // 간섭 결과 보기: A 초록·B 빨강, ghost = 나머지 반투명(아니면 그대로 표시).
  const [clashView, setClashView] = useState<{ a: number; b: number; ghost: boolean } | null>(null);
  const linkedView = project ? (location.state as { applyApsState?: unknown } | null)?.applyApsState : undefined;
  const linkedViewRef = useRef<MirViewState | null>(isMirView(linkedView) ? linkedView : null);
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
  // Walk mode (3차): on with its speed, gravity and collision, or null; `placing`: waiting for the click on where to start.
  const [walk, setWalk] = useState<WalkInfo | null>(null);
  const [placing, setPlacing] = useState(false);
  // The height (cm) as typed: "1" and "18" on the way to 180 are out of range and were put back to the height at once.
  const [heightDraft, setHeightDraft] = useState<string | null>(null);
  const heightCancelled = useRef(false), heightBefore = useRef(0);
  const placingRef = useRef(false);
  useEffect(() => { placingRef.current = placing; }, [placing]);
  // 통합모델(3D) 도구: 홈뷰·관측점 창, 거리 측정(두 점 클릭), 단면(축 평면 / 선택 상자), 마크업(지금 화면에 그리기).
  const [vpOpen, setVpOpen] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const measuringRef = useRef(false);
  useEffect(() => { measuringRef.current = measuring; }, [measuring]);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [measureFrom, setMeasureFrom] = useState<{ p: [number, number, number]; z: number } | null>(null);
  const measureFromRef = useRef<{ p: [number, number, number]; z: number } | null>(null);
  useEffect(() => { measureFromRef.current = measureFrom; }, [measureFrom]);
  type Section = { axis: 0 | 1 | 2; t: number; flip: boolean } | { box: [number, number, number, number, number, number] };
  const [section, setSection] = useState<Section | null>(null);
  const [markupImage, setMarkupImage] = useState<string | null>(null);
  // The view the designated model starts from (a linked viewpoint, else this browser's home view).
  const startViewRef = useRef<{ position: [number, number, number]; target: [number, number, number] } | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>(storedColorMode);
  // Selected objects in the order picked; the last one is shown in the tree and (alone) in the property panel.
  const [selection, setSelection] = useState<readonly number[]>([]);
  const primary = selection.length ? selection[selection.length - 1] : null;
  const chosen = useMemo(() => new Set(selection), [selection]);
  const [revealDb, setRevealDb] = useState<number | null>(null);
  // Hidden tree branches (the checkboxes, 숨기기, 선택만 보기) and the earlier states for 되돌리기.
  const [visibility, setVisibility] = useState<Visibility>(NO_HIDDEN);
  const hiddenNodes = visibility.hidden;
  const [highlightIds, setHighlightIds] = useState<number[] | null>(null);
  const [statsOpen, setStatsOpen] = useState(false); // narrow screens: one summary line until tapped
  // The performance line: on in the test pages, off in 통합모델(3D) unless turned on (보기 설정 > 성능 표시).
  const [statsShown, setStatsShown] = useState(() => { try { const v = localStorage.getItem(STATS_KEY); return v === null ? !project : v === '1'; } catch { return !project; } });
  const settingsRef = useRef<HTMLDetailsElement>(null);
  // The settings drop-down closes on a click elsewhere.
  useEffect(() => {
    const close = (e: PointerEvent) => { const d = settingsRef.current; if (d?.open && !d.contains(e.target as Node)) d.open = false; };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  // Phones and narrow tablets: panels start closed and one at a time (side by side they cover the view).
  // 간섭검토 starts with its own window only (the tree and properties stay one click away).
  const [treeOpen, setTreeOpen] = useState(() => !narrowScreen() && purpose !== 'clash');
  const [propsOpen, setPropsOpen] = useState(() => !narrowScreen() && purpose !== 'clash');

  useEffect(() => {
    if (!canvasRef.current) return;
    let viewer: TilesViewer;
    try { viewer = new TilesViewer(canvasRef.current); }
    catch (e) { setInitError(errMessage(e)); return; }
    viewer.setQuality(storedQuality());
    viewer.setOutlines(storedOutlines());
    viewer.onStats = next => setStats(prev => prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    viewer.onWalk = info => { setWalk(info.on ? info : null); if (info.on) setPlacing(false); };
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
    // One push per id: spreading a file's subtree (hundreds of thousands) as arguments overflows the call stack.
    for (const id of ids) { if (tree) for (const d of tree.subtree(id)) out.push(d); else out.push(id); }
    return out;
  }, [tree]);
  const selected = useMemo(() => expand(selection), [selection, expand]);
  const highlighted = useMemo(() => expand(highlightIds ?? []), [highlightIds, expand]);
  const hidden = useMemo(() => expand(hiddenNodes), [hiddenNodes, expand]);
  useEffect(() => { viewerRef.current?.setStates(selected, highlighted, hidden); }, [selected, highlighted, hidden]);
  // Colour mode → per-object paint under the states (again for each opened model: its tree arrives after the tiles).
  const painted = useMemo(() => (tree ? paintFor(tree, colorMode) : null), [tree, colorMode]);
  const paintWithClash = useMemo(() => {
    const base = painted?.paint ?? null;
    if (!clashView) return base;
    const size = Math.max(base?.length ?? 0, (Math.max(clashView.a, clashView.b) + 1) * 4);
    const out = new Uint8Array(size);
    if (base) out.set(base);
    out.set([22, 163, 74, 255], clashView.a * 4); // A 초록
    out.set([220, 38, 38, 255], clashView.b * 4); // B 빨강
    return out;
  }, [painted, clashView]);
  useEffect(() => { viewerRef.current?.setPaint(paintWithClash); }, [paintWithClash]);
  useEffect(() => { viewerRef.current?.setGhost(clashView?.ghost ? [clashView.a, clashView.b] : null); }, [clashView]);
  useEffect(() => { setClashView(null); }, [tree]);

  /** Per-object boxes (objects.bin, tileset frame) for zooming and issue pins; loaded on first use. */
  const loadBoxes = useCallback((): Promise<Float32Array> | null => {
    const url = urlsRef.current?.['objects.bin'];
    if (!url) return null;
    boxesRef.current ??= fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(b => new Float32Array(b));
    return boxesRef.current;
  }, []);
  const zoomTo = useCallback(async (ids: number[], animate = true) => {
    const loading = loadBoxes();
    if (!loading || !ids.length) return;
    try {
      const boxes = await loading;
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const id of expand(ids)) {
        if (id * 6 + 5 >= boxes.length || Number.isNaN(boxes[id * 6])) continue;
        for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], boxes[id * 6 + a]); box[a + 3] = Math.max(box[a + 3], boxes[id * 6 + 3 + a]); }
      }
      if (box.every(Number.isFinite)) viewerRef.current?.frameBox(box, animate);
      else setStatus('선택한 객체의 위치 정보가 없습니다.');
    } catch (e) { boxesRef.current = null; setStatus(`위치 정보를 불러오지 못했습니다: ${errMessage(e)}`); }
  }, [expand, loadBoxes]);

  // Click (not drag) selects the object under the pointer — or, choosing where a walk starts, puts the person there;
  // double-click flies toward the clicked point.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    const onUp = (e: PointerEvent) => {
      const start = down; down = null;
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 500) return;
      const rect = canvas.getBoundingClientRect();
      if (measuringRef.current) {
        const viewer = viewerRef.current;
        const hit = viewer?.pick(e.clientX - rect.left, e.clientY - rect.top);
        if (!viewer || !hit) { setStatus('측정: 모델 위를 클릭하세요.'); return; }
        const p: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
        const z = viewer.sceneToModel(p[0], p[1], p[2])[2];
        const from = measureFromRef.current;
        if (!from) setMeasureFrom({ p, z });
        else { setMeasures(m => [...m, { a: from.p, b: p, za: from.z, zb: z }]); setMeasureFrom(null); }
        return;
      }
      if (placingRef.current) {
        if (!viewerRef.current?.startWalkAt(e.clientX - rect.left, e.clientY - rect.top)) setStatus('그곳에는 설 곳이 없습니다 — 모델 위를 클릭하세요.');
        return;
      }
      const hit = viewerRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top);
      const id = hit?.dbId || null, additive = e.ctrlKey || e.metaKey || e.shiftKey;
      setSelection(prev => choose(prev, id, additive));
      if (id || !additive) setRevealDb(id);
    };
    const onDouble = (e: MouseEvent) => {
      const viewer = viewerRef.current, rect = canvas.getBoundingClientRect();
      if (!viewer || viewer.walking || placingRef.current) return; // walking: the person stays where it stands
      const hit = viewer.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      const eye = viewer.camera.position.clone().lerp(hit.point, 0.6);
      viewer.lookAt(eye, hit.point);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDouble);
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('dblclick', onDouble); };
  }, []);

  // Keys, unless a dialog or a text field takes them (the search box clears itself on Escape): Escape stops choosing
  // where a walk starts, else clears the selection (up close there may be no empty spot left to click), H hides it, I shows only it, Shift+H shows
  // everything, Ctrl+Z undoes the last visibility change. Physical keys, so a Korean keyboard layout works too.
  const keyActions = useRef<{ hide: () => void; isolate: () => void; showAll: () => void; undo: () => void } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || e.repeat || dialogOpen()) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)));
      const actions = keyActions.current;
      if (typing || !actions) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (placingRef.current) setPlacing(false);
        else if (measureFromRef.current) setMeasureFrom(null);
        else if (measuringRef.current) setMeasuring(false);
        else setSelection(prev => (prev.length ? [] : prev));
      }
      else if (e.code === 'KeyZ' && mod && !e.shiftKey && !e.altKey) { e.preventDefault(); actions.undo(); }
      else if (mod || e.altKey) return;
      else if (e.code === 'KeyH') { if (e.shiftKey) actions.showAll(); else actions.hide(); }
      else if (e.code === 'KeyI' && !e.shiftKey) actions.isolate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * The model's signed tile list from the server (the tree comes along; an older API answer without it is completed
   * from the model state), kept in this browser for opening again; null with the reason shown when there is none.
   */
  const fetchTiles = useCallback(async (f: PickedAccFile, scope: string, quiet = false): Promise<SignedTiles | null> => {
    const headers = await authHeaders();
    const urn = encodeURIComponent(f.accUrn ?? '');
    // The ACC project lets the server recognise the same file uploaded elsewhere and share its tiles.
    const project = f.accProjectId ? `&project=${encodeURIComponent(f.accProjectId)}` : '';
    const r = await fetch(`/api/aps-convert?urn=${urn}&${tilesQuery}${project}`, { headers });
    const tiles = await readApiJson<{ run?: string; urls?: Record<string, string>; builtAt?: string; expiresIn?: number; meta?: MetaInfo; error?: string; missing?: boolean }>(r);
    const ok = r.ok && !!tiles.urls?.['tileset.json'];
    if (!ok && quiet && tiles.missing) return null;
    let meta = tiles.meta, converted = false;
    if ((!ok && tiles.missing) || (ok && !meta)) {
      const state = await readApiJson<{ meta?: MetaInfo; tiles?: unknown[] }>(await fetch(`/api/aps-convert?urn=${urn}`, { headers }));
      meta ??= state.meta;
      converted = Array.isArray(state.tiles) && state.tiles.length > 0;
    }
    if (!ok || !tiles.urls) {
      if (tiles.missing) {
        setMissing({ file: f, converted });
        setStatus(converted ? `${f.name} · ${tilesName}이 아직 없습니다.` : `${f.name} · 아직 변환되지 않은 모델입니다.`);
      } else setStatus(tiles.error ?? `${tilesName}을 불러오지 못했습니다.`);
      return null;
    }
    const kept: SignedTiles = { run: tiles.run, builtAt: tiles.builtAt, urls: tiles.urls, meta, expiresAt: Date.now() + (tiles.expiresIn ?? 14400) * 1000 };
    // Kept only with the tree signed alongside (valid as long as the tiles); the model state's tree URL lasts 1 h.
    if (tiles.meta) void saveSignedTiles(scope, kept);
    return kept;
  }, [tilesQuery, tilesName]);

  /** Bumped per opened model: a list that arrives for an earlier one is dropped. */
  const openSeq = useRef(0);
  /** Opens a model; true once its tiles are shown. `quiet`: a model without tiles leaves the page as it was. */
  const openModel = useCallback(async (f: PickedAccFile, quiet = false): Promise<boolean> => {
    const viewer = viewerRef.current;
    if (!viewer) return false;
    if (!f.accUrn) { setStatus('이 파일은 아직 APS 파생(URN)이 없습니다.'); return false; }
    const seq = ++openSeq.current;
    const show = (t: SignedTiles) => {
      setSelection([]); setRevealDb(null); setVisibility(NO_HIDDEN); setHighlightIds(null);
      index.reset(); boxesRef.current = null;
      urlsRef.current = { ...t.urls };
      // Renewed 15 min before the URLs expire, so a long session keeps loading tiles.
      renewAt.current = { urn: f.accUrn!, at: Math.max(Date.now() + 60_000, t.expiresAt - 15 * 60_000) };
      if (startViewRef.current) { viewer.startView = startViewRef.current; startViewRef.current = null; }
      viewer.open(t.urls, (t.meta?.objects ?? 0) + 1);
      void index.open(f.accUrn!, t.meta);
      setStatus(project ? f.name : `${f.name} · 3D Tiles ${Object.keys(t.urls).length.toLocaleString()}개 파일${t.builtAt ? ` · 생성 ${t.builtAt.slice(0, 10)}` : ''}`);
    };
    setBusy(true); setStatus(`불러오는 중… ${f.name}`); if (!quiet) { setModelName(f.name); setMissing(null); }
    try {
      const { data } = await supabase.auth.getSession();
      const scope = `${data.session?.user.id ?? ''}|${tilesQuery}|${f.accUrn}`;
      const kept = await readSignedTiles(scope);
      if (kept && kept.expiresAt - Date.now() > 30 * 60_000) {
        // Opened before in this browser: at once from the kept list, a fresh one behind it (a newer build replaces
        // the view; the same build only renews the URLs).
        setModelName(f.name); setMissing(null);
        show(kept);
        setBusy(false);
        void fetchTiles(f, scope, true).catch(() => null).then(fresh => {
          if (!fresh || seq !== openSeq.current) return;
          if (fresh.run !== kept.run) { show(fresh); setStatus(s => `${s} · 새로 생성된 타일로 바꿨습니다`); return; }
          Object.assign(urlsRef.current ?? {}, fresh.urls);
          viewer.updateUrls(fresh.urls);
          renewAt.current = { urn: f.accUrn!, at: fresh.expiresAt - 15 * 60_000 };
        });
        return true;
      }
      const fresh = await fetchTiles(f, scope, quiet);
      if (!fresh || seq !== openSeq.current) return false;
      setSelection([]); setRevealDb(null); setVisibility(NO_HIDDEN); setHighlightIds(null);
      index.reset(); boxesRef.current = null; urlsRef.current = null;
      setModelName(f.name); setMissing(null);
      show(fresh);
      return true;
    } catch (e) { setStatus(`열기 실패: ${errMessage(e)}`); return false; }
    finally { if (seq === openSeq.current) setBusy(false); }
  }, [index, tilesQuery, fetchTiles, project]);

  // 통합모델(3D): the designated model opens by itself — the newest version that has tiles (a new version is shown
  // once its tiles are built), else the version the admin designated. Nothing to open here: onUnavailable.
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const [pinnedNote, setPinnedNote] = useState('');
  useEffect(() => {
    if (!project || initError) return;
    let cancelled = false;
    void (async () => {
      const acc = await getProjectAcc(projectId);
      if (cancelled) return;
      const clash = purpose === 'clash';
      const pinnedUrn = clash ? acc.acc_clash_urn : acc.acc_default_urn;
      const pinnedItem = clash ? acc.acc_clash_item_id : acc.acc_default_item_id;
      const pinnedName = clash ? acc.acc_clash_name : acc.acc_default_name;
      if (!acc.acc_project_id || !pinnedUrn) { unavailable.current?.(acc.acc_project_id ? 'no-model' : 'no-mapping'); return; }
      let order: OpenCandidate[] = [{ urn: pinnedUrn, versionNumber: null }];
      if (pinnedItem) {
        try {
          const r = await accFetch({ action: 'versions', project: acc.acc_project_id, item: pinnedItem });
          order = openOrder(pinnedUrn, r.versions ?? [], 5);
        } catch { /* the designated version */ }
      }
      const file: PickedAccFile = { accProjectId: acc.acc_project_id, accItemId: pinnedItem ?? '', accUrn: null,
        name: pinnedName || (clash ? '간섭 모델' : '통합모델'), size: null, folderId: null, folderIds: [], folderNames: [] };
      startViewRef.current = linkedViewRef.current ?? loadHomeView(`${projectId}:${purpose}`);
      linkedViewRef.current = null;
      for (const c of order) {
        if (cancelled) return;
        if (await openModel({ ...file, accUrn: c.urn }, true)) {
          if (!cancelled) setPinnedNote(versionNote(c, order[0]));
          return;
        }
      }
      if (!cancelled) { setStatus(''); unavailable.current?.('no-tiles'); }
    })().catch(e => { if (!cancelled) setStatus(`열기 실패: ${errMessage(e)}`); });
    return () => { cancelled = true; };
    // openModel changes with the model index; the designated model is opened once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectId, initError, purpose]);

  // Signed tile URLs last 9 h: renew them 15 min early so a long session keeps loading tiles (kept for reopening too).
  useEffect(() => {
    const timer = setInterval(async () => {
      const due = renewAt.current;
      if (!due || Date.now() < due.at) return;
      renewAt.current = null;
      try {
        const { data } = await supabase.auth.getSession();
        const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(due.urn)}&${tilesQuery}`, { headers: await authHeaders() });
        const next = await readApiJson<{ run?: string; urls?: Record<string, string>; builtAt?: string; expiresIn?: number; meta?: MetaInfo }>(r);
        if (!r.ok || !next.urls) throw new Error('renew');
        Object.assign(urlsRef.current ?? {}, next.urls);
        viewerRef.current?.updateUrls(next.urls);
        const expiresAt = Date.now() + (next.expiresIn ?? 14400) * 1000;
        renewAt.current = { urn: due.urn, at: expiresAt - 15 * 60_000 };
        if (next.meta) void saveSignedTiles(`${data.session?.user.id ?? ''}|${tilesQuery}|${due.urn}`, { run: next.run, builtAt: next.builtAt, urls: next.urls, meta: next.meta, expiresAt });
      } catch { renewAt.current = { urn: due.urn, at: Date.now() + 60_000 }; }
    }, 30_000);
    return () => clearInterval(timer);
  }, [tilesQuery]);

  // ── 이슈(통합모델(3D)): 핀·선택 객체에 이슈 만들기·위치 보기·뷰포인트 — 기존 뷰어와 같은 이슈 데이터 ──────────────
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueCats, setIssueCats] = useState<IssueCategory[]>([]);
  // global_id → dbId of the open model, and its object boxes (for the pins), resolved once the view has settled.
  const [anchors, setAnchors] = useState<ReadonlyMap<string, number>>(new Map());
  const [pinBoxes, setPinBoxes] = useState<Float32Array | null>(null);
  const [pinsOn, setPinsOn] = useState(true);
  const [popIssue, setPopIssue] = useState<Issue | null>(null);
  const [issueFormOpen, setIssueFormOpen] = useState(false);
  const reloadIssues = useCallback(() => { listIssues(projectId).then(setIssues).catch(() => {}); }, [projectId]);
  useEffect(() => {
    if (!project) return;
    reloadIssues();
    listIssueCategories(projectId).then(setIssueCats).catch(() => setIssueCats([]));
  }, [project, projectId, reloadIssues]);
  useEffect(() => { setAnchors(new Map()); setPinBoxes(null); setPopIssue(null); }, [tree]);
  const settled = !!stats && stats.settledMs !== null;
  const wantedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const it of issues) { if (it.global_id) ids.add(it.global_id); if (it.global_id_b) ids.add(it.global_id_b); }
    for (const x of [focusGlobalId, focusClashA, focusClashB]) if (x) ids.add(x);
    return [...ids].sort();
  }, [issues, focusGlobalId, focusClashA, focusClashB]);
  useEffect(() => {
    if (!project || !tree || !settled) return;
    const missingIds = wantedIds.filter(x => !anchors.has(x));
    if (!missingIds.length) return;
    let cancelled = false;
    void index.findExternal(missingIds).then(found => {
      if (cancelled || !found.size) return;
      setAnchors(prev => { const next = new Map(prev); for (const [x, id] of found) next.set(x, id); return next; });
    }).catch(() => {});
    void loadBoxes()?.then(b => { if (!cancelled) setPinBoxes(b); }).catch(() => {});
    return () => { cancelled = true; };
    // anchors only grows here; a model change clears it (above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tree, settled, wantedIds, index, loadBoxes]);

  /** 위치 보기: the issue's object (both, for a clash issue) selected and in view. */
  const focusIssue = useCallback((issue: Issue) => {
    const ids = [issue.global_id, issue.global_id_b].map(x => (x ? anchors.get(x) : undefined)).filter((x): x is number => x !== undefined);
    if (!ids.length) { setStatus('이 이슈의 객체를 지금 모델에서 찾지 못했습니다.'); return; }
    setSelection(ids); setRevealDb(ids[ids.length - 1]);
    void zoomTo(ids);
  }, [anchors, zoomTo]);

  // ?focusGlobalId= (협업·이슈 「위치 보기」): the object once it is found.
  const focusedLink = useRef('');
  useEffect(() => {
    if (!focusGlobalId || focusedLink.current === focusGlobalId) return;
    const id = anchors.get(focusGlobalId);
    if (id === undefined) return;
    focusedLink.current = focusGlobalId;
    setSelection([id]); setRevealDb(id);
    void zoomTo([id]);
  }, [focusGlobalId, anchors, zoomTo]);
  useEffect(() => {
    const key = `${focusClashA}|${focusClashB}`;
    if (!focusClashA || focusedLink.current === key) return;
    const ids = [anchors.get(focusClashA), anchors.get(focusClashB)].filter((x): x is number => x !== undefined);
    if (!ids.length) return;
    focusedLink.current = key;
    setSelection(ids); setRevealDb(ids[ids.length - 1]);
    void zoomTo(ids);
  }, [focusClashA, focusClashB, anchors, zoomTo]);
  // A viewpoint saved in this engine (협업·이슈 「3D에서 열기」) is the start view of the designated model (above).

  /** The view now (camera + snapshot) saved as a viewpoint of the issue — best effort, like the Autodesk viewer. */
  const saveViewFor = useCallback(async (issueId: string, title: string | null): Promise<boolean> => {
    const viewer = viewerRef.current;
    if (!viewer) return false;
    try {
      const blob = await viewer.snapshot(640);
      const snapshot = await new Promise<string | null>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      const cameraState: MirViewState = { engine: 'mir', ...viewer.getView() };
      await addIssueViewpoint({ issueId, projectId, title, cameraState, snapshot, authorName });
      await logIssueEvent(issueId, projectId, 'viewpoint_add', title, authorName);
      return true;
    } catch { return false; }
  }, [projectId, authorName]);

  const submitIssue = useCallback(async (form: { title: string; category_id: string; type: Issue['type'] }) => {
    const dbId = selection.length === 1 ? selection[0] : null;
    if (dbId === null) return;
    try {
      const ext = await index.externalOf(dbId);
      if (!ext) { setStatus('이 객체의 고유 ID(GlobalId)를 찾지 못해 이슈를 묶을 수 없습니다.'); setIssueFormOpen(false); return; }
      const issueId = await createIssue(projectId, { title: form.title, type: form.type, category_id: form.category_id || null, priority: 'normal', global_id: ext }, authorName);
      setAnchors(prev => new Map(prev).set(ext, dbId));
      void loadBoxes()?.then(setPinBoxes).catch(() => {});
      const saved = await saveViewFor(issueId, form.title);
      reloadIssues();
      setIssueFormOpen(false);
      setStatus(saved ? `이슈를 만들었습니다: ${form.title} (현재 뷰 저장)` : `이슈를 만들었습니다: ${form.title}`);
    } catch (e) { setStatus(`이슈 생성 실패: ${errMessage(e)}`); }
  }, [selection, index, projectId, authorName, loadBoxes, saveViewFor, reloadIssues]);

  // 단면 → the viewer's clipping planes (tileset frame). Axis plane: keeps the part below the position (뒤집기: above).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!section) { viewer.setSection([]); return; }
    if ('box' in section) {
      const b = section.box;
      viewer.setSection([0, 1, 2].flatMap(a => {
        const n = [0, 0, 0]; n[a] = 1;
        const lo = [0, 0, 0], hi = [0, 0, 0]; lo[a] = b[a]; hi[a] = b[a + 3];
        return [{ at: lo, normal: n }, { at: hi, normal: n.map(v => -v) }];
      }));
      return;
    }
    const box = viewer.structureBox();
    if (!box) return;
    const at = [0, 0, 0], n = [0, 0, 0];
    at[section.axis] = box[section.axis] + section.t * (box[section.axis + 3] - box[section.axis]);
    n[section.axis] = section.flip ? 1 : -1;
    viewer.setSection([{ at, normal: n }]);
  }, [section, tree]);
  /** 선택 상자 단면: the selected objects' box, 1 m wider on every side. */
  const sectionToSelection = useCallback(async () => {
    const loading = loadBoxes();
    if (!loading || !selection.length) return;
    const boxes = await loading;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const id of expand(selection)) {
      if (id * 6 + 5 >= boxes.length || Number.isNaN(boxes[id * 6])) continue;
      for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], boxes[id * 6 + a]); box[a + 3] = Math.max(box[a + 3], boxes[id * 6 + 3 + a]); }
    }
    if (!box.every(Number.isFinite)) { setStatus('선택한 객체의 위치 정보가 없습니다.'); return; }
    setSection({ box: [box[0] - 1, box[1] - 1, box[2] - 1, box[3] + 1, box[4] + 1, box[5] + 1] });
  }, [loadBoxes, selection, expand]);
  const openMarkup = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const blob = await viewer.snapshot(1920).catch(() => null);
    if (!blob) { setStatus('화면을 캡처하지 못했습니다.'); return; }
    const url = await new Promise<string | null>(resolve => { const r = new FileReader(); r.onload = () => resolve(typeof r.result === 'string' ? r.result : null); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
    if (url) setMarkupImage(url);
  }, []);

  /** 간섭 결과 한 건: 두 부재를 선택해 보여 준다. */
  const showClash = useCallback((a: number, b: number) => {
    setSelection([]); setRevealDb(b);
    setClashView(v => ({ a, b, ghost: v ? v.ghost : true }));
    void zoomTo([a, b]);
  }, [zoomTo]);
  /** 보고서용: 한 건을 비추고(바로, 애니메이션 없이) 타일이 다 들어온 뒤 한 장. */
  const captureClash = useCallback(async (a: number, b: number): Promise<string | null> => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    setSelection([]);
    setClashView({ a, b, ghost: true });
    await zoomTo([a, b], false);
    await viewer.settle(8000);
    const blob = await viewer.snapshot(900).catch(() => null);
    if (!blob) return null;
    return await new Promise<string | null>(resolve => { const r = new FileReader(); r.onload = () => resolve(typeof r.result === 'string' ? r.result : null); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
  }, [zoomTo]);
  /** The file (top-level node under the model root) an object belongs to — 보고서의 「분야」. */
  const fileOf = useCallback((id: number): string => {
    if (!tree) return '';
    const path = tree.path(id);
    // The model root (the integrated file) is not a 분야: the node below it is.
    const top = path.length > 1 && tree.roots.includes(path[0]) ? path[1] : path[0];
    return top === undefined ? '' : tree.name(top);
  }, [tree]);
  const snapshotUrl = useCallback(async (): Promise<string | null> => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    const blob = await viewer.snapshot(960);
    return await new Promise<string | null>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
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

  /** A visibility change, remembered for 되돌리기 (an unchanged set is not a step). */
  const changeHidden = useCallback((next: (prev: ReadonlySet<number>) => ReadonlySet<number>) => setVisibility(v => {
    const hidden = next(v.hidden);
    return hidden === v.hidden ? v : { hidden, past: [...v.past.slice(-(UNDO_STEPS - 1)), v.hidden] };
  }), []);
  const toggleNode = useCallback((id: number, visible: boolean) => changeHidden(prev => {
    const next = new Set(prev);
    if (visible) { next.delete(id); if (tree) for (const d of tree.subtree(id)) next.delete(d); } else next.add(id);
    return next;
  }), [tree, changeHidden]);
  /** 숨기기: the selected objects join the hidden ones (and are no longer selected). */
  const hideSelection = useCallback(() => {
    if (!selection.length) return;
    changeHidden(prev => new Set([...prev, ...selection]));
    setSelection([]);
  }, [selection, changeHidden]);
  /** 선택만 보기: everything else hidden, the selection shown even if it was hidden. */
  const isolateSelection = useCallback(() => {
    if (tree && selection.length) changeHidden(() => new Set(tree.hideAllBut(selection)));
  }, [tree, selection, changeHidden]);
  const showAll = useCallback(() => changeHidden(prev => (prev.size ? new Set() : prev)), [changeHidden]);
  const undoVisibility = useCallback(() => setVisibility(v => (v.past.length ? { hidden: v.past[v.past.length - 1], past: v.past.slice(0, -1) } : v)), []);
  keyActions.current = { hide: hideSelection, isolate: isolateSelection, showAll, undo: undoVisibility };
  const selectNode = useCallback((id: number, zoom: boolean, additive = false) => {
    setSelection(prev => choose(prev, id, additive));
    if (zoom) void zoomTo([id]);
  }, [zoomTo]);
  const selectMany = useCallback((ids: number[], additive: boolean) => {
    setSelection(prev => (additive ? [...new Set([...prev, ...ids])] : ids));
  }, []);

  const statsText = stats && [
    `${PROFILES[stats.tier].label} · 오차 ${stats.errorTarget}px`,
    `${stats.fps}fps · 드로콜 ${stats.drawCalls} · 삼각형 ${stats.triangles.toLocaleString()}`,
    `타일 표시 ${stats.tilesVisible} · 로드 ${stats.tilesLoaded} · 다운로드 ${stats.downloading} · 해석 ${stats.parsing}${stats.failed ? ` · 실패 ${stats.failed}` : ''}`,
    `캐시 ${stats.cacheMB}MB (화면 ${stats.usedMB}MB)${stats.cacheHits ? ` · 저장본 ${stats.cacheHits}` : ''}${stats.prefetched ? ` · 미리 받음 ${stats.prefetched} (${stats.prefetchedMB}MB)` : ''}${stats.heapMB !== null ? ` · 힙 ${stats.heapMB}MB` : ''}`,
    stats.firstFrameMs !== null ? `첫 화면 ${(stats.firstFrameMs / 1000).toFixed(1)}s${stats.settledMs !== null ? ` · 안정 ${(stats.settledMs / 1000).toFixed(1)}s` : ''}` : '',
  ].filter(Boolean).join(' · ');
  const statsShort = stats && `${PROFILES[stats.tier].label} · ${stats.errorTarget}px · ${stats.fps}fps · 삼각형 ${stats.triangles.toLocaleString()}`;

  return (
    <div className={`threed-test threed-test--v2${project ? ' threed-test--project' : ''}`}>
      {!project && <div className="threed-test__note">
        <UiIcon name="cube" size={16} />
        <span>
          {variant === 'svf' ? (
            <>
              <strong>3D뷰 (신규 테스트 3차)</strong> — 2차 화면과 같은 엔진에서, 가장 세밀한(원본) 단계의 좌표를 모델의
              <strong> SVF 원본 좌표</strong>로 바꾼 시험판입니다(기존 2~20cm 격자 → 1mm 이하). 가까이서 울퉁불퉁하던 면을 2차 화면과 비교해 보세요.
            </>
          ) : (
            <>
              <strong>3D뷰 (신규 테스트 2차)</strong> — 엔진 <strong>three.js + 3D Tiles</strong>(표준 계층형 타일, 화면 크기 기반 단계 선택).
              기존 화면과 같은 모델을 비교하는 시제품입니다. 기기 등급에 따라 그리는 양을 자동으로 조절합니다.
            </>
          )}
        </span>
      </div>}
      <div className="threed-test__viewer">
        <div className="viewer-bar threed-test__bar">
          {/* The tools: in line on wide screens, one scrolling row on phones (status on its own line below). */}
          <div className="threed-test__tools">
          <button className="btn btn--sm btn--primary" onClick={() => setPickerOpen(true)} disabled={busy || !!initError} aria-label="ACC에서 열기">
            <UiIcon name="folder" size={14} /> <span className="threed-test__wide">ACC에서 </span>열기
          </button>
          <button className="btn btn--sm" onClick={() => viewerRef.current?.frameAll()} disabled={!modelName}>전체 맞춤</button>
          <button className="btn btn--sm" onClick={() => selection.length && void zoomTo([...selection])} disabled={!selection.length}
            title="선택한 객체로 확대 (Ctrl+클릭으로 여러 개 선택 · 해제: 빈 곳 클릭 또는 Esc)">선택 확대</button>
          <button className={`btn btn--sm${terrainOn ? ' btn--primary' : ''}`} disabled={!modelName} title="지형(항공사진) 표시"
            onClick={() => { const next = !terrainOn; setTerrainOn(next); viewerRef.current?.setTerrainVisible(next); }}>지형</button>
          {variant === 'svf' && (
            <button className={`btn btn--sm${walk || placing ? ' btn--primary' : ''}`} aria-pressed={!!walk || placing} disabled={!modelName}
              title="보행 모드: 시작할 곳을 클릭한 뒤 사람 눈높이로 걷기 — W·A·S·D(방향키) 이동, Shift 달리기, Space 점프, 드래그로 둘러보기, 휠로 속도. 중력·충돌(보이는 객체에 막힘, 숨긴 객체는 통과)"
              onClick={() => { if (walk) viewerRef.current?.setWalk(false); else setPlacing(p => !p); }}>보행</button>
          )}
          <button className="btn btn--sm" disabled={!modelName || capturing} onClick={() => void capture()}
            title="지금 화면을 2배 해상도로, 멀리 있는 부분까지 세밀한 단계를 불러온 뒤 PNG 로 저장">{capturing ? '캡처 중…' : '고화질 캡처'}</button>
          {/* Picture settings in one drop-down (기기·화질·외곽선·색, 성능 표시). */}
          <details className="threed-test2__settings" ref={settingsRef}>
            <summary className="btn btn--sm" title="보기 설정: 기기 등급·화질·외곽선·색 구분·성능 표시">보기 설정</summary>
            <div className="threed-test2__settings-pop">
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
              <label className="threed-test2__tier" title="화면 오른쪽 아래에 그리기 속도·타일 수를 표시합니다">
                <input type="checkbox" checked={statsShown} onChange={e => { setStatsShown(e.target.checked); remember(STATS_KEY, e.target.checked ? '1' : '0'); }} />
                성능 표시
              </label>
            </div>
          </details>
          {tree && (
            <>
              <button className={`btn btn--sm${treeOpen ? ' btn--primary' : ''}`} onClick={() => { setTreeOpen(o => !o); if (narrowScreen()) setPropsOpen(false); }}>모델 트리</button>
              <button className={`btn btn--sm${propsOpen ? ' btn--primary' : ''}`} onClick={() => { setPropsOpen(o => !o); if (narrowScreen()) setTreeOpen(false); }}>속성</button>
            </>
          )}
          {project && tree && purpose === 'clash' && (
            <button className={`btn btn--sm${clashOpen ? ' btn--primary' : ''}`} aria-pressed={clashOpen} onClick={() => setClashOpen(v => !v)}
              title="간섭검토 창 열기/닫기">간섭검토</button>
          )}
          {project && tree && (
            <>
              <button className={`btn btn--sm${pinsOn ? ' btn--primary' : ''}`} aria-pressed={pinsOn} onClick={() => setPinsOn(v => !v)}
                title="이슈 핀 표시/숨김 (객체에 묶인 이슈 — 빨강 미해결·초록 해결)">이슈 핀</button>
              {canEdit && (
                <button className="btn btn--sm" disabled={selection.length !== 1} onClick={() => setIssueFormOpen(true)}
                  title={selection.length === 1 ? '선택한 객체 위치에 이슈 만들기 (지금 화면이 뷰포인트로 저장됨)' : '객체 하나를 선택하면 그 위치에 이슈를 만들 수 있습니다'}>＋ 이슈</button>
              )}
            </>
          )}
          {project && modelName && (
            <>
              <button className={`btn btn--sm${vpOpen ? ' btn--primary' : ''}`} aria-pressed={vpOpen} onClick={() => setVpOpen(v => !v)}
                title="홈뷰(처음 보이는 시점)와 관측점(이름 붙인 시점) 저장·이동">시점</button>
              <button className={`btn btn--sm${measuring ? ' btn--primary' : ''}`} aria-pressed={measuring}
                onClick={() => { setMeasuring(v => !v); setMeasureFrom(null); }} title="거리 측정: 모델 위 두 점을 차례로 클릭 (Esc 로 끝)">측정</button>
              <button className={`btn btn--sm${section ? ' btn--primary' : ''}`} aria-pressed={!!section}
                onClick={() => setSection(v => (v ? null : { axis: 2, t: 0.5, flip: false }))} title="단면: 평면으로 잘라 안쪽 보기 (선택 객체 상자로도)">단면</button>
              <button className="btn btn--sm" onClick={() => void openMarkup()} title="마크업: 지금 화면에 화살표·글자를 그려 PNG 로 저장">마크업</button>
            </>
          )}
          </div>
          {index.note && <span className="muted threed-test__model">{index.note}</span>}
          <div className="spacer" />
          {status && <span className="muted threed-test2__status" title={pinnedNote ? `${status} · ${pinnedNote}` : status}>{status}{pinnedNote && ` · ${pinnedNote}`}</span>}
        </div>
        <div className={`threed-test__viewport${placing ? ' threed-test2__placing' : ''}`}>
          <canvas ref={canvasRef} className="threed-test__canvas" />
          {missing && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              {missing.converted ? (
                <>
                  <p><strong>{missing.file.name}</strong> 은(는) {tilesName}이 아직 없습니다.</p>
                  {variant ? <p className="threed-test__empty-sub">{project ? '자체 엔진용 타일은 관리자가 모델 변환 작업(GitHub Actions)으로 만듭니다.' : '3차 화면은 시험판이라 시험 타일을 만든 모델만 열립니다(GitHub Actions에서 생성).'}</p> : <>
                  <p className="threed-test__empty-sub">2차 화면은 시제품이라 타일을 만든 모델만 열립니다. 변환된 모델로부터 만들며 보통 10~20분 걸립니다.</p>
                  {job ? <p className="threed-test__empty-sub">{job.note}</p>
                    : canManage ? <button className="btn btn--primary btn--sm" onClick={() => void buildTiles()}>2차 타일 만들기</button>
                      : <p className="threed-test__empty-sub">프로젝트 관리자가 이 화면에서 만들 수 있습니다.</p>}
                  </>}
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
              {project
                ? <p>{busy ? '통합모델을 여는 중…' : <>상단 <em>ACC에서 열기</em>로 모델을 여세요. (자체 엔진용 타일이 만들어진 모델만 열립니다)</>}</p>
                : <p>상단 <em>ACC에서 열기</em>로 모델을 여세요. (2차 엔진용 타일이 생성된 모델만 열립니다)</p>}
            </div>
          )}
          {tree && treeOpen && (
            <aside className="threed-test__panel threed-test__panel--left" aria-label="모델 트리">
              <div className="threed-test__panel-h">
                <strong>모델 트리</strong>
                <span className="muted">{(tree.n - 1).toLocaleString()}개 객체</span>
                <div className="spacer" />
                {hiddenNodes.size > 0 && (
                  <button type="button" className="btn btn--sm" onClick={showAll} title={`숨긴 ${hidden.length.toLocaleString()}개를 모두 다시 보이기 (Shift+H)`}>
                    모두 보이기
                  </button>
                )}
                <button type="button" className="ic-only" onClick={() => setTreeOpen(false)} aria-label="모델 트리 닫기">✕</button>
              </div>
              <ModelTreePanel tree={tree} hiddenNodes={hiddenNodes} selected={primary} selection={chosen} reveal={revealDb}
                onToggle={toggleNode} onSelect={(id, additive) => { setRevealDb(null); selectNode(id, false, additive); }} />
            </aside>
          )}
          {tree && propsOpen && (
            <aside className="threed-test__panel threed-test__panel--right" aria-label="속성">
              <div className="threed-test__panel-h">
                <strong>속성</strong>
                <div className="spacer" />
                <button type="button" className="ic-only" onClick={() => setPropsOpen(false)} aria-label="속성 닫기">✕</button>
              </div>
              <PropertyPanel tree={tree} selected={selection.length === 1 ? selection[0] : null} selection={selection}
                loadProps={index.loadProps} searchValues={index.searchValues}
                onSelect={(id, zoom, additive) => { setRevealDb(id); selectNode(id, zoom, !!additive); }} onSelectMany={selectMany}
                onZoom={ids => void zoomTo(ids)} onHighlight={setHighlightIds} />
            </aside>
          )}
          {project && pinsOn && pinBoxes && anchors.size > 0 && viewerRef.current && (
            <MirIssuePins viewer={viewerRef.current} issues={issues} anchors={anchors} boxes={pinBoxes} onPinClick={setPopIssue} />
          )}
          {popIssue && (
            <MirIssuePopup issue={popIssue} projectId={projectId} canEdit={canEdit} onClose={() => setPopIssue(null)} onFocus={focusIssue}
              onSaveView={it => void saveViewFor(it.id, it.title).then(ok => setStatus(ok ? '현재 뷰를 이슈 뷰포인트로 저장했습니다.' : '뷰포인트를 저장하지 못했습니다.'))} />
          )}
          {issueFormOpen && <MirIssueForm categories={issueCats} onSubmit={submitIssue} onClose={() => setIssueFormOpen(false)} />}
          {project && viewerRef.current && (measures.length > 0 || measureFrom) && (
            <MirMeasureLayer viewer={viewerRef.current} measures={measures} pending={measureFrom?.p ?? null} />
          )}
          {project && vpOpen && viewerRef.current && (
            <MirViewpointPanel viewer={viewerRef.current} projectId={`${projectId}:${purpose}`} onClose={() => setVpOpen(false)} onStatus={setStatus} />
          )}
          {markupImage && <MirMarkupEditor image={markupImage} fileName={`${(modelName || '3D').replace(/\.[^.]+$/, '')}_마크업.png`} onClose={() => setMarkupImage(null)} />}
          {project && clashOpen && tree && (
            <MirClashPanel tree={tree} projectId={projectId} canEdit={canEdit} urls={() => urlsRef.current} boxes={loadBoxes}
              externalOf={index.externalOf} findExternal={index.findExternal} onShow={showClash} snapshot={snapshotUrl}
              view={clashView ? (clashView.ghost ? 'ghost' : 'all') : null}
              onView={mode => setClashView(v => (mode === 'clear' || !v ? null : { ...v, ghost: mode === 'ghost' }))}
              capture={captureClash} fileOf={fileOf}
              onIssueCreated={reloadIssues} onClose={() => { setClashOpen(false); setClashView(null); }} />
          )}
          {/* Top centre: what is selected / hidden and what to do with it, then the colour legend. */}
          <div className="threed-test2__top">
            {measuring && (
              <div className="threed-test2__selbar" role="toolbar" aria-label="측정">
                <strong>측정</strong>
                <span className="muted">{measureFrom ? '끝점을 클릭하세요 (Esc 취소)' : '시작점을 클릭하세요'} · 측정 {measures.length}개</span>
                {measures.length > 0 && <button type="button" className="btn btn--sm" onClick={() => setMeasures([])}>모두 지우기</button>}
                <button type="button" className="btn btn--sm" onClick={() => { setMeasuring(false); setMeasureFrom(null); }}>끝내기</button>
              </div>
            )}
            {section && (
              <div className="threed-test2__selbar" role="toolbar" aria-label="단면">
                <strong>단면</strong>
                {'box' in section ? <span className="muted">선택 객체 상자</span> : (
                  <>
                    {(['X축', 'Y축', '높이'] as const).map((label, a) => (
                      <button key={label} type="button" className={`btn btn--sm${section.axis === a ? ' btn--primary' : ''}`}
                        onClick={() => setSection({ axis: a as 0 | 1 | 2, t: 0.5, flip: section.flip })}>{label}</button>
                    ))}
                    <input type="range" min={0} max={1000} value={Math.round(section.t * 1000)} aria-label="단면 위치"
                      onChange={e => setSection({ ...section, t: Number(e.target.value) / 1000 })} />
                    <button type="button" className="btn btn--sm" onClick={() => setSection({ ...section, flip: !section.flip })} title="자르는 쪽 바꾸기">뒤집기</button>
                  </>
                )}
                <button type="button" className="btn btn--sm" disabled={!selection.length} onClick={() => void sectionToSelection()}
                  title="선택한 객체 둘레(1 m 여유)만 남기기">선택 상자</button>
                {'box' in section && <button type="button" className="btn btn--sm" onClick={() => setSection({ axis: 2, t: 0.5, flip: false })}>평면으로</button>}
                <button type="button" className="btn btn--sm" onClick={() => setSection(null)}>끄기</button>
              </div>
            )}
            {placing && !walk && (
              <div className="threed-test2__selbar" role="toolbar" aria-label="보행 시작 위치">
                <strong>보행</strong>
                <span className="muted">시작할 곳을 클릭하세요 (바닥·벽 앞·천장 아래) · 드래그·휠로 찾기 · Esc 취소</span>
                <button type="button" className="btn btn--sm" title="지금 카메라 아래 바닥에서 시작"
                  onClick={() => { setPlacing(false); viewerRef.current?.setWalk(true); }}>지금 위치에서</button>
                <button type="button" className="btn btn--sm" onClick={() => setPlacing(false)}>취소</button>
              </div>
            )}
            {walk && (
              <div className="threed-test2__selbar" role="toolbar" aria-label="보행 모드">
                <strong>보행</strong>
                <span className="muted">W·A·S·D 이동 · Shift 달리기 · {walk.gravity ? 'Space 점프' : 'Q/E 아래·위'} · 드래그 둘러보기 · 휠 속도</span>
                <span title="걷는 속도 (휠로 바꿈, Shift 를 누르면 3배)">{walk.speed < 10 ? walk.speed.toFixed(1) : Math.round(walk.speed)} m/s</span>
                <button type="button" className={`btn btn--sm${walk.gravity ? ' btn--primary' : ''}`} aria-pressed={walk.gravity}
                  title="중력: 바닥을 따라 걷고 45cm 이하 턱은 오르며, 더 높은 곳에서는 떨어집니다. 끄면 Q/E 로 아래·위"
                  onClick={() => viewerRef.current?.setWalkOptions({ gravity: !walk.gravity })}>중력</button>
                <button type="button" className={`btn btn--sm${walk.collide ? ' btn--primary' : ''}`} aria-pressed={walk.collide}
                  title="충돌: 보이는 객체에 막혀 벽을 따라 미끄러집니다 (숨긴 객체는 통과)"
                  onClick={() => viewerRef.current?.setWalkOptions({ collide: !walk.collide })}>충돌</button>
                <button type="button" className={`btn btn--sm${walk.figure ? ' btn--primary' : ''}`} aria-pressed={walk.figure}
                  title="캐릭터: 건설 작업자를 뒤에서 따라가며 봅니다(3인칭). 끄면 사람 눈높이에서 봅니다(1인칭)"
                  onClick={() => viewerRef.current?.setWalkOptions({ figure: !walk.figure })}>캐릭터</button>
                <label className="threed-test2__height" title="키 (140~200cm, 기본 172.5cm: 대한민국 성인 남성 평균) — 눈높이는 키의 93.6%">
                  키
                  <input type="number" min={140} max={200} step={0.5} value={heightDraft ?? Math.round(walk.height * 200) / 2}
                    onChange={e => {
                      setHeightDraft(e.target.value);
                      const cm = Number(e.target.value);
                      if (e.target.value !== '' && cm >= 140 && cm <= 200) viewerRef.current?.setWalkOptions({ height: cm / 100 });
                    }}
                    onFocus={() => { heightBefore.current = walk.height; }}
                    onBlur={() => {
                      // Out of range when left: the nearest allowed height; Esc: the height before typing.
                      const cm = Number(heightDraft);
                      if (heightCancelled.current) viewerRef.current?.setWalkOptions({ height: heightBefore.current });
                      else if (heightDraft && Number.isFinite(cm)) viewerRef.current?.setWalkOptions({ height: Math.min(200, Math.max(140, cm)) / 100 });
                      heightCancelled.current = false;
                      setHeightDraft(null);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      else if (e.key === 'Escape') { heightCancelled.current = true; e.currentTarget.blur(); }
                    }} />
                  cm
                </label>
                <button type="button" className="btn btn--sm" onClick={() => viewerRef.current?.setWalk(false)} title="보행 끝내기 (일반 조작으로)">끝내기</button>
              </div>
            )}
            {tree && (selection.length > 0 || hiddenNodes.size > 0 || visibility.past.length > 0) && (
              <div className="threed-test2__selbar" role="toolbar" aria-label="선택과 보이기">
                {selection.length > 0 && (
                  <>
                    <strong>선택 {selection.length.toLocaleString()}개</strong>
                    <button type="button" className="btn btn--sm" onClick={() => void zoomTo([...selection])} title="선택한 객체로 확대">확대</button>
                    <button type="button" className="btn btn--sm" onClick={hideSelection} title="선택한 객체 숨기기 (H)">숨기기</button>
                    <button type="button" className="btn btn--sm" onClick={isolateSelection} title="선택한 객체만 보기 — 나머지는 숨김 (I)">선택만 보기</button>
                    <button type="button" className="btn btn--sm" onClick={() => setSelection([])} title="선택 해제 (Esc)">해제</button>
                  </>
                )}
                {hiddenNodes.size > 0 && (
                  <>
                    <span className="muted">숨김 {hidden.length.toLocaleString()}개</span>
                    <button type="button" className="btn btn--sm" onClick={showAll} title="숨긴 객체를 모두 다시 보이기 (Shift+H)">모두 보이기</button>
                  </>
                )}
                {visibility.past.length > 0 && (
                  <button type="button" className="btn btn--sm" onClick={undoVisibility} title="숨기기·보이기를 한 단계 되돌리기 (Ctrl+Z)">↶ 되돌리기</button>
                )}
              </div>
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
          </div>
          {statsText && statsShown && (
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
          onClose={() => setPickerOpen(false)} onPick={f => { setPickerOpen(false); setPinnedNote(''); void openModel(f); }} />
      )}
    </div>
  );
}

export default ThreeDTest2;
