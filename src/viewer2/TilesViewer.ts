import {
  AmbientLight, Box3, Clock, Color, DirectionalLight, DoubleSide, Euler, Group, Matrix3, Matrix4, Mesh, PerspectiveCamera,
  Quaternion, Ray, Raycaster, Scene, Sphere, Spherical, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget,
  type BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute, type Material, type MeshStandardMaterial, type Object3D,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import CameraControls from 'camera-controls';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ObjectStateTexture, createPickMaterial, createSurfaceMaterial, createTerrainMaterial } from './objectState';
import { OutlinePass } from './outline';
import { PROFILES, detailOf, probeDevice, type DeviceProfile, type DeviceTier, type Quality } from './deviceProfile';
import { runOf, tileCachePlugin, type TileCacheStats } from './tileCache';
import { nearestFiles, structureFiles, type NearbyFile } from './prefetch';
import { PIVOT_REACH, ROOM_H, ROOM_REACH, ROOM_W, roomSize, unpackDepth, wheelStep } from './navigation';
import {
  FLOOR_SEARCH, MAX_SPEED, MAX_STATURE, MIN_SPEED, MIN_STATURE, RUN_FACTOR, SPEED_STEP, STATURE, WALK_SPEED, eyeHeight, keysToMove,
  standingSpot, stepWalker, type Hit, type Walker,
} from './walk';
import { WorkerFigure } from './avatar';
import { CollisionIndex } from './collision';
import type { MeshBVH } from 'three-mesh-bvh';

CameraControls.install({ THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster } });

/**
 * Let failed tiles load again on the next update. The library's resetFailedTiles() (0.5.3) cannot be used: it visits
 * children that were never preprocessed (no `internal`) and throws, and a failed tile stays in the LRU cache, which
 * refuses to queue it again. Removing it from the cache also marks it unloaded.
 */
const FAILED = -1; // 3d-tiles-renderer core/renderer/constants.js (not in its typings)
const resetFailed = (tiles: TilesRenderer) => {
  type Node = { internal?: { loadingState: number } };
  type Walk = { traverse(before: (tile: Node) => boolean, after: null, ensureProcessed: boolean): void };
  const failed: Node[] = [];
  (tiles as unknown as Walk).traverse(tile => {
    if (tile.internal && tile.internal.loadingState === FAILED) failed.push(tile);
    return false;
  }, null, false);
  for (const tile of failed) tiles.lruCache.remove(tile as never);
  (tiles as unknown as { stats: TileStats }).stats.failed = 0;
};

/** Stand-in origin: the tileset's relative paths resolve against it and are then mapped to signed URLs. */
const BASE = 'https://tiles.mir.invalid/';

/** Keys walk mode listens to (walk.ts keysToMove) and the pointer events of its look-around drag. */
const WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
  'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const WALK_POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;

/** Walk mode as shown to the page: on/off, speed (m/s), gravity and collision. */
export type WalkInfo = { on: boolean; speed: number; gravity: boolean; collide: boolean; figure: boolean; height: number };
/**
 * Third-person view of the figure, over its right shoulder: FOLLOW m behind the head, FOLLOW_UP above it and SHOULDER to
 * the right (at STATURE; scaled with the height), looking VIEW_TILT rad lower than the walk direction so the figure
 * stands whole left of centre below the view ahead (first measured 3.2 m straight behind: the legs fell off the screen
 * and the head covered the tunnel ahead). Pulled in before a wall or ceiling; nearer than FIGURE_NEAR m the figure is
 * not drawn (inside the head).
 */
const FOLLOW = 4, FOLLOW_UP = 0.6, SHOULDER = 0.45, VIEW_TILT = -0.15, FIGURE_NEAR = 0.9;
/**
 * Walking, the tiles within INDEX_AHEAD m are indexed for its rays in the background, the nearest first; a tile shown
 * and indexed in the last STAND_IN s stands in for a just-loaded one not indexed yet (walkCast).
 */
const INDEX_AHEAD = 40, STAND_IN = 15;

export type ViewerStats = {
  fps: number; frames: number; drawCalls: number; triangles: number; geometries: number;
  tilesVisible: number; tilesLoaded: number; downloading: number; parsing: number; failed: number;
  cacheMB: number; usedMB: number; heapMB: number | null; tier: DeviceTier; errorTarget: number;
  /** Tile files answered from this browser's tile cache (no download). */
  cacheHits: number;
  /** Files fetched ahead around resting views (prefetch.ts) and their size. */
  prefetched: number; prefetchedMB: number;
  firstFrameMs: number | null; settledMs: number | null;
};
type TileStats = { downloading: number; parsing: number; loaded: number; failed: number };
/** True from the first queued tile until every download/parse has finished (not in the library's typings). */
const loading = (tiles: TilesRenderer) => (tiles as unknown as { isLoading: boolean }).isLoading;
/**
 * CSS px around the pointer searched for a surface. Within UNDER_RADIUS it counts as under the pointer (the pivot of a
 * drag; thin members seen from afar are a pixel or two wide); farther, its depth still sets zoom and pan steps — the
 * whole-site view of a long site is a thin band, and the cursor beside it is the usual case.
 */
const SAMPLE_RADIUS = 24;
const UNDER_RADIUS = 4;
/** Least ms between surface samples (each is a pass over what lies under the pointer — at a far view, most tiles). */
const SAMPLE_EVERY = 100;
/**
 * Second viewer engine (docs/3D뷰_2차_엔진.md): three.js + 3DTilesRendererJS + camera-controls. The tileset is in a
 * Z-up frame (metres from the converter origin); `world` turns it Y-up like the first viewer. Rendering is on
 * demand: a frame is drawn only when the camera moved, tiles changed or object states changed.
 */
export class TilesViewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: CameraControls;
  readonly world = new Group();
  profile: DeviceProfile;
  /** The tier this device was detected as (「자동」). */
  readonly detectedTier: DeviceTier;
  /** Picture quality over the tier (finer error, larger cache). */
  quality: Quality = 'standard';
  onStats?: (stats: ViewerStats) => void;
  private tiles: TilesRenderer | null = null;
  private state: ObjectStateTexture | null = null;
  private surface: { opaque: Material; transparent: Material } | null = null;
  private pickMaterial: ReturnType<typeof createPickMaterial> | null = null;
  private readonly pickTarget = new WebGLRenderTarget(1, 1);
  private readonly clock = new Clock();
  private readonly resize: ResizeObserver;
  private raf = 0;
  private dirty = true;
  private needsUpdate = true;
  private frameTimes: number[] = [];
  private frames = 0;
  private openedAt = 0;
  private firstFrameMs: number | null = null;
  private settledMs: number | null = null;
  private lastStats = 0;
  /** Path → signed URL of the open tileset (kept so renewed URLs apply to later requests), and back. */
  private urls: Record<string, string> = {};
  private readonly pathBySigned = new Map<string, string>();
  private tileCache: TileCacheStats | null = null;
  /** The tile cache of the open tileset (for prefetching), the leaf files of its tree, and the prefetch state: files
   * already looked at, bytes fetched for this model, the round in progress (aborted when the camera moves). */
  private cacheApi: ReturnType<typeof tileCachePlugin> | null = null;
  private nearby: NearbyFile[] = [];
  private prefetch = { done: new Set<string>(), bytes: 0, running: false, abort: null as AbortController | null, finishedAt: -1 };
  /** Last time the camera moved or tiles were loading (prefetch waits for a quiet moment). */
  private quietSince = 0;
  /**
   * Load ancestors: coarser levels of a view are fetched and shown first while its own tiles load (progressive), at
   * the cost of requests before the final tiles arrive. Off: each view loads its own tiles; what was on screen stays
   * until they replace it. Measured (ui-check run 194, 400 ms per request, two hosts): a fly-in from 1200 m to 40 m
   * and back settled in 37 s instead of 45 s.
   */
  private ancestors = false;
  /** Failed tiles are retried with a growing delay (a dropped request on a field network must not leave a hole). */
  private retry = { at: 0, delay: 2000 };
  /** Terrain tiles on screen (aerial photo, no object ids) and whether the terrain is shown. */
  private readonly terrainScenes = new Set<Object3D>();
  private terrainShown = true;
  /** CSS px at the bottom covered by a panel (a phone's bottom sheet). */
  private inset = 0;
  /** Tileset bounds in the scene frame (set when the tileset loads). */
  private bounds: Sphere | null = null;
  /** Counters of the last on-screen frame (renderer.info also counts the 1×1 pick renders). */
  private frame = { calls: 0, triangles: 0 };
  /** Screen error (px) and cache budget (MB) set directly, over the tier and quality (null = from those). */
  private detail: { errorTarget: number | null; cacheMB: number | null } = { errorTarget: null, cacheMB: null };
  /** Outlines between objects (outline.ts); null = the scene draws straight to the canvas. */
  private outline: OutlinePass | null = null;
  private readonly samples: number;
  /** Mouse over the canvas with no button held (CSS px): the surface under it is sampled (sampleSurface). */
  private pointer: { x: number; y: number } | null = null;
  /** Latest surface sample: where and from which view (`view`) it was taken, the drawn point nearest the pointer and
   * its distance on screen (CSS px); point null = nothing within SAMPLE_RADIUS. */
  private sample: { x: number; y: number; view: number; point: Vector3 | null; offset: number } | null = null;
  private readonly sampleTarget = new WebGLRenderTarget(1, 1);
  private sampling = false;
  private sampleWanted = false;
  private sampledAt = 0;
  /** Bumped when the camera is flown somewhere (dropSample): a read begun before is not kept. */
  private sampleEpoch = 0;
  /** Bumped whenever the camera moves; `moving`: it moved in the last frame. */
  private view = 0;
  private moving = false;
  /** The last surface point a drag rotated about (pivotAtPointer): the pivot of a drag that starts over empty space. */
  private lastPivot: Vector3 | null = null;
  /** How far the surroundings are (m; roomSize), Infinity outdoors or not yet measured; read at rest (sampleRoom). */
  private room = Infinity;
  private readonly roomTarget = new WebGLRenderTarget(ROOM_W, ROOM_H);
  private roomSampling = false;
  private roomWanted = true;
  /** The scroll gesture under way: where the cursor is, the point it moves toward (a surface: `surface`), last notch. */
  private wheelGesture: { x: number; y: number; at: number; point: Vector3; surface: boolean } | null = null;
  /**
   * Walk mode (walk.ts): the person, where the view looks (yaw, pitch), speed, keys held, the eye height shown (eases up
   * a step), a mouse drag looking around, and the meshes rays are cast against (visible ones, gathered once a frame).
   */
  private walkState: {
    walker: Walker; yaw: number; pitch: number; speed: number; keys: Set<string>; eyeY: number;
    /** Space went down since the last frame: a tap shorter than a frame (a slow one) still jumps. */
    jump: boolean;
    /**
     * Where the person is to stand, found once the tiles there are indexed (the clicked point seen from `eye`, or the
     * floor under `eye`); until then it waits at the clicked point or eye height.
     */
    start: { eye: Vector3; point: Vector3 | null; yaw: number } | null;
    look: { id: number; x: number; y: number } | null; meshes: Mesh[] | null; standIns: Mesh[] | null;
    /** The construction worker shown in third person (null: first person), its heading and the camera's distance. */
    figure: WorkerFigure | null; heading: number; follow: number;
  } | null = null;
  /** Walk settings kept between walks: the person's height and whether the figure is shown. */
  private walkPrefs = { height: STATURE, figure: true };
  /** Bounding volume hierarchies of the tile geometries for walk mode's rays (built in a worker). */
  private readonly collision = new CollisionIndex();
  /** A ray of this frame passed a geometry not indexed yet (walkCast), and the geometries it passed. */
  private castMissing = false;
  private readonly missed = new Set<BufferGeometry>();
  /** Indexed tile meshes shown during this walk, and when last (the library takes a tile off the scene when hidden). */
  private readonly shownLately = new Map<Mesh, number>();
  /** Tile geometries the GPU has (positions and index uploaded): only these are lent to the collision worker. */
  private readonly uploaded = new WeakSet<BufferGeometry>();
  onWalk?: (info: WalkInfo) => void;

  constructor(private readonly canvas: HTMLCanvasElement, tier?: DeviceTier) {
    // No reverse-Z: with three r171 it drew nothing in Chromium's software GL. A logarithmic depth buffer on every
    // tier: the model has layers a few millimetres apart (a slope's finish on the embankment, drains on it), and with
    // a near plane that follows the orbit distance a standard buffer could not order them a few hundred metres away —
    // they fought as flickering white saw-teeth (measured on tile 931: 921 slope vertices within 5 cm of a grey
    // surface; standard 24-bit depth resolves about 3e-5 × the orbit distance, 12 mm at 400 m). Phones used to keep
    // the standard buffer (per-pixel depth writes defeat a tiled GPU's hidden-surface removal) while they drew only
    // the coarse levels at 20 px; at 4 px they draw the same fine levels as PCs, on a canvas a third the size.
    // Edge smoothing keeps thin members (rails, railings) continuous from afar instead of breaking into dashes.
    const device = probeDevice();
    this.renderer = new WebGLRenderer({ canvas, antialias: device.antialias, powerPreference: 'high-performance',
      logarithmicDepthBuffer: true });
    this.detectedTier = device.tier;
    this.samples = device.antialias ? 4 : 0;
    this.outline = new OutlinePass(this.samples);
    this.profile = PROFILES[tier ?? device.tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio));
    this.scene.background = new Color(0.78, 0.84, 0.9);
    this.scene.add(new AmbientLight(0xffffff, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.4); sun.position.set(0.3, 1, 0.4);
    const fill = new DirectionalLight(0xffffff, 0.6); fill.position.set(-0.5, 0.7, -0.5);
    this.scene.add(sun, fill);
    this.world.rotation.x = -Math.PI / 2; // tileset Z-up → three Y-up
    this.scene.add(this.world);
    this.camera = new PerspectiveCamera(60, 1, 0.1, 1e6);
    this.camera.position.set(100, 100, 100);
    this.controls = new CameraControls(this.camera, canvas);
    this.controls.dollyToCursor = true;
    this.controls.infinityDolly = true;
    this.controls.mouseButtons.wheel = CameraControls.ACTION.NONE; // the wheel moves the camera itself (onWheel)
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 200000;
    this.controls.smoothTime = 0.12;
    this.controls.draggingSmoothTime = 0.06;
    this.controls.addEventListener('update', () => { this.dirty = true; this.needsUpdate = true; });
    canvas.addEventListener('pointerdown', this.pivotAtPointer, { capture: true });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    for (const type of ['pointermove', 'pointerup', 'pointerleave'] as const) canvas.addEventListener(type, this.trackPointer, { passive: true });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas.parentElement ?? canvas);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Open a published tileset: `urls` maps its relative paths (tileset.json, c/*.glb, objects.bin) to signed URLs. */
  open(urls: Record<string, string>, objects: number): void {
    this.closeTiles();
    this.urls = { ...urls };
    this.pathBySigned.clear();
    this.retry = { at: 0, delay: 2000 };
    this.state = new ObjectStateTexture(objects);
    this.surface = { opaque: createSurfaceMaterial(this.state, false), transparent: createSurfaceMaterial(this.state, true) };
    this.pickMaterial = createPickMaterial(this.state);
    const tiles = new TilesRenderer(`${BASE}tileset.json`);
    // Terrain photos are KTX2 (Basis): transcoded in workers to the GPU's compressed format. The plugin disposes
    // the loader with these tiles, so each opened tileset gets its own.
    const ktxLoader = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ meshoptDecoder: MeshoptDecoder, ktxLoader }));
    // Relative paths resolve against the stand-in origin for the root, but the library resolves child content against
    // the *processed* (signed) tileset URL, i.e. the run folder in R2 without a signature: map both to signed URLs.
    const runFolder = (urls['tileset.json'] ?? '').split('?')[0].replace(/tileset\.json$/, '');
    tiles.registerPlugin({
      name: 'MIR_SIGNED_URLS',
      preprocessURL: (url: string | URL) => {
        const text = String(url), bare = text.split('?')[0];
        for (const base of [BASE, runFolder]) {
          if (!base || !bare.startsWith(base)) continue;
          const path = decodeURI(bare.slice(base.length)), signed = this.urls[path];
          if (!signed) return text;
          this.pathBySigned.set(signed, path);
          return signed;
        }
        return text;
      },
    });
    // Files already seen in this browser come from its tile cache (after the URL plugin: it sees signed URLs).
    const run = runOf(urls['tileset.json'] ?? '');
    if (run) {
      const cache = tileCachePlugin(run.model, run.run, this.urls, url => this.pathBySigned.get(url) ?? null);
      tiles.registerPlugin(cache);
      this.tileCache = cache.stats;
      this.cacheApi = cache;
    } else { this.tileCache = null; this.cacheApi = null; }
    this.prefetch.abort?.abort();
    this.prefetch = { done: new Set(), bytes: 0, running: false, abort: null, finishedAt: -1 };
    this.nearby = [];
    tiles.loadAncestors = this.ancestors;
    this.applyProfile(tiles);
    tiles.setCamera(this.camera);
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    tiles.addEventListener('load-model', ({ scene, tile }) => this.adopt(scene, tile));
    tiles.addEventListener('dispose-model', ({ scene }) => this.release(scene));
    tiles.addEventListener('needs-update', () => { this.needsUpdate = true; this.dirty = true; });
    tiles.addEventListener('tile-visibility-change', () => { this.dirty = true; });
    tiles.addEventListener('load-tileset', () => {
      const box = new Box3();
      if (tiles.getBoundingBox(box)) { this.world.updateMatrixWorld(true); this.bounds = box.applyMatrix4(this.world.matrixWorld).getBoundingSphere(new Sphere()); }
      if (!this.firstFrameMs) this.frameAll(false);
      this.nearby = structureFiles((tiles as unknown as { root: Parameters<typeof structureFiles>[0] }).root);
    });
    this.world.add(tiles.group);
    this.tiles = tiles;
    this.openedAt = performance.now();
    this.firstFrameMs = this.settledMs = null;
    this.needsUpdate = this.dirty = true;
  }

  /** Renewed signed URLs (same paths) for tiles requested from now on; failed tiles are retried with them. */
  updateUrls(urls: Record<string, string>): void {
    Object.assign(this.urls, urls);
    this.retry.at = performance.now();
  }

  setTier(tier: DeviceTier): void {
    this.profile = PROFILES[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio));
    this.fit();
    if (this.tiles) this.applyProfile(this.tiles);
    this.needsUpdate = this.dirty = true;
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    if (this.tiles) this.applyProfile(this.tiles);
    this.needsUpdate = this.dirty = true;
  }

  /**
   * How fine the view is, set directly (measurements): the screen error (px) before a finer level loads and the
   * memory kept for loaded tiles (MB). null takes the value from the tier and quality.
   */
  setDetail(errorTarget: number | null, cacheMB: number | null = null): void {
    this.detail = { errorTarget, cacheMB };
    if (this.tiles) this.applyProfile(this.tiles);
    this.needsUpdate = this.dirty = true;
  }

  /** Load strategy (measurements): whether coarser levels load first while a view's own tiles arrive. */
  setLoadAncestors(on: boolean): void {
    this.ancestors = on;
    if (this.tiles) this.tiles.loadAncestors = on;
    this.needsUpdate = this.dirty = true;
  }

  /** Recolour/hide objects (dbIds) in every loaded and later loaded tile. */
  setStates(selected: Iterable<number>, highlighted: Iterable<number>, hidden: Iterable<number>): void {
    this.state?.apply(selected, highlighted, hidden);
    this.dirty = true;
  }

  /** Colour per object (colour modes: rgba per dbId, a = 255 painted) under selection and highlight; null = as modelled. */
  setPaint(paint: Uint8Array | null): void {
    this.state?.setPaint(paint);
    this.dirty = true;
  }

  /** Outlines between objects on or off. */
  setOutlines(on: boolean): void {
    if (on === !!this.outline) return;
    if (on) { this.outline = new OutlinePass(this.samples); this.fit(); }
    else { this.outline?.dispose(); this.outline = null; }
    this.dirty = true;
  }

  /** Draw the scene to the canvas now (with outlines when on); returns the scene's draw calls and triangles. */
  draw(): { calls: number; triangles: number } {
    if (this.outline) return this.outline.render(this.renderer, this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  /** Keep the view centred above a panel covering the bottom `px` CSS pixels (0 = none). */
  setBottomInset(px: number): void {
    const inset = Math.max(0, Math.round(px));
    if (inset === this.inset) return;
    this.inset = inset;
    this.applyView();
    this.needsUpdate = this.dirty = true;
  }

  /**
   * Draw the pick pass (mode 0: dbId, 1: view depth / far packed in RGBA; 0 = nothing) for the `size`×`size` drawing-
   * buffer pixels whose top-left is (`left`, `top`) of the canvas, into `target`.
   */
  private renderPick(mode: number, left: number, top: number, size: number, target: WebGLRenderTarget) {
    const ratio = this.renderer.getPixelRatio(), inset = this.inset * ratio;
    const w = this.canvas.clientWidth * ratio, h = this.canvas.clientHeight * ratio;
    this.pickMaterial!.uniforms.mode.value = mode;
    this.pickMaterial!.uniforms.far.value = this.camera.far;
    this.camera.setViewOffset(w, h + inset, left, top + inset, size, size);
    this.scene.overrideMaterial = this.pickMaterial;
    const background = this.scene.background, figure = this.walkState?.figure?.group, shown = figure?.visible;
    if (figure) figure.visible = false; // not picked
    this.scene.background = null;
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = null;
    this.scene.background = background;
    if (figure) figure.visible = !!shown;
    this.applyView();
  }

  /** World point at view depth `depth` along the ray through canvas point (x, y) (CSS px), for a camera's matrices. */
  private pointAt(x: number, y: number, depth: number, view: { world: Matrix4; projectionInverse: Matrix4 }): Vector3 {
    const eye = new Vector3().setFromMatrixPosition(view.world);
    const forward = new Vector3(0, 0, -1).transformDirection(view.world);
    const dir = new Vector3((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1, 0.5)
      .applyMatrix4(view.projectionInverse).applyMatrix4(view.world).sub(eye).normalize();
    return eye.addScaledVector(dir, depth / Math.max(1e-6, dir.dot(forward)));
  }

  /**
   * Object under a canvas position (CSS px) and its world point, or null. Waits for the GPU (two reads): for clicks;
   * wheel and drag starts use the pointer sample (sampleSurface).
   */
  pick(x: number, y: number): { dbId: number; point: Vector3 } | null {
    if (!this.pickMaterial || !this.tiles) return null;
    const ratio = this.renderer.getPixelRatio(), left = Math.floor(x * ratio), top = Math.floor(y * ratio);
    const view = { world: this.camera.matrixWorld.clone(), projectionInverse: this.camera.projectionMatrixInverse.clone() };
    const read = (mode: number) => {
      const pixel = new Uint8Array(4);
      this.renderPick(mode, left, top, 1, this.pickTarget);
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, pixel);
      return pixel;
    };
    const id = read(0);
    const dbId = (id[0] << 16) | (id[1] << 8) | id[2];
    const d = read(1);
    this.dirty = true;
    if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0) return dbId ? { dbId, point: this.controls.getTarget(new Vector3()) } : null;
    return { dbId, point: this.pointAt(x, y, unpackDepth(d, 0) * this.camera.far, view) };
  }

  /**
   * Read the depth around the pointer without waiting for the GPU: the pick material's depth pass over a small window
   * (a rail a pixel or two wide still counts), copied to a buffer that the GPU fills when it gets there
   * (readRenderTargetPixelsAsync). The synchronous pick stopped the page until the GPU had finished everything queued —
   * 95% of the time of a wheel zoom (profile of 12 notches in software GL: 32 of 34 s in readPixels).
   */
  private sampleSurface() {
    if (!this.pickMaterial || !this.tiles || !this.pointer) return;
    const { x, y } = this.pointer, ratio = this.renderer.getPixelRatio();
    const r = Math.ceil(SAMPLE_RADIUS * ratio), size = 2 * r + 1;
    if (this.sampleTarget.width !== size) this.sampleTarget.setSize(size, size);
    const left = Math.floor(x * ratio) - r, top = Math.floor(y * ratio) - r, far = this.camera.far;
    const view = { world: this.camera.matrixWorld.clone(), projectionInverse: this.camera.projectionMatrixInverse.clone() };
    this.renderPick(1, left, top, size, this.sampleTarget);
    const buffer = new Uint8Array(size * size * 4), version = this.view, epoch = this.sampleEpoch;
    this.sampledAt = performance.now();
    this.sampling = true;
    this.sampleWanted = false;
    const read = this.renderer.readRenderTargetPixelsAsync(this.sampleTarget, 0, 0, size, size, buffer);
    // three r171 leaves its pixel-pack buffer bound while it waits (it binds it again to collect the pixels): every
    // synchronous readPixels meanwhile — a click's pick — failed with INVALID_OPERATION and found nothing (ui-check 207).
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    read.then(() => {
      // The drawn pixel nearest the pointer (rows come bottom first).
      let best = -1, bestScore = Infinity;
      for (let k = 0; k < size * size; k++) {
        if (!(buffer[k * 4] | buffer[k * 4 + 1] | buffer[k * 4 + 2] | buffer[k * 4 + 3])) continue;
        const score = ((k % size) - r) ** 2 + (Math.floor(k / size) - r) ** 2;
        if (score < bestScore) { bestScore = score; best = k; }
      }
      const point = best < 0 ? null : this.pointAt((left + (best % size) + 0.5) / ratio, (top + size - 1 - Math.floor(best / size) + 0.5) / ratio,
        unpackDepth(buffer, best * 4) * far, view);
      if (epoch === this.sampleEpoch) this.sample = { x, y, view: version, point, offset: Math.sqrt(bestScore) / ratio };
    }, () => { /* context lost: the next sample tries again */ }).finally(() => { this.sampling = false; });
  }

  /** The camera is flown somewhere: what is under the mouse changes (sampled again once it rests). */
  private dropSample() {
    this.sample = null;
    this.sampleEpoch++;
  }

  /**
   * Depth along the view axis and world point of the surface at or near a canvas point (CSS px; `under`: within
   * UNDER_RADIUS), or null for empty space: from the pointer sample when it was taken there (within a few px; from this
   * very view when `exact`, the pivot of a drag), else picked now at that pixel (waiting for the GPU). A sample from
   * before a zoom still holds: zoom toward the cursor keeps the same world point under it.
   */
  private surfaceAt(x: number, y: number, exact: boolean): { depth: number; point: Vector3; under: boolean } | null {
    const s = this.sample;
    const usable = s && Math.hypot(s.x - x, s.y - y) <= (exact ? 3 : 8) && (!exact || s.view === this.view);
    if (!usable) { const hit = this.depthAt(x, y); return hit && { ...hit, under: true }; }
    if (!s.point) return null;
    const depth = s.point.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
    return depth > 0 ? { depth, point: s.point, under: s.offset <= UNDER_RADIUS } : null;
  }

  /**
   * Zoom / pan depth at a canvas point: the surface under it; else the nearer of a surface beside it (the thin band of a
   * long site seen whole) and the ground under it — with the pointer just below a structure the ground comes first (the
   * structure's depth put the target below the ground there: 12 quick notches took the camera under the site); else
   * the ground or the site centre.
   */
  private depthNear(x: number, y: number, hit: { depth: number; under: boolean } | null): number | undefined {
    if (hit?.under) return hit.depth;
    const ground = this.emptyDepth(x, y);
    if (!hit) return ground;
    return ground === undefined ? hit.depth : Math.min(hit.depth, ground);
  }

  /**
   * Zoom / pan depth over empty space (sky, the background around a long site seen whole — most of that view): where
   * the pointer's ray meets the site's mid height, else the site centre's depth. The orbit distance used before shrank
   * with every zoom step, so zooming over empty space slowed to a stop (user report: "멀리서 휠로 당기면 점점 안 당겨짐").
   */
  private emptyDepth(x: number, y: number): number | undefined {
    const b = this.bounds;
    if (!b) return undefined;
    const eye = this.camera.position, forward = this.camera.getWorldDirection(new Vector3());
    const dir = new Vector3((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1, 0.5)
      .unproject(this.camera).sub(eye).normalize();
    const reach = eye.distanceTo(b.center) + b.radius;
    // The mid-height plane from above, or from below for an eye under it (in a tunnel, under the ground): the site
    // centre's depth there was 1.6 km, and a drag over the sky-coloured gap rotated about it — the camera flew 650 m.
    const level = (eye.y - b.center.y) / -dir.y;
    const ground = Math.abs(dir.y) > 1e-3 && level > 0 ? Math.min(level, reach) * dir.dot(forward) : 0;
    const depth = ground > 0 ? ground : b.center.clone().sub(eye).dot(forward);
    return depth > this.controls.minDistance * 2 ? depth : undefined;
  }

  /** Fly to a tileset-frame box [minX, minY, minZ, maxX, maxY, maxZ] (Z-up). */
  frameBox(box: ArrayLike<number>, animate = true): void {
    this.setWalk(false);
    const corners = new Box3();
    for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]])
      corners.expandByPoint(new Vector3(x, y, z).applyMatrix4(this.world.matrixWorld));
    // Bounding sphere, not box: a box fit looks along the current direction and can end up inside a long object.
    const sphere = corners.getBoundingSphere(new Sphere());
    sphere.radius = Math.max(sphere.radius * 1.1, 1);
    this.dropSample();
    this.centreTarget();
    void this.controls.fitToSphere(sphere, animate);
    this.needsUpdate = this.dirty = true;
  }

  /**
   * The whole tileset, seen from the side of its main horizontal direction at 35° so a long site (railway, road)
   * spans the screen width instead of a thin diagonal line. The direction is the principal axis of the upper tiles'
   * centres; a compact site just gets an oblique view.
   */
  frameAll(animate = true): void {
    if (!this.bounds) return;
    this.setWalk(false);
    this.dropSample();
    this.centreTarget();
    type TileNode = { boundingVolume?: { box?: number[] }; children?: TileNode[]; extras?: { mir?: string } };
    const boxes: number[][] = [];
    const visit = (t: TileNode, depth: number) => {
      if (t.boundingVolume?.box) boxes.push(t.boundingVolume.box);
      if (depth < 3) for (const c of t.children ?? []) visit(c, depth + 1);
    };
    // The site is the structures: the terrain (several km of photo) would shrink them to a line.
    const top = (this.tiles as unknown as { root: TileNode | null } | null)?.root;
    const root = top?.children?.find(c => c.extras?.mir === 'structure') ?? top;
    if (root) visit(root, 0);
    if (!boxes.length) {
      const { center: c, radius } = this.bounds, d = radius * 1.6;
      void this.controls.setLookAt(c.x + d * 0.5, c.y + d * 0.6, c.z + d * 0.6, c.x, c.y, c.z, animate);
      this.needsUpdate = this.dirty = true;
      return;
    }
    let mx = 0, my = 0;
    for (const b of boxes) { mx += b[0]; my += b[1]; }
    mx /= boxes.length; my /= boxes.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const b of boxes) { sxx += (b[0] - mx) ** 2; syy += (b[1] - my) ** 2; sxy += (b[0] - mx) * (b[1] - my); }
    const angle = boxes.length > 2 ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : -Math.PI / 4;
    const u = [Math.cos(angle), Math.sin(angle)], v = [-u[1], u[0]];
    // Extent along / across the axis and the height range (box centre ± half axes projected).
    let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of boxes) {
      const along = Math.abs(u[0] * b[3] + u[1] * b[4]) + Math.abs(u[0] * b[6] + u[1] * b[7]) + Math.abs(u[0] * b[9] + u[1] * b[10]);
      const across = Math.abs(v[0] * b[3] + v[1] * b[4]) + Math.abs(v[0] * b[6] + v[1] * b[7]) + Math.abs(v[0] * b[9] + v[1] * b[10]);
      const p = u[0] * b[0] + u[1] * b[1], q = v[0] * b[0] + v[1] * b[1], h = Math.abs(b[5]) + Math.abs(b[8]) + Math.abs(b[11]);
      a0 = Math.min(a0, p - along); a1 = Math.max(a1, p + along);
      c0 = Math.min(c0, q - across); c1 = Math.max(c1, q + across);
      z0 = Math.min(z0, b[2] - h); z1 = Math.max(z1, b[2] + h);
    }
    const along = (a0 + a1) / 2, across = (c0 + c1) / 2;
    const centre = new Vector3(u[0] * along + v[0] * across, u[1] * along + v[1] * across, (z0 + z1) / 2).applyMatrix4(this.world.matrixWorld);
    const halfLength = (a1 - a0) / 2, halfWidth = Math.max((c1 - c0) / 2, (z1 - z0) / 2);
    const vfov = (this.camera.fov * Math.PI) / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const elevation = (35 * Math.PI) / 180;
    const distance = Math.max(halfLength / Math.tan(hfov / 2), halfWidth / Math.tan(vfov / 2)) * 1.1 + halfWidth;
    // From the side (−v) and above, in the tileset frame, then to the scene frame.
    const eye = new Vector3(-v[0] * Math.cos(elevation), -v[1] * Math.cos(elevation), Math.sin(elevation))
      .transformDirection(this.world.matrixWorld).multiplyScalar(distance).add(centre);
    void this.controls.setLookAt(eye.x, eye.y, eye.z, centre.x, centre.y, centre.z, animate);
    this.needsUpdate = this.dirty = true;
  }

  stats(): ViewerStats {
    const info = this.renderer.info, ts = (this.tiles as unknown as { stats?: TileStats } | null)?.stats;
    // Frames drawn in the last second (rendering is on demand: 0 while nothing changes).
    const now = performance.now(), recent = this.frameTimes.filter(t => now - t <= 1000);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    // Bytes of the tiles the current view uses (shown, their loaded parents, queued): what the cache must hold.
    const lru = this.tiles?.lruCache as unknown as { cachedBytes: number; usedSet: Set<unknown>; bytesMap: Map<unknown, number> } | undefined;
    let used = 0;
    lru?.usedSet.forEach(tile => { used += lru.bytesMap.get(tile) ?? 0; });
    return {
      fps: recent.length, frames: this.frames,
      drawCalls: this.frame.calls, triangles: this.frame.triangles, geometries: info.memory.geometries,
      tilesVisible: this.tiles?.visibleTiles.size ?? 0, tilesLoaded: ts?.loaded ?? 0,
      downloading: ts?.downloading ?? 0, parsing: ts?.parsing ?? 0, failed: ts?.failed ?? 0,
      cacheMB: Math.round((lru?.cachedBytes ?? 0) / 1048576), usedMB: Math.round(used / 1048576),
      heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
      tier: this.profile.tier, errorTarget: this.tiles?.errorTarget ?? this.detail.errorTarget ?? detailOf(this.profile, this.quality).errorTarget,
      firstFrameMs: this.firstFrameMs, settledMs: this.settledMs, cacheHits: this.tileCache?.hits ?? 0,
      prefetched: this.tileCache?.prefetched ?? 0, prefetchedMB: Math.round((this.tileCache?.prefetchedBytes ?? 0) / 1048576),
    };
  }

  dispose(): void {
    this.setWalk(false);
    this.collision.dispose();
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pivotAtPointer, { capture: true });
    this.canvas.removeEventListener('wheel', this.onWheel);
    for (const type of ['pointermove', 'pointerup', 'pointerleave'] as const) this.canvas.removeEventListener(type, this.trackPointer);
    this.closeTiles();
    this.controls.dispose();
    this.pickTarget.dispose();
    this.sampleTarget.dispose();
    this.roomTarget.dispose();
    this.outline?.dispose();
    this.renderer.dispose();
  }

  private closeTiles() {
    this.bounds = null;
    this.lastPivot = null;
    this.terrainScenes.clear();
    if (this.tiles) { this.world.remove(this.tiles.group); this.tiles.dispose(); this.tiles = null; }
    this.surface?.opaque.dispose(); this.surface?.transparent.dispose(); this.pickMaterial?.dispose();
    this.state?.texture.dispose();
    this.surface = null; this.pickMaterial = null; this.state = null;
  }

  private applyProfile(tiles: TilesRenderer) {
    const p = this.profile, chosen = detailOf(p, this.quality);
    const cacheMB = this.detail.cacheMB ?? chosen.cacheMB;
    tiles.errorTarget = this.detail.errorTarget ?? chosen.errorTarget;
    tiles.lruCache.maxBytesSize = cacheMB * 1048576;
    tiles.lruCache.minBytesSize = cacheMB * 1048576 * (p.minBytes / p.maxBytes);
    tiles.parseQueue.maxJobs = p.parseJobs;
    tiles.downloadQueue.maxJobsPerOrigin = p.downloadJobs;
  }

  /**
   * Structures: shared state-aware materials instead of the loader's per-tile ones (those stay in the tile's disposal
   * list). Terrain (tagged in the tileset): a lit photo material per primitive, released with the tile.
   */
  private adopt(scene: Object3D, tile?: unknown) {
    if (!this.surface) return;
    const terrain = (tile as { extras?: { mir?: string } } | undefined)?.extras?.mir === 'terrain';
    scene.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      this.watchUpload(mesh.geometry);
      if (terrain) {
        const photo = (mesh.material as MeshStandardMaterial).map;
        mesh.material = createTerrainMaterial(photo ?? null);
        return;
      }
      mesh.material = mesh.material.transparent ? this.surface!.transparent : this.surface!.opaque;
    });
    if (terrain) { this.terrainScenes.add(scene); scene.visible = this.terrainShown; }
    this.dirty = this.sampleWanted = this.roomWanted = true;
  }

  /** Note when the GPU has a geometry's positions and index (collision.ts lends them to its worker only then). */
  private watchUpload(geometry: BufferGeometry) {
    const position = geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute;
    const holders = [('isInterleavedBufferAttribute' in position && position.isInterleavedBufferAttribute) ? position.data : position as BufferAttribute,
      ...(geometry.index ? [geometry.index] : [])];
    const uploaded = this.uploaded;
    let left = holders.length;
    for (const holder of holders) {
      const before = holder.onUploadCallback;
      holder.onUpload(function (this: unknown) {
        before.call(this);
        if (--left === 0) uploaded.add(geometry);
      });
    }
  }

  /** A tile left the cache: dispose the terrain materials made in adopt (the library disposes its own). */
  private release(scene: Object3D) {
    if (!this.terrainScenes.delete(scene)) return;
    scene.traverse(o => { const mesh = o as Mesh; if (mesh.isMesh && !Array.isArray(mesh.material)) mesh.material.dispose(); });
  }

  /** Show or hide the terrain (aerial photo surface); tiles loaded later follow. */
  setTerrainVisible(shown: boolean): void {
    this.terrainShown = shown;
    for (const scene of this.terrainScenes) scene.visible = shown;
    this.dirty = true;
  }

  /**
   * A still for reports: the view at `scale`× the canvas resolution, every visible part refined until its error is
   * under `errorPx` image pixels (finer than on screen, where distant parts may thin out), rendered once loading has
   * settled. The view settings come back afterwards.
   */
  async capture({ scale = 2, errorPx = 1.5, maxWaitMs = 180_000, onProgress }: {
    scale?: number; errorPx?: number; maxWaitMs?: number;
    onProgress?: (p: { seconds: number; loaded: number; loading: number }) => void;
  } = {}): Promise<Blob> {
    const tiles = this.tiles;
    if (!tiles) throw new Error('모델을 먼저 여세요.');
    const gl = this.renderer.getContext();
    const el = this.canvas.parentElement ?? this.canvas;
    const largest = Math.max(1, el.clientWidth, el.clientHeight);
    const ratio = Math.max(1, Math.min(scale, (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) / largest, 8192 / largest));
    const saved = { ratio: this.renderer.getPixelRatio(), error: tiles.errorTarget, max: tiles.lruCache.maxBytesSize, min: tiles.lruCache.minBytesSize };
    const MB = 1048576;
    try {
      this.renderer.setPixelRatio(ratio);
      this.fit();
      tiles.errorTarget = errorPx / ratio; // the tiles' resolution is in CSS px
      tiles.lruCache.maxBytesSize = Math.max(saved.max, Math.min(saved.max * 2, 1536 * MB));
      tiles.lruCache.minBytesSize = Math.max(saved.min, tiles.lruCache.maxBytesSize * 0.75);
      const start = performance.now();
      let quiet = 0;
      while (performance.now() - start < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 300));
        this.needsUpdate = this.dirty = true;
        const st = (tiles as unknown as { stats: TileStats & { queued: number; refused: number } }).stats;
        const busy = loading(tiles) || st.downloading > 0 || st.parsing > 0 || st.queued > 0;
        onProgress?.({ seconds: Math.round((performance.now() - start) / 1000), loaded: st.loaded, loading: st.queued + st.downloading + st.parsing });
        quiet = busy ? 0 : quiet + 1;
        if (quiet >= 4) break;
      }
      if (!this.walkState) this.controls.update(0);
      this.camera.updateMatrixWorld();
      this.draw();
      // The drawing buffer is read in this task, before the browser composites (no preserveDrawingBuffer needed).
      return await new Promise<Blob>((resolve, reject) => this.canvas.toBlob(b => (b ? resolve(b) : reject(new Error('이미지를 만들지 못했습니다.'))), 'image/png'));
    } finally {
      tiles.errorTarget = saved.error;
      tiles.lruCache.maxBytesSize = saved.max;
      tiles.lruCache.minBytesSize = saved.min;
      this.renderer.setPixelRatio(saved.ratio);
      this.fit();
    }
  }

  /** Fly the camera to look at `target` from `eye` (both in scene coordinates). */
  lookAt(eye: Vector3, target: Vector3, animate = true): void {
    this.setWalk(false);
    this.dropSample();
    this.centreTarget();
    void this.controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, animate);
    this.needsUpdate = this.dirty = true;
  }

  /**
   * Stop any easing where the camera is now. Changing the pivot during an easing (setOrbitPoint "should not run
   * during animations") let the rest of the motion swing about the new pivot — the camera jumped.
   */
  private freeze() {
    const c = this.controls;
    const p = c.getPosition(new Vector3(), false), t = c.getTarget(new Vector3(), false), f = c.getFocalOffset(new Vector3(), false);
    void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    void c.setFocalOffset(f.x, f.y, f.z, false);
    (c as unknown as { _changedDolly: number })._changedDolly = 0; // a pending zoom-to-cursor shift
  }

  /**
   * Put the target on the view axis at `depth` (default: the current distance) with no focal offset, without moving
   * the view. Zoom toward the cursor assumes the target is on the axis, and zoom and pan steps scale with its distance:
   * a stale target far behind what is on screen made one wheel step or pan fly hundreds of metres.
   */
  private centreTarget(depth?: number) {
    this.freeze();
    this.controls.update(0);
    this.camera.updateMatrixWorld();
    const eye = this.camera.position.clone(), dir = this.camera.getWorldDirection(new Vector3());
    const d = Math.max(depth ?? this.controls.distance, this.controls.minDistance * 2);
    const t = eye.clone().addScaledVector(dir, d);
    void this.controls.setFocalOffset(0, 0, 0, false);
    void this.controls.setLookAt(eye.x, eye.y, eye.z, t.x, t.y, t.z, false);
    this.settleControls();
  }

  /**
   * Let camera-controls take a distance set without a transition as its last one. Zoom toward the cursor shifts the
   * target by (distance now − last distance); with the last one still the old orbit distance, the first notch after
   * re-aiming took that whole difference as zoom: a target 346 m deep moved to a surface 32 m away, one notch with
   * the cursor off-centre threw the camera 127 m sideways (ui-check 207/208; with the cursor at the centre, as in the
   * first camera check, the shift is about zero).
   */
  private settleControls() {
    this.controls.update(0);
  }

  /** Depth along the view axis of the surface under a canvas point (CSS px), or null for empty space. */
  private depthAt(x: number, y: number): { depth: number; point: Vector3 } | null {
    const hit = this.pick(x, y);
    if (!hit) return null;
    const dir = this.camera.getWorldDirection(new Vector3());
    const depth = hit.point.clone().sub(this.camera.position).dot(dir);
    return depth > 0 ? { depth, point: hit.point } : null;
  }

  /**
   * Pointer down: rotate about the surface under the pointer (objects and terrain), or for a drag that starts over
   * empty space about emptyPivot; pan and pinch at the depth from depthNear, with the target back on the view axis.
   */
  private pivotAtPointer = (event: PointerEvent) => {
    if (!this.tiles || this.walkState) return;
    const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const hit = this.surfaceAt(x, y, true);
    let pivot = event.button === 0 && event.isPrimary ? (hit?.under ? hit.point : this.emptyPivot(hit)) : null;
    if (pivot && Number.isFinite(this.room)) {
      // In a room, about a point near the eye along that direction (rotating about the far end of a tunnel swung the eye
      // through the walls).
      const eye = this.camera.position, d = pivot.distanceTo(eye), reach = PIVOT_REACH * this.room;
      if (d > reach) pivot = eye.clone().lerp(pivot, reach / d);
    }
    if (pivot) {
      if (hit?.under) this.lastPivot = hit.point.clone();
      this.freeze();
      this.controls.setOrbitPoint(pivot.x, pivot.y, pivot.z);
      this.settleControls(); // a pinch right after must not zoom by the old orbit distance
    } else this.centreTarget(this.depthNear(x, y, hit));
    this.needsUpdate = this.dirty = true;
  };

  /**
   * Pivot of a drag that starts over empty space (the sky-coloured gaps around a tunnel, beside a structure): a surface
   * beside the pointer; else the last pivot while it is still in front and on screen (rotating about it keeps it in
   * place); else the surface at the screen centre. Null: the view's depth as before. Rotating about the site centre's
   * depth instead threw the camera hundreds of metres from a tunnel (user report "터널에서 회전 시 튐", measured 650 m
   * and 109 tiles reloaded on one drag).
   */
  private emptyPivot(beside: { point: Vector3 } | null): Vector3 | null {
    if (beside) return beside.point;
    const last = this.lastPivot;
    if (last) {
      const ndc = last.clone().project(this.camera);
      const depth = last.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
      if (depth > this.controls.minDistance * 2 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) return last;
    }
    return this.depthAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2)?.point ?? null;
  }

  /**
   * Wheel: a notch moves the camera along the ray under the cursor, 15.7% of the way to the surface at or near the cursor
   * (else the ground under it, depthNear) as camera-controls' zoom toward the cursor did — that way counted between
   * ROOM_MIN and ROOM_REACH room sizes inside a room, and stopping WHEEL_STOP m before a surface under the cursor. The
   * point is found once per scroll gesture (the pointer sample, no GPU wait while the mouse rests there): moving along
   * the cursor's ray keeps it under the cursor. Out is the inverse of in (a notch in and one out come back).
   */
  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!this.tiles || !event.deltaY) return;
    if (this.walkState) { this.changeWalkSpeed(event.deltaY < 0 ? SPEED_STEP : 1 / SPEED_STEP); return; }
    const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const now = performance.now();
    let g = this.wheelGesture;
    if (!g || now - g.at > 300 || Math.hypot(g.x - x, g.y - y) > 3) {
      const hit = this.surfaceAt(x, y, false), depth = this.depthNear(x, y, hit);
      if (depth === undefined) return;
      // The orbit target on the view axis at that depth (within the room): the near plane follows it. The view stays.
      this.centreTarget(Number.isFinite(this.room) ? Math.min(depth, ROOM_REACH * this.room) : depth);
      const point = this.pointAt(x, y, depth, { world: this.camera.matrixWorld, projectionInverse: this.camera.projectionMatrixInverse });
      g = this.wheelGesture = { x, y, at: now, point, surface: !!hit?.under };
    }
    g.at = now;
    // camera-controls' wheel scale: 0.95 per unit, a mouse notch (deltaY 100) 3.3 units off a Mac, 10 on one.
    const mac = /Mac/.test(navigator.platform);
    const units = event.deltaMode === 1 && !event.ctrlKey ? Math.abs(event.deltaY) / (mac ? 1 : 3) : Math.abs(event.deltaY) / (mac ? 10 : 30);
    const scale = Math.pow(0.95, Math.min(units, 30));
    const eye = this.controls.getPosition(new Vector3()), target = this.controls.getTarget(new Vector3());
    const ray = g.point.clone().sub(eye), reach = ray.length();
    if (reach < 1e-6) return;
    ray.divideScalar(reach);
    const forward = event.deltaY < 0, step = wheelStep(reach, this.room, scale, forward, g.surface);
    if (step < 1e-4) return;
    ray.multiplyScalar(forward ? step : -step);
    eye.add(ray); target.add(ray);
    void this.controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, true);
    this.needsUpdate = this.dirty = true;
  };

  /**
   * Measure the room size (roomSize) of a resting view without waiting for the GPU: the pick material's depth pass over
   * the whole view at ROOM_W × ROOM_H pixels.
   */
  private sampleRoom() {
    if (!this.pickMaterial || !this.tiles) return;
    const far = this.camera.far, version = this.view;
    this.pickMaterial.uniforms.mode.value = 1;
    this.pickMaterial.uniforms.far.value = far;
    this.scene.overrideMaterial = this.pickMaterial;
    const background = this.scene.background;
    this.scene.background = null;
    this.renderer.setRenderTarget(this.roomTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = null;
    this.scene.background = background;
    const buffer = new Uint8Array(ROOM_W * ROOM_H * 4);
    this.roomSampling = true;
    this.roomWanted = false;
    this.sampledAt = performance.now();
    const read = this.renderer.readRenderTargetPixelsAsync(this.roomTarget, 0, 0, ROOM_W, ROOM_H, buffer);
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); // as in sampleSurface
    read.then(() => { if (version === this.view) this.room = roomSize(buffer, far); }, () => {}).finally(() => { this.roomSampling = false; });
  }

  /**
   * A mouse over the canvas with no button held keeps the surface sample under it fresh; a drag (it turns or moves the
   * view: the sampled point is no longer under the pointer) or leaving stops it.
   */
  private trackPointer = (event: PointerEvent) => {
    const hover = event.type !== 'pointerleave' && event.pointerType === 'mouse' && event.buttons === 0;
    if (!hover && event.type === 'pointermove') this.dropSample();
    this.pointer = hover ? { x: event.offsetX, y: event.offsetY } : null;
    if (hover) this.sampleWanted = true;
  };

  /**
   * Projection for the canvas, shifted up by half the bottom inset: the canvas is the lower window of a taller virtual
   * view, so the view centre sits in the middle of the uncovered part.
   */
  private applyView() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    const inset = this.inset < h * 0.8 ? this.inset : 0;
    this.camera.aspect = w / (h + inset);
    if (inset) this.camera.setViewOffset(w, h + inset, 0, inset, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private fit() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.outline?.setSize(size.x, size.y);
    this.applyView();
    this.tiles?.setResolutionFromRenderer(this.camera, this.renderer);
    this.needsUpdate = this.dirty = true;
  }

  /**
   * Fetch the structure files of the tiles within 300–600 m of the camera into the tile cache, nearest first, six at a
   * time (the tiles' two host names allow twelve), until the camera moves, tiles start loading or the model's budget
   * (profile.prefetchMB) is spent (prefetch.ts). A 250 m move after 45 s at rest: 4.0 s → 2.7 s with three at a time
   * within 200–500 m and no upper levels (25 of 48 tiles from the cache; the misses were upper levels and tiles 320 m
   * away).
   */
  private async prefetchRound() {
    const p = this.prefetch, tiles = this.tiles, cache = this.cacheApi;
    if (p.running || !tiles || !cache || !this.nearby.length) return;
    const eye = tiles.group.worldToLocal(this.camera.position.clone());
    const reach = Math.min(600, Math.max(300, this.controls.distance * 4));
    const paths = nearestFiles(this.nearby, eye.toArray(), reach, p.done), view = this.view;
    if (!paths.length) { p.finishedAt = view; return; }
    p.running = true;
    const abort = (p.abort = new AbortController()), budget = this.profile.prefetchMB * 1048576;
    let next = 0;
    const go = () => !abort.signal.aborted && this.tiles === tiles && !loading(tiles) && p.bytes < budget;
    try {
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < paths.length && go()) {
          const path = paths[next++], url = this.urls[path];
          p.done.add(path);
          if (!url || (await cache.has(path))) continue;
          try { p.bytes += await cache.store(path, url, abort.signal); } catch { p.done.delete(path); } // aborted or failed: later
        }
      }));
      if (next >= paths.length || p.bytes >= budget) p.finishedAt = view; // nothing left here: wait for the camera to move
    } finally {
      if (p.abort === abort) p.abort = null;
      p.running = false;
    }
  }

  /** Whether walk mode is on (setWalk). */
  get walking(): boolean { return !!this.walkState; }

  /**
   * Walk mode on or off (walk.ts). On: the person stands at `from` (startWalkAt), else on the floor under the eye (no
   * long fall from a view high above; outside the model it floats there); the orbit controls rest, keys move it, a drag
   * looks around, the wheel sets the speed. Off: the orbit controls take over at the person's eye, looking where the
   * person looked — not from the figure's follow camera, tilted down at the floor beside it: there a wheel notch went
   * 15.7% of the way to that floor, 2.5 → 1.4 m and less (user report "보행모드 끝내고나면 휠로 확대할 때 느림").
   */
  setWalk(on: boolean, from?: { point: Vector3; yaw: number }): void {
    if (on === !!this.walkState) return;
    if (on) {
      if (!this.tiles) return;
      this.freeze();
      this.controls.update(0);
      this.camera.updateMatrixWorld();
      const eye = this.camera.position.clone(), dir = this.camera.getWorldDirection(new Vector3());
      const height = this.walkPrefs.height;
      const walker: Walker = { feet: from ? from.point.clone() : eye.clone().setY(eye.y - eyeHeight({ height })), vy: 0, grounded: false,
        gravity: true, collide: true, height };
      const yaw = from ? from.yaw : Math.atan2(-dir.x, -dir.z);
      this.walkState = { walker, yaw, pitch: from ? 0 : Math.asin(Math.max(-0.99, Math.min(0.99, dir.y))),
        speed: WALK_SPEED, keys: new Set(), jump: false, start: { eye, point: from?.point.clone() ?? null, yaw },
        eyeY: walker.feet.y + eyeHeight(walker), look: null, meshes: null, standIns: null, figure: null, heading: yaw, follow: 0 };
      this.showFigure(this.walkPrefs.figure);
      this.controls.enabled = false;
      window.addEventListener('keydown', this.walkKey);
      window.addEventListener('keyup', this.walkKey);
      window.addEventListener('blur', this.walkBlur);
      window.addEventListener('contextmenu', this.walkMenu);
      for (const type of WALK_POINTER) this.canvas.addEventListener(type, this.walkLook);
    } else {
      const s = this.walkState!;
      s.figure?.dispose();
      this.walkState = null;
      window.removeEventListener('keydown', this.walkKey);
      window.removeEventListener('keyup', this.walkKey);
      window.removeEventListener('blur', this.walkBlur);
      window.removeEventListener('contextmenu', this.walkMenu);
      for (const type of WALK_POINTER) this.canvas.removeEventListener(type, this.walkLook);
      this.shownLately.clear();
      this.collision.want([]);
      const eye = new Vector3(s.walker.feet.x, s.eyeY, s.walker.feet.z);
      const ahead = new Vector3(0, 0, -5).applyEuler(new Euler(s.pitch, s.yaw, 0, 'YXZ')).add(eye);
      this.controls.enabled = true;
      // The focal offset left from before the walk (zoom toward the cursor) put the camera 1.5 m off the eye.
      void this.controls.setFocalOffset(0, 0, 0, false);
      void this.controls.setLookAt(eye.x, eye.y, eye.z, ahead.x, ahead.y, ahead.z, false);
      this.settleControls();
    }
    this.dropSample();
    this.needsUpdate = this.dirty = true;
    this.emitWalk();
  }

  /**
   * Walk mode settings: gravity (the feet follow the floor, falls), collision (visible objects stop the body), the
   * construction worker figure (third person) or none (first person), and the person's height (m).
   */
  setWalkOptions({ gravity, collide, figure, height }: { gravity?: boolean; collide?: boolean; figure?: boolean; height?: number }): void {
    if (figure !== undefined) this.walkPrefs.figure = figure;
    if (height !== undefined && Number.isFinite(height)) this.walkPrefs.height = Math.min(MAX_STATURE, Math.max(MIN_STATURE, height));
    const s = this.walkState, w = s?.walker;
    if (w) {
      if (gravity !== undefined) { w.gravity = gravity; w.grounded = false; w.vy = 0; }
      if (collide !== undefined) w.collide = collide;
      w.height = this.walkPrefs.height;
      if (figure !== undefined) this.showFigure(figure);
    }
    this.dirty = true;
    this.emitWalk();
  }

  private showFigure(on: boolean) {
    const s = this.walkState;
    if (!s || on === !!s.figure) return;
    if (on) { s.figure = new WorkerFigure(); s.heading = s.yaw; s.follow = 0; this.scene.add(s.figure.group); }
    else { s.figure?.dispose(); s.figure = null; }
  }

  private changeWalkSpeed(factor: number) {
    const s = this.walkState;
    if (!s) return;
    s.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, s.speed * factor));
    this.emitWalk();
  }

  private emitWalk() {
    const s = this.walkState;
    this.onWalk?.({ on: !!s, speed: s?.speed ?? WALK_SPEED, gravity: s?.walker.gravity ?? true, collide: s?.walker.collide ?? true,
      figure: this.walkPrefs.figure, height: this.walkPrefs.height });
  }

  /**
   * Walk keys held (pressed outside a text field); arrows and Space do not scroll the page meanwhile, nor does Space
   * press the focused button (the 「보행」 toggle ended the walk). A release counts wherever the focus is now.
   */
  private walkKey = (event: KeyboardEvent) => {
    const s = this.walkState, target = event.target as HTMLElement | null;
    if (!s || !WALK_KEYS.has(event.code)) return;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (event.type === 'keyup') { s.keys.delete(event.code); if (!typing) event.preventDefault(); return; }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    s.keys.add(event.code);
    if (event.code === 'Space' && !event.repeat) s.jump = true;
    event.preventDefault();
  };

  private walkBlur = () => { this.walkState?.keys.clear(); };

  /**
   * The browser's menu while walking: none over the canvas (a right drag looks around; the orbit controls keep it away
   * otherwise, but they rest now); elsewhere it opens and takes the keys' releases, so the held keys are let go. Open
   * over the canvas, it took W's release and the person walked on (user report "W 키를 떼도 앞으로 감").
   */
  private walkMenu = (event: MouseEvent) => {
    if (event.target === this.canvas) event.preventDefault();
    else this.walkState?.keys.clear();
  };

  /**
   * Walk from the surface at a canvas point (CSS px; user request "보행 시작 위치를 마우스 클릭으로 지정"): the person
   * stands on the floor there, or before the wall or under the ceiling clicked (walk.ts standingSpot), facing away from
   * the camera. False when nothing is drawn there.
   */
  startWalkAt(x: number, y: number): boolean {
    if (!this.tiles || this.walkState) return false;
    const hit = this.pick(x, y);
    if (!hit) return false;
    const dir = this.camera.getWorldDirection(new Vector3());
    // Facing away from the camera; where exactly to stand is found once the tiles there are indexed (walkFrame).
    this.setWalk(true, { point: hit.point, yaw: standingSpot(hit.point, this.camera.position, Math.atan2(-dir.x, -dir.z), () => null).yaw });
    return true;
  }

  /** A drag looks around from where the person stands, or around the figure (right: turn right, up: look up). */
  private walkLook = (event: PointerEvent) => {
    const s = this.walkState;
    if (!s) return;
    if (event.type === 'pointerdown') { s.look = { id: event.pointerId, x: event.clientX, y: event.clientY }; return; }
    if (!s.look || event.pointerId !== s.look.id) return;
    if (event.type !== 'pointermove') { s.look = null; return; }
    const rate = Math.PI / Math.max(300, this.canvas.clientHeight); // half a turn over the canvas height
    s.yaw -= (event.clientX - s.look.x) * rate;
    s.pitch = Math.max(-1.5, Math.min(1.5, s.pitch - (event.clientY - s.look.y) * rate));
    s.look.x = event.clientX; s.look.y = event.clientY;
  };

  /**
   * One frame of walk mode: keys → a move in the view's direction, walk.ts physics, then the camera at the eye or, with
   * the figure, behind it (the figure turns toward where it walks — backwards it keeps facing ahead — and swings its
   * limbs with the distance walked).
   */
  private walkFrame(dt: number): boolean {
    const s = this.walkState!, w = s.walker;
    dt = Math.min(dt, 0.25); // a stalled frame (tab in the background) is not a long fall
    s.meshes = this.visibleMeshes();
    s.standIns = null;
    this.missed.clear();
    const now = performance.now();
    for (const mesh of s.meshes) if (this.collision.has(mesh.geometry)) this.shownLately.set(mesh, now);
    for (const [mesh, at] of this.shownLately) if (now - at > STAND_IN * 1000) this.shownLately.delete(mesh);
    const k = keysToMove(s.keys), speed = s.speed * (k.run ? RUN_FACTOR : 1);
    let from = w.feet.clone();
    if (s.start) {
      if (this.settleStart(s)) from = w.feet.clone();
    } else {
      const move = new Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)).multiplyScalar(-k.back)
        .addScaledVector(new Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw)), k.right);
      if (move.lengthSq() > 1) move.normalize();
      move.multiplyScalar(speed * dt);
      const vy = w.vy, grounded = w.grounded;
      this.castMissing = false;
      stepWalker(w, move, k.up * speed * dt, dt, this.walkCast, k.jump || s.jump);
      // A tile around not indexed yet (just loaded): stand this frame rather than walk through or fall through it.
      if (this.castMissing) { w.feet.copy(from); w.vy = vy; w.grounded = grounded; } else s.jump = false;
    }
    // Up a step the eye eases in (about 0.1 s); down and falling it follows at once.
    const eyeY = w.feet.y + eyeHeight(w);
    s.eyeY = eyeY > s.eyeY + 1e-3 ? s.eyeY + (eyeY - s.eyeY) * Math.min(1, dt * 15) : eyeY;
    const before = this.camera.position.clone(), turn = this.camera.quaternion.clone();
    const figure = s.figure;
    this.camera.quaternion.setFromEuler(new Euler(Math.max(-1.5, s.pitch + (figure ? VIEW_TILT : 0)), s.yaw, 0, 'YXZ'));
    if (figure) {
      const walked = Math.hypot(w.feet.x - from.x, w.feet.z - from.z), backwards = k.back > 0 && !k.right;
      if (walked > 1e-5) {
        const heading = backwards ? s.yaw : Math.atan2(-(w.feet.x - from.x), -(w.feet.z - from.z));
        const turnBy = Math.atan2(Math.sin(heading - s.heading), Math.cos(heading - s.heading));
        s.heading += turnBy * Math.min(1, dt * 12);
      }
      figure.place({ x: w.feet.x, y: s.eyeY - eyeHeight(w), z: w.feet.z }, s.heading, w.height);
      figure.pose(dt, backwards ? -walked : walked, k.run, !w.grounded && w.gravity);
      // Behind, above and right of the head along the view, pulled in before whatever is between.
      const scale = w.height / STATURE, head = new Vector3(w.feet.x, s.eyeY + 0.1 * scale, w.feet.z);
      const look = new Quaternion().setFromEuler(new Euler(s.pitch, s.yaw, 0, 'YXZ'));
      const back = new Vector3(SHOULDER, 0, FOLLOW).applyQuaternion(look).multiplyScalar(scale);
      back.y += FOLLOW_UP * scale;
      const want = back.length(), dir = back.divideScalar(want);
      const hit = this.walkCast(head, dir, want + 0.25);
      const room = hit ? Math.max(0.2, hit.distance - 0.25) : want;
      s.follow = room < s.follow ? room : Math.min(room, s.follow + dt * 4); // in at once, out gently
      this.camera.position.copy(head).addScaledVector(dir, s.follow);
      figure.group.visible = s.follow > FIGURE_NEAR * scale;
    } else this.camera.position.set(w.feet.x, s.eyeY, w.feet.z);
    this.camera.updateMatrixWorld();
    this.indexAround(s.meshes, w.feet);
    // Draw while the figure is still moving its limbs to a stand.
    return this.camera.position.distanceToSquared(before) > 1e-10 || this.camera.quaternion.angleTo(turn) > 1e-6
      || (!!figure && (s.keys.size > 0 || !w.grounded || figure.settling));
  }

  /**
   * Once the tiles at the start are indexed: the person on the floor at or under the clicked point (walk.ts
   * standingSpot), or on the floor under the eye (none: at eye height minus the eye's). False while waiting.
   */
  private settleStart(s: NonNullable<TilesViewer['walkState']>): boolean {
    const start = s.start!, w = s.walker;
    this.castMissing = false;
    if (start.point) {
      const spot = standingSpot(start.point, start.eye, start.yaw, this.walkCast);
      if (this.castMissing) return false;
      w.feet.copy(spot.feet);
      w.grounded = true;
    } else {
      const floor = this.walkCast(start.eye, new Vector3(0, -1, 0), FLOOR_SEARCH);
      if (this.castMissing) return false;
      w.feet.y = floor ? start.eye.y - floor.distance : start.eye.y - eyeHeight(w);
      w.grounded = !!floor;
    }
    s.eyeY = w.feet.y + eyeHeight(w);
    s.start = null;
    return true;
  }

  private visibleMeshes(): Mesh[] {
    const found: Mesh[] = [];
    this.tiles?.group.traverseVisible(o => { if ((o as Mesh).isMesh) found.push(o as Mesh); });
    return found;
  }

  /** Index for the rays, in the background: the geometries a ray missed this frame, then those within INDEX_AHEAD m. */
  private indexAround(meshes: Mesh[], feet: Vector3) {
    const sphere = new Sphere(), near: [BufferGeometry, number][] = [];
    for (const mesh of meshes) {
      const g = mesh.geometry;
      if (this.missed.has(g) || !this.uploaded.has(g)) continue;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const d = sphere.copy(g.boundingSphere!).applyMatrix4(mesh.matrixWorld).distanceToPoint(feet);
      if (d < INDEX_AHEAD) near.push([g, d]);
    }
    near.sort((a, b) => a[1] - b[1]);
    this.collision.want([...[...this.missed].filter(g => this.uploaded.has(g)), ...near.map(([g]) => g)]);
  }

  /**
   * Indexed tile meshes shown lately and off screen now — mostly the coarser tile a just-loaded finer one replaced. They
   * stand in for a mesh on screen not indexed yet: as tiles refined (150 m across, 350–690 thousand triangles, 0.3–1 s
   * to index) the walk stood waiting.
   */
  private standIns(): Mesh[] {
    const s = this.walkState;
    if (s?.standIns) return s.standIns;
    const shown = new Set(s?.meshes ?? this.visibleMeshes());
    const found = [...this.shownLately.keys()].filter(mesh => !shown.has(mesh) && (this.terrainShown || !this.inTerrain(mesh)));
    if (s) s.standIns = found;
    return found;
  }

  private inTerrain(o: Object3D): boolean {
    for (let p: Object3D | null = o; p; p = p.parent) if (this.terrainScenes.has(p)) return true;
    return false;
  }

  /**
   * First visible surface along a ray (scene frame) for walk mode: the meshes on screen through their bounding volume
   * hierarchies (CollisionIndex); hidden objects are passed through. A mesh on the ray not indexed yet is asked for and
   * the indexed tiles off screen there stand in for it (standIns); with none, castMissing says the ray is not to be
   * trusted.
   */
  private walkCast = (origin: Vector3, dir: Vector3, far: number): Hit | null => {
    const s = this.walkState;
    if (!this.tiles) return null;
    const ray = new Ray(origin, dir), local = new Ray(), inverse = new Matrix4(), sphere = new Sphere();
    let best: Hit | null = null, reach = far;
    const through = (mesh: Mesh, bvh: MeshBVH) => {
      local.copy(ray).applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
      const ids = mesh.geometry.getAttribute('_feature_id_0');
      for (const hit of bvh.raycast(local, DoubleSide)) {
        const distance = hit.point.applyMatrix4(mesh.matrixWorld).distanceTo(origin);
        if (distance > reach || !hit.face) continue;
        const id = ids ? Math.round(ids.getX(hit.face.a)) : 0;
        if (id > 0 && this.state?.isHidden(id)) continue;
        reach = distance;
        best = { distance, normal: hit.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize() };
      }
    };
    const onRay = (mesh: Mesh) => {
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      sphere.copy(g.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      return sphere.distanceToPoint(origin) <= reach && ray.intersectsSphere(sphere);
    };
    const missing: Sphere[] = [];
    for (const mesh of s?.meshes ?? this.visibleMeshes()) {
      if (!onRay(mesh)) continue;
      const bvh = this.collision.get(mesh.geometry);
      if (bvh) through(mesh, bvh);
      else if (!this.collision.gone(mesh.geometry)) { this.missed.add(mesh.geometry); missing.push(sphere.clone()); }
    }
    if (missing.length) {
      const covered = missing.map(() => false);
      for (const mesh of this.standIns()) {
        if (!onRay(mesh)) continue;
        let used = false;
        missing.forEach((m, i) => { if (m.intersectsSphere(sphere)) used = covered[i] = true; });
        if (used) through(mesh, this.collision.get(mesh.geometry)!);
      }
      if (covered.some(c => !c)) this.castMissing = true;
    }
    return best;
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    const moved = this.walkState ? this.walkFrame(dt) : this.controls.update(dt);
    if (moved) { this.dirty = true; this.needsUpdate = true; this.view++; this.moving = true; }
    else if (this.moving) { this.moving = false; this.sampleWanted = this.roomWanted = true; } // at rest: sample what is under the mouse now
    const tiles = this.tiles;
    const failed = (tiles as unknown as { stats?: TileStats } | null)?.stats?.failed ?? 0;
    if (tiles && failed > 0) {
      const now = performance.now();
      if (!this.retry.at) this.retry.at = now + this.retry.delay;
      else if (now >= this.retry.at) {
        resetFailed(tiles);
        this.retry = { at: 0, delay: Math.min(this.retry.delay * 2, 30000) };
        this.needsUpdate = true;
      }
    } else if (tiles && !loading(tiles)) this.retry = { at: 0, delay: 2000 };
    if (tiles && (this.needsUpdate || loading(tiles))) {
      // Near plane follows the distance to the orbit target; the far plane reaches just past the model.
      const distance = this.controls.distance;
      const reach = this.bounds ? this.camera.position.distanceTo(this.bounds.center) + this.bounds.radius * 1.05 : distance * 50;
      this.camera.near = this.walkState ? 0.05 : Math.min(Math.max(distance * 0.002, 0.05), 50);
      this.camera.far = Math.max(reach, this.camera.near * 100);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      tiles.update();
      this.needsUpdate = false;
    }
    const now = performance.now();
    if (this.onStats && now - this.lastStats > 500) { this.lastStats = now; this.onStats(this.stats()); }
    // Prefetch around a view that has rested 1.5 s with nothing loading; a move stops a round at once.
    if (moved || !tiles || loading(tiles)) { this.quietSince = now; if (moved) this.prefetch.abort?.abort(); }
    else if (now - this.quietSince > 1500 && !this.prefetch.running && this.prefetch.finishedAt !== this.view && this.profile.prefetchMB > 0) void this.prefetchRound();
    // Sample the surface under a resting camera when the mouse moved, the camera stopped or tiles arrived: one at a time,
    // at most every SAMPLE_EVERY ms, none while the camera moves.
    if (this.pointer && this.sampleWanted && !this.sampling && !moved && now - this.sampledAt >= SAMPLE_EVERY) this.sampleSurface();
    else if (this.roomWanted && !this.walkState && !this.roomSampling && !moved && now - this.sampledAt >= SAMPLE_EVERY) this.sampleRoom();
    if (!this.dirty) return;
    this.dirty = false;
    this.frame = this.draw();
    this.frames++;
    this.frameTimes.push(now);
    while (this.frameTimes.length > 2 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    if (tiles && this.openedAt) {
      if (this.firstFrameMs === null && this.frame.triangles > 0) this.firstFrameMs = Math.round(now - this.openedAt);
      if (this.firstFrameMs !== null && this.settledMs === null && !loading(tiles) && tiles.visibleTiles.size > 0) this.settledMs = Math.round(now - this.openedAt);
    }
  };
}
