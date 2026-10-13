import {
  AmbientLight, Box3, Clock, Color, DirectionalLight, DoubleSide, Group, Matrix4, Mesh, MeshLambertMaterial, PerspectiveCamera,
  Quaternion, Raycaster, Scene, Sphere, Spherical, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget, type Material,
  type MeshStandardMaterial, type Object3D,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import CameraControls from 'camera-controls';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ObjectStateTexture, createPickMaterial, createSurfaceMaterial } from './objectState';
import { PROFILES, detailOf, probeDevice, type DeviceProfile, type DeviceTier, type Quality } from './deviceProfile';

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

export type ViewerStats = {
  fps: number; frames: number; drawCalls: number; triangles: number; geometries: number;
  tilesVisible: number; tilesLoaded: number; downloading: number; parsing: number; failed: number;
  cacheMB: number; usedMB: number; heapMB: number | null; tier: DeviceTier; errorTarget: number;
  firstFrameMs: number | null; settledMs: number | null;
};
type TileStats = { downloading: number; parsing: number; loaded: number; failed: number };
/** True from the first queued tile until every download/parse has finished (not in the library's typings). */
const loading = (tiles: TilesRenderer) => (tiles as unknown as { isLoading: boolean }).isLoading;

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
  /** Path → signed URL of the open tileset (kept so renewed URLs apply to later requests). */
  private urls: Record<string, string> = {};
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

  constructor(private readonly canvas: HTMLCanvasElement, tier?: DeviceTier) {
    // No reverse-Z: with three r171 it drew nothing in Chromium's software GL. Depth precision comes from a near plane
    // that follows the orbit distance and a far plane that just covers the model (see `loop`).
    // Edge smoothing keeps thin members (rails, railings) continuous from afar instead of breaking into dashes.
    const device = probeDevice();
    this.renderer = new WebGLRenderer({ canvas, antialias: device.antialias, powerPreference: 'high-performance' });
    this.detectedTier = device.tier;
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
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 200000;
    this.controls.smoothTime = 0.12;
    this.controls.draggingSmoothTime = 0.06;
    this.controls.addEventListener('update', () => { this.dirty = true; this.needsUpdate = true; });
    canvas.addEventListener('pointerdown', this.pivotAtPointer, { capture: true });
    canvas.addEventListener('wheel', this.depthAtWheel, { capture: true, passive: true });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas.parentElement ?? canvas);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Open a published tileset: `urls` maps its relative paths (tileset.json, c/*.glb, objects.bin) to signed URLs. */
  open(urls: Record<string, string>, objects: number): void {
    this.closeTiles();
    this.urls = { ...urls };
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
          if (base && bare.startsWith(base)) return this.urls[decodeURI(bare.slice(base.length))] ?? text;
        }
        return text;
      },
    });
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

  /** Recolour/hide objects (dbIds) in every loaded and later loaded tile. */
  setStates(selected: Iterable<number>, highlighted: Iterable<number>, hidden: Iterable<number>): void {
    this.state?.apply(selected, highlighted, hidden);
    this.dirty = true;
  }

  /** Keep the view centred above a panel covering the bottom `px` CSS pixels (0 = none). */
  setBottomInset(px: number): void {
    const inset = Math.max(0, Math.round(px));
    if (inset === this.inset) return;
    this.inset = inset;
    this.applyView();
    this.needsUpdate = this.dirty = true;
  }

  /** Object under a canvas position (CSS px) and its world point, or null. */
  pick(x: number, y: number): { dbId: number; point: Vector3 } | null {
    if (!this.pickMaterial || !this.tiles) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = x * this.renderer.getPixelRatio(), py = y * this.renderer.getPixelRatio();
    const w = rect.width * this.renderer.getPixelRatio(), h = rect.height * this.renderer.getPixelRatio();
    const read = (mode: number) => {
      this.pickMaterial!.uniforms.mode.value = mode;
      this.pickMaterial!.uniforms.far.value = this.camera.far;
      const pixel = new Uint8Array(4);
      const inset = this.inset * this.renderer.getPixelRatio();
      this.camera.setViewOffset(w, h + inset, Math.floor(px), Math.floor(py + inset), 1, 1);
      this.scene.overrideMaterial = this.pickMaterial;
      const background = this.scene.background;
      this.scene.background = null;
      this.renderer.setRenderTarget(this.pickTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, pixel);
      this.renderer.setRenderTarget(null);
      this.scene.overrideMaterial = null;
      this.scene.background = background;
      this.applyView();
      return pixel;
    };
    const id = read(0);
    const dbId = (id[0] << 16) | (id[1] << 8) | id[2];
    const d = read(1);
    this.dirty = true;
    if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0) return dbId ? { dbId, point: this.controls.getTarget(new Vector3()) } : null;
    // Unpack (three.js packDepthToRGBA) → view depth → world point along the pixel's ray.
    const depth = (d[0] / 255 + d[1] / 65025 + d[2] / 16581375 + d[3] / 4228250625) * this.camera.far;
    const ndc = new Vector3((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1, 0.5).unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    const forward = this.camera.getWorldDirection(new Vector3());
    const point = this.camera.position.clone().addScaledVector(dir, depth / Math.max(1e-6, dir.dot(forward)));
    return { dbId, point };
  }

  /** Fly to a tileset-frame box [minX, minY, minZ, maxX, maxY, maxZ] (Z-up). */
  frameBox(box: ArrayLike<number>, animate = true): void {
    const corners = new Box3();
    for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]])
      corners.expandByPoint(new Vector3(x, y, z).applyMatrix4(this.world.matrixWorld));
    // Bounding sphere, not box: a box fit looks along the current direction and can end up inside a long object.
    const sphere = corners.getBoundingSphere(new Sphere());
    sphere.radius = Math.max(sphere.radius * 1.1, 1);
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
      firstFrameMs: this.firstFrameMs, settledMs: this.settledMs,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pivotAtPointer, { capture: true });
    this.canvas.removeEventListener('wheel', this.depthAtWheel, { capture: true });
    this.closeTiles();
    this.controls.dispose();
    this.pickTarget.dispose();
    this.renderer.dispose();
  }

  private closeTiles() {
    this.bounds = null;
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
      if (terrain) {
        const photo = (mesh.material as MeshStandardMaterial).map;
        mesh.material = new MeshLambertMaterial({ map: photo, side: DoubleSide });
        return;
      }
      mesh.material = mesh.material.transparent ? this.surface!.transparent : this.surface!.opaque;
    });
    if (terrain) { this.terrainScenes.add(scene); scene.visible = this.terrainShown; }
    this.dirty = true;
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
      this.controls.update(0);
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
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
   * Pointer down: rotate about the surface under the pointer (objects and terrain); pan and pinch at that surface's
   * depth; empty space keeps the distance with the target back on the view axis.
   */
  private pivotAtPointer = (event: PointerEvent) => {
    if (!this.tiles) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.depthAt(event.clientX - rect.left, event.clientY - rect.top);
    if (event.button === 0 && event.isPrimary && hit) {
      this.freeze();
      this.controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z);
    } else this.centreTarget(hit?.depth);
    this.needsUpdate = this.dirty = true;
  };

  /** Wheel: zoom steps follow the surface under the cursor (once per scroll gesture, not every notch). */
  private lastWheel = 0;
  private depthAtWheel = (event: WheelEvent) => {
    const now = performance.now();
    if (!this.tiles || now - this.lastWheel < 300) { this.lastWheel = now; return; }
    this.lastWheel = now;
    const rect = this.canvas.getBoundingClientRect();
    this.centreTarget(this.depthAt(event.clientX - rect.left, event.clientY - rect.top)?.depth);
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
    this.applyView();
    this.tiles?.setResolutionFromRenderer(this.camera, this.renderer);
    this.needsUpdate = this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const moved = this.controls.update(this.clock.getDelta());
    if (moved) { this.dirty = true; this.needsUpdate = true; }
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
      this.camera.near = Math.min(Math.max(distance * 0.002, 0.05), 50);
      this.camera.far = Math.max(reach, this.camera.near * 100);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      tiles.update();
      this.needsUpdate = false;
    }
    const now = performance.now();
    if (this.onStats && now - this.lastStats > 500) { this.lastStats = now; this.onStats(this.stats()); }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.frame = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
    this.frames++;
    this.frameTimes.push(now);
    while (this.frameTimes.length > 2 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    if (tiles && this.openedAt) {
      if (this.firstFrameMs === null && this.frame.triangles > 0) this.firstFrameMs = Math.round(now - this.openedAt);
      if (this.firstFrameMs !== null && this.settledMs === null && !loading(tiles) && tiles.visibleTiles.size > 0) this.settledMs = Math.round(now - this.openedAt);
    }
  };
}
