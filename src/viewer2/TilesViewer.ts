import {
  AmbientLight, Box3, Clock, Color, DirectionalLight, Group, Matrix4, Mesh, PerspectiveCamera, Quaternion, Raycaster,
  Scene, Sphere, Spherical, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget, type Material, type Object3D,
} from 'three';
import CameraControls from 'camera-controls';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ObjectStateTexture, createPickMaterial, createSurfaceMaterial } from './objectState';
import { PROFILES, detectTier, type DeviceProfile, type DeviceTier } from './deviceProfile';

CameraControls.install({ THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster } });

/** Stand-in origin: the tileset's relative paths resolve against it and are then mapped to signed URLs. */
const BASE = 'https://tiles.mir.invalid/';

export type ViewerStats = {
  fps: number; frames: number; drawCalls: number; triangles: number; geometries: number;
  tilesVisible: number; tilesLoaded: number; downloading: number; parsing: number; failed: number;
  cacheMB: number; heapMB: number | null; tier: DeviceTier; errorTarget: number;
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
  /** Tileset bounds in the scene frame (set when the tileset loads). */
  private bounds: Sphere | null = null;
  /** Counters of the last on-screen frame (renderer.info also counts the 1×1 pick renders). */
  private frame = { calls: 0, triangles: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, tier?: DeviceTier) {
    // No reverse-Z: with three r171 it drew nothing in Chromium's software GL. Depth precision comes from a near plane
    // that follows the orbit distance and a far plane that just covers the model (see `loop`).
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.profile = PROFILES[tier ?? detectTier(this.renderer.getContext())];
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
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas.parentElement ?? canvas);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Open a published tileset: `urls` maps its relative paths (tileset.json, c/*.glb, objects.bin) to signed URLs. */
  open(urls: Record<string, string>, objects: number): void {
    this.closeTiles();
    this.state = new ObjectStateTexture(objects);
    this.surface = { opaque: createSurfaceMaterial(this.state, false), transparent: createSurfaceMaterial(this.state, true) };
    this.pickMaterial = createPickMaterial(this.state);
    const tiles = new TilesRenderer(`${BASE}tileset.json`);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ meshoptDecoder: MeshoptDecoder }));
    tiles.registerPlugin({
      name: 'MIR_SIGNED_URLS',
      preprocessURL: (url: string | URL) => {
        const text = String(url);
        return text.startsWith(BASE) ? (urls[text.slice(BASE.length).split('?')[0]] ?? text) : text;
      },
    });
    this.applyProfile(tiles);
    tiles.setCamera(this.camera);
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    tiles.addEventListener('load-model', ({ scene }) => this.adopt(scene));
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

  setTier(tier: DeviceTier): void {
    this.profile = PROFILES[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio));
    this.fit();
    if (this.tiles) this.applyProfile(this.tiles);
    this.needsUpdate = this.dirty = true;
  }

  /** Recolour/hide objects (dbIds) in every loaded and later loaded tile. */
  setStates(selected: Iterable<number>, highlighted: Iterable<number>, hidden: Iterable<number>): void {
    this.state?.apply(selected, highlighted, hidden);
    this.dirty = true;
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
      this.camera.setViewOffset(w, h, Math.floor(px), Math.floor(py), 1, 1);
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
      this.camera.clearViewOffset();
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
    void this.controls.fitToSphere(sphere, animate);
    this.needsUpdate = this.dirty = true;
  }

  /** The whole tileset. */
  frameAll(animate = true): void {
    const sphere = this.bounds;
    if (!sphere) return;
    // Oblique view from the south-east, like a site overview.
    const d = sphere.radius * 1.6;
    void this.controls.setLookAt(sphere.center.x + d * 0.5, sphere.center.y + d * 0.6, sphere.center.z + d * 0.6,
      sphere.center.x, sphere.center.y, sphere.center.z, animate);
    this.needsUpdate = this.dirty = true;
  }

  stats(): ViewerStats {
    const info = this.renderer.info, ts = (this.tiles as unknown as { stats?: TileStats } | null)?.stats;
    // Frames drawn in the last second (rendering is on demand: 0 while nothing changes).
    const now = performance.now(), recent = this.frameTimes.filter(t => now - t <= 1000);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: recent.length, frames: this.frames,
      drawCalls: this.frame.calls, triangles: this.frame.triangles, geometries: info.memory.geometries,
      tilesVisible: this.tiles?.visibleTiles.size ?? 0, tilesLoaded: ts?.loaded ?? 0,
      downloading: ts?.downloading ?? 0, parsing: ts?.parsing ?? 0, failed: ts?.failed ?? 0,
      cacheMB: Math.round(((this.tiles?.lruCache as unknown as { cachedBytes?: number } | undefined)?.cachedBytes ?? 0) / 1048576),
      heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
      tier: this.profile.tier, errorTarget: this.profile.errorTarget,
      firstFrameMs: this.firstFrameMs, settledMs: this.settledMs,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pivotAtPointer, { capture: true });
    this.closeTiles();
    this.controls.dispose();
    this.pickTarget.dispose();
    this.renderer.dispose();
  }

  private closeTiles() {
    this.bounds = null;
    if (this.tiles) { this.world.remove(this.tiles.group); this.tiles.dispose(); this.tiles = null; }
    this.surface?.opaque.dispose(); this.surface?.transparent.dispose(); this.pickMaterial?.dispose();
    this.state?.texture.dispose();
    this.surface = null; this.pickMaterial = null; this.state = null;
  }

  private applyProfile(tiles: TilesRenderer) {
    const p = this.profile;
    tiles.errorTarget = p.errorTarget;
    tiles.lruCache.maxBytesSize = p.maxBytes;
    tiles.lruCache.minBytesSize = p.minBytes;
    tiles.parseQueue.maxJobs = p.parseJobs;
    tiles.downloadQueue.maxJobsPerOrigin = p.downloadJobs;
  }

  /** Shared state-aware materials instead of the loader's per-tile ones (those stay in the tile's disposal list). */
  private adopt(scene: Object3D) {
    if (!this.surface) return;
    scene.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const transparent = !Array.isArray(mesh.material) && mesh.material.transparent;
      mesh.material = transparent ? this.surface!.transparent : this.surface!.opaque;
    });
    this.dirty = true;
  }

  /** Orbit about the surface point under the pointer (an empty spot keeps the current target). */
  private pivotAtPointer = (event: PointerEvent) => {
    if (event.button !== 0 || !this.tiles) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (hit && hit.dbId) this.controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z);
  };

  private fit() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.tiles?.setResolutionFromRenderer(this.camera, this.renderer);
    this.needsUpdate = this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const moved = this.controls.update(this.clock.getDelta());
    if (moved) { this.dirty = true; this.needsUpdate = true; }
    const tiles = this.tiles;
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
