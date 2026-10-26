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
import { TilesViewer, type ViewerStats, type WalkInfo } from '../viewer2/TilesViewer';
import { PROFILES, QUALITIES, type DeviceTier, type Quality } from '../viewer2/deviceProfile';
import { COLOR_MODES, paintFor, type ColorMode } from '../viewer2/colorModes';
import { readSignedTiles, saveSignedTiles, type SignedTiles } from '../viewer2/signedTiles';
import { Sim45dDock } from '../components/sim45d/Sim45dDock';
import { Sim45dSetup } from '../components/sim45d/Sim45dSetup';
import { useSim45d } from '../components/sim45d/useSim45d';
import { fourDState } from '../lib/sim45d/timeline';
import { linkEntries, resolveLinks } from '../lib/sim45d/viewerLinks';

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
const OUTLINE_KEY = 'mir.viewer2.outlines', COLOR_KEY = 'mir.viewer2.colorMode';
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

export function ThreeDTest2({ variant, sim }: { variant?: 'svf'; sim?: boolean } = {}) {
  const { projectId = '' } = useParams();
  const tilesQuery = variant ? `tiles3d=1&variant=${variant}` : 'tiles3d=1';
  const tilesName = variant ? '3차 화면용(SVF 정밀) 타일' : '2차 화면용 타일';
  const { canEdit, canManage } = useProjectRole(projectId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<TilesViewer | null>(null);
  const urlsRef = useRef<Record<string, string> | null>(null);
  const boxesRef = useRef<Promise<Float32Array> | null>(null);
  const renewAt = useRef<{ urn: string; at: number } | null>(null);
  const index = useModelIndex();
  const tree = index.tree;
  // 공정·공사비(4D/5D) 메뉴: 같은 3차 뷰어 + 하단 도크(공정표·차트·5D 내역·물량·연결). docs/IPS_4D5D.md
  const sim45 = useSim45d(projectId, !!sim);
  const xerInputRef = useRef<HTMLInputElement>(null);
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
  // 4D(공정·공사비 메뉴): 기준일의 시공 상태 — 연결된 객체만 칠하고, 미시공은 숨기거나 회색으로. 색 구분보다 우선.
  const { acts: simActs, links: simLinks, time: simTime, fourD: simFourD, hideFuture: simHideFuture, savedLinks: simSaved, setLinks: simSetLinks } = sim45;
  // 작업 → 이 모델의 객체: 6단계 연결(다른 파일 — 요소 IfcGUID·UniqueId 로) + 모델 코드(A3)가 작업 코드와 같은 객체. 속성 색인에서 찾는다.
  const { lookupValues } = index;
  useEffect(() => {
    if (!sim || !tree) return;
    const codes = simActs.filter(a => !a.summary).map(a => a.code);
    if (!codes.length) { simSetLinks(null); return; }
    let alive = true;
    lookupValues(linkEntries(simSaved, codes))
      .then(found => { if (alive) simSetLinks(resolveLinks(simSaved, codes, found)); })
      .catch(e => { if (alive) setStatus(`4D 연결 객체를 찾지 못했습니다: ${errMessage(e)}`); });
    return () => { alive = false; };
  }, [sim, tree, simActs, simSaved, lookupValues, simSetLinks]);
  // 칠하기·3D 선택 → 작업은 요소 아래 형상 노드까지
  const paintLinks = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const [code, ids] of simLinks) { const all: number[] = []; for (const id of ids) { if (tree) for (const d of tree.subtree(id)) all.push(d); else all.push(id); } out.set(code, all); }
    return out;
  }, [simLinks, tree]);
  const fourD = useMemo(() => (sim && tree && simFourD && paintLinks.size
    ? fourDState(simActs, paintLinks, simTime, tree.n, { hideFuture: simHideFuture }) : null),
  [sim, tree, simFourD, paintLinks, simActs, simTime, simHideFuture]);
  const hidden = useMemo(() => {
    const out = expand(hiddenNodes);
    if (fourD) for (const id of fourD.hidden) out.push(id);
    return out;
  }, [hiddenNodes, expand, fourD]);
  useEffect(() => { viewerRef.current?.setStates(selected, highlighted, hidden); }, [selected, highlighted, hidden]);
  // Colour mode → per-object paint under the states (again for each opened model: its tree arrives after the tiles).
  const painted = useMemo(() => (tree ? paintFor(tree, colorMode) : null), [tree, colorMode]);
  useEffect(() => { viewerRef.current?.setPaint(fourD?.paint ?? painted?.paint ?? null); }, [painted, fourD]);
  // 작업 선택 ↔ 3D 선택: 작업을 누르면 그 객체가 선택되고, 3D 에서 고른 객체는 그 객체가 걸린 작업을 선택한다.
  const fromDock = useRef(false);
  const { selectActivity: simSelectActivity, setSelected: simSetSelected } = sim45;
  const selectActivity = useCallback((code: string, additive: boolean) => {
    simSelectActivity(code, additive);
    const ids = simLinks.get(code);
    if (!ids?.length) return;
    fromDock.current = true;
    setSelection(prev => (additive ? [...new Set([...prev, ...ids])] : [...ids]));
  }, [simSelectActivity, simLinks]);
  const activitiesOf = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const [code, ids] of paintLinks) for (const id of ids) { const l = m.get(id); if (l) l.push(code); else m.set(id, [code]); }
    return m;
  }, [paintLinks]);
  useEffect(() => {
    if (!sim || !activitiesOf.size) return;
    if (fromDock.current) { fromDock.current = false; return; }
    const codes = new Set<string>();
    for (const id of selection) for (const c of activitiesOf.get(id) ?? []) codes.add(c);
    simSetSelected(codes);
  }, [sim, selection, activitiesOf, simSetSelected]);

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
      if (e.key === 'Escape') { if (placingRef.current) setPlacing(false); else setSelection(prev => (prev.length ? [] : prev)); }
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
  const fetchTiles = useCallback(async (f: PickedAccFile, scope: string): Promise<SignedTiles | null> => {
    const headers = await authHeaders();
    const urn = encodeURIComponent(f.accUrn ?? '');
    const r = await fetch(`/api/aps-convert?urn=${urn}&${tilesQuery}`, { headers });
    const tiles = await readApiJson<{ run?: string; urls?: Record<string, string>; builtAt?: string; expiresIn?: number; meta?: MetaInfo; error?: string; missing?: boolean }>(r);
    const ok = r.ok && !!tiles.urls?.['tileset.json'];
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
  const openModel = useCallback(async (f: PickedAccFile) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!f.accUrn) { setStatus('이 파일은 아직 APS 파생(URN)이 없습니다.'); return; }
    const seq = ++openSeq.current;
    const show = (t: SignedTiles) => {
      setSelection([]); setRevealDb(null); setVisibility(NO_HIDDEN); setHighlightIds(null);
      index.reset(); boxesRef.current = null;
      urlsRef.current = { ...t.urls };
      // Renewed 15 min before the URLs expire, so a long session keeps loading tiles.
      renewAt.current = { urn: f.accUrn!, at: Math.max(Date.now() + 60_000, t.expiresAt - 15 * 60_000) };
      viewer.open(t.urls, (t.meta?.objects ?? 0) + 1);
      void index.open(f.accUrn!, t.meta);
      setStatus(`${f.name} · 3D Tiles ${Object.keys(t.urls).length.toLocaleString()}개 파일${t.builtAt ? ` · 생성 ${t.builtAt.slice(0, 10)}` : ''}`);
    };
    setBusy(true); setStatus(`불러오는 중… ${f.name}`); setModelName(f.name); setMissing(null);
    try {
      const { data } = await supabase.auth.getSession();
      const scope = `${data.session?.user.id ?? ''}|${tilesQuery}|${f.accUrn}`;
      const kept = await readSignedTiles(scope);
      if (kept && kept.expiresAt - Date.now() > 30 * 60_000) {
        // Opened before in this browser: at once from the kept list, a fresh one behind it (a newer build replaces
        // the view; the same build only renews the URLs).
        show(kept);
        setBusy(false);
        const fresh = await fetchTiles(f, scope).catch(() => null);
        if (!fresh || seq !== openSeq.current) return;
        if (fresh.run !== kept.run) { show(fresh); setStatus(s => `${s} · 새로 생성된 타일로 바꿨습니다`); return; }
        Object.assign(urlsRef.current ?? {}, fresh.urls);
        viewer.updateUrls(fresh.urls);
        renewAt.current = { urn: f.accUrn, at: fresh.expiresAt - 15 * 60_000 };
        return;
      }
      setSelection([]); setRevealDb(null); setVisibility(NO_HIDDEN); setHighlightIds(null);
      index.reset(); boxesRef.current = null; urlsRef.current = null;
      const fresh = await fetchTiles(f, scope);
      if (fresh && seq === openSeq.current) show(fresh);
    } catch (e) { setStatus(`열기 실패: ${errMessage(e)}`); }
    finally { if (seq === openSeq.current) setBusy(false); }
  }, [index, tilesQuery, fetchTiles]);

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
    <div className="threed-test threed-test--v2">
      {!sim && <div className="threed-test__note">
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
        {/* 공정·공사비: 단계 바 + 단계 시트(D30). 시트는 3D 위에 펼쳐지고, 4D/5D 단계에서 접힌다. */}
        {sim && <Sim45dSetup projectId={projectId} canEdit={canEdit} sim={sim45} />}
        <div className="viewer-bar threed-test__bar">
          {/* The tools: in line on wide screens, one scrolling row on phones (status on its own line below). */}
          <div className="threed-test__tools">
          {sim && (
            <span className="sim-toolbar" role="group" aria-label="공정표">
              <button className="btn btn--sm" onClick={() => xerInputRef.current?.click()} title="P6 에서 내보낸 공정표(XER) 열기">
                <UiIcon name="file-text" size={14} /> 공정표 열기
              </button>
              {sim45.schedule && (
                <>
                  <button className="btn btn--sm" onClick={() => sim45.downloadXer(sim45.sourceEncoding ?? 'cp949')}
                    title={`P6 에서 고칠 수 있게 XER 로 내려받기 (${sim45.sourceEncoding === 'utf-8' ? 'UTF-8' : 'CP949'} — 연 파일과 같은 인코딩)`}>
                    <UiIcon name="download" size={14} /> XER
                  </button>
                  <span className="sim-toolbar__name" title={sim45.fileName}>{sim45.schedule.projectName}</span>
                  <button type="button" className="ic-only" onClick={sim45.close} aria-label="공정표 닫기" title="공정표 닫기">✕</button>
                </>
              )}
              <input ref={xerInputRef} type="file" accept=".xer" hidden onChange={e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void sim45.openXer(f);
              }} />
            </span>
          )}
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
        <div className={`threed-test__viewport${placing ? ' threed-test2__placing' : ''}`}>
          <canvas ref={canvasRef} className="threed-test__canvas" />
          {missing && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              {missing.converted ? (
                <>
                  <p><strong>{missing.file.name}</strong> 은(는) {tilesName}이 아직 없습니다.</p>
                  {variant ? <p className="threed-test__empty-sub">3차 화면은 시험판이라 시험 타일을 만든 모델만 열립니다(GitHub Actions에서 생성).</p> : <>
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
              <p>상단 <em>ACC에서 열기</em>로 모델을 여세요. ({variant ? '3차 화면 타일을 만든 모델만 열립니다' : '2차 엔진용 타일이 생성된 모델만 열립니다'})</p>
              {sim && <p className="threed-test__empty-sub">4D 는 현장 통합 모델(예: 5공구_통합모델.nwd)을 열면 확정 공정표의 작업 상태로 칠해집니다 — 6단계 연결과 모델의 IPS 코드로 객체를 찾습니다.</p>}
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
          {/* Top centre: what is selected / hidden and what to do with it, then the colour legend. */}
          <div className="threed-test2__top">
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
                    <span className="muted">숨김 {(hidden.length - (fourD?.hidden.length ?? 0)).toLocaleString()}개</span>
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
          {statsText && (
            <button type="button" className={`threed-test2__stats${statsOpen ? ' is-open' : ''}`} onClick={() => setStatsOpen(o => !o)}
              aria-expanded={statsOpen} title="성능 표시 (좁은 화면에서는 눌러서 펼침)">
              <span className="threed-test2__stats-full">{statsText}</span>
              <span className="threed-test2__stats-short">{statsShort}</span>
            </button>
          )}
        </div>
        {/* 공정·공사비: 3D 아래 도크(3D 영역이 줄어듦 — 패널·성능 표시는 3D 영역 안에 남음). */}
        {sim && <Sim45dDock sim={sim45} onOpenXer={() => xerInputRef.current?.click()} objectCount={selection.length} onSelectActivity={selectActivity} />}
      </div>
      {pickerOpen && (
        <AccFilePicker projectId={projectId} canEdit={canEdit} title="3D 모델 열기" actionLabel="열기" accept={isAccModel}
          onClose={() => setPickerOpen(false)} onPick={f => { setPickerOpen(false); void openModel(f); }} />
      )}
    </div>
  );
}

export default ThreeDTest2;
