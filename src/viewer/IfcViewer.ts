import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  IfcAPI,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCMAPCONVERSION,
  type FlatMesh,
  type PlacedGeometry,
} from 'web-ifc';

export interface ElementProperties {
  modelID: number;
  expressID: number;
  type: string;
  name: string;
  attributes: { key: string; value: string }[];
}

interface LoadedModel {
  modelID: number;
  group: THREE.Group;
  /** expressID -> the meshes that make up that IFC element */
  elementMeshes: Map<number, THREE.Mesh[]>;
  /** model-space up axis used to orient the group into Three.js' Y-up world */
  upAxis: UpAxis;
}

export type UpAxis = 'x' | 'y' | 'z';

/** Minimal element descriptor used by the 4D layer to map schedule ↔ objects. */
export interface ElementInfo {
  modelID: number;
  expressID: number;
  name: string;
}

/** Per-element construction state for the 4D timeline. */
export type BuildState = 'built' | 'active' | 'future' | 'removed';

/** What to do with not-yet-built elements: fully hide or show as a faint ghost. */
export type FutureMode = 'hidden' | 'ghost';

type SelectCallback = (props: ElementProperties | null) => void;

const HIGHLIGHT_COLOR = new THREE.Color(0xffaa00);

/**
 * Imperative Three.js + web-ifc engine.
 *
 * Phase 1 responsibilities:
 *  - load IFC files and build per-element Three.js meshes
 *  - orbit/pan/zoom navigation
 *  - click-to-select with property read-out
 *  - visibility helpers (hide / isolate / show-all) used by the 4D layer later
 */
export class IfcViewer {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ifcAPI = new IfcAPI();

  private readonly container: HTMLElement;
  private readonly models: LoadedModel[] = [];

  /** material clones swapped in for the current selection, kept so we can restore */
  private highlighted: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];

  /**
   * Per-mesh 4D record: the pre-4D {material, visible} to restore, plus the
   * last applied appearance key so playback only mutates meshes that changed.
   */
  private constructionOverrides = new Map<
    THREE.Mesh,
    { saved: { material: THREE.Material | THREE.Material[]; visible: boolean }; key: string }
  >();
  /** shared materials for 4D appearance (lazily reused, never per-mesh cloned) */
  private ghostMaterial: THREE.Material | null = null;
  private activeMaterial: THREE.Material | null = null;
  /** expressID name cache per model, populated on first catalog request */
  private nameCache = new Map<number, Map<number, string>>();

  private onSelect: SelectCallback = () => {};
  private initialized = false;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene.background = new THREE.Color(0x1e2430);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      10000,
    );
    this.camera.position.set(15, 15, 15);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.setupSceneHelpers();

    this.renderer.domElement.addEventListener('click', this.handleClick);
    window.addEventListener('resize', this.handleResize);

    this.animate();
  }

  setOnSelect(cb: SelectCallback) {
    this.onSelect = cb;
  }

  async init() {
    if (this.initialized) return;
    this.ifcAPI.SetWasmPath('/web-ifc/');
    await this.ifcAPI.Init();
    this.initialized = true;
  }

  get modelCount() {
    return this.models.length;
  }

  // --- IFC loading -------------------------------------------------------

  async loadIfc(data: Uint8Array, opts?: { upAxis?: UpAxis }): Promise<LoadedModel> {
    await this.init();

    // We deliberately do NOT use web-ifc's COORDINATE_TO_ORIGIN. Its
    // coordination matrix is derived from the *first* element's full placement
    // — translation AND rotation. For georeferenced infrastructure models (e.g.
    // bridges whose elements are placed along an alignment) that first element
    // is rotated to follow the alignment tangent, so the baked-in inverse
    // rotation tips the whole model off vertical; the Z-up→Y-up rotation below
    // then lays it on its side ("누움"). Instead we read raw model-space
    // geometry (strictly Z-up per the IFC spec) and recenter with a pure
    // translation (see modelOffset) — no rotation contamination.
    const modelID = this.ifcAPI.OpenModel(data, {
      COORDINATE_TO_ORIGIN: false,
    });

    const group = new THREE.Group();
    const elementMeshes = new Map<number, THREE.Mesh[]>();
    const materialCache = new Map<string, THREE.Material>();

    // Origin of the first element seen, subtracted from every transform so
    // geometry stays near the local origin. This preserves float32 precision
    // for far-from-origin georeferenced coordinates without baking in rotation.
    let modelOffset: THREE.Vector3 | null = null;

    this.ifcAPI.StreamAllMeshes(modelID, (flatMesh: FlatMesh) => {
      const expressID = flatMesh.expressID;
      const placedGeometries = flatMesh.geometries;
      const meshes: THREE.Mesh[] = [];

      for (let i = 0; i < placedGeometries.size(); i++) {
        const placed = placedGeometries.get(i);
        const geometry = this.buildGeometry(modelID, placed);
        const material = this.getMaterial(materialCache, placed.color);

        const matrix = new THREE.Matrix4().fromArray(placed.flatTransformation);
        if (!modelOffset) {
          modelOffset = new THREE.Vector3().setFromMatrixPosition(matrix);
        }
        // Strip only the global translation; per-element rotation is preserved.
        matrix.setPosition(
          matrix.elements[12] - modelOffset.x,
          matrix.elements[13] - modelOffset.y,
          matrix.elements[14] - modelOffset.z,
        );

        const mesh = new THREE.Mesh(geometry, material);
        mesh.applyMatrix4(matrix);
        mesh.userData.expressID = expressID;
        mesh.userData.modelID = modelID;

        group.add(mesh);
        meshes.push(mesh);
      }

      elementMeshes.set(expressID, meshes);
    });

    // Up axis: caller-provided override (a remembered per-model choice) wins;
    // otherwise auto-detect from the model's representation context.
    const upAxis = opts?.upAxis ?? this.detectUpAxis(modelID, group);

    this.scene.add(group);

    const model: LoadedModel = { modelID, group, elementMeshes, upAxis };
    this.models.push(model);

    this.orientGroup(group, upAxis);
    this.fitToObject(group);
    return model;
  }

  /**
   * Rotate a freshly-loaded model group so its "up" axis points along Three.js'
   * +Y. IFC is Z-up by spec, but some infrastructure exports (notably the bridge
   * case study) deliver Y-up geometry; blindly applying the Z-up→Y-up rotation
   * then lays them on their side. `axis` is the model-space up axis.
   */
  private orientGroup(group: THREE.Group, axis: UpAxis) {
    group.rotation.set(0, 0, 0);
    if (axis === 'z') group.rotation.x = -Math.PI / 2; // Z-up → Y-up (default)
    else if (axis === 'x') group.rotation.z = Math.PI / 2; // X-up → Y-up (rare)
    // axis === 'y' → already Y-up, no rotation
    group.updateMatrixWorld(true);
  }

  /**
   * Best-effort detection of the model's up axis. Reads the geometric
   * representation context's WorldCoordinateSystem (the spec-correct place to
   * declare a non-Z up) and logs georeferencing + bounding-box diagnostics. If
   * the context doesn't declare it, falls back to Z-up. The result can be
   * overridden at runtime via `setUpAxis()` / `window.__mirUpAxis()`.
   */
  private detectUpAxis(modelID: number, group: THREE.Group): UpAxis {
    let axis: UpAxis = 'z';
    try {
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      console.info(
        `[IFC-georef] model-space bbox size = x:${size.x.toFixed(1)} y:${size.y.toFixed(1)} z:${size.z.toFixed(1)}`,
      );

      const ctxIDs = this.ifcAPI.GetLineIDsWithType(modelID, IFCGEOMETRICREPRESENTATIONCONTEXT);
      for (let i = 0; i < ctxIDs.size(); i++) {
        const ctx = this.ifcAPI.GetLine(modelID, ctxIDs.get(i), true) as Record<string, any>;
        const wcsAxis = ctx?.WorldCoordinateSystem?.Axis?.DirectionRatios as number[] | undefined;
        const trueNorth = ctx?.TrueNorth?.DirectionRatios as number[] | undefined;
        console.info(
          `[IFC-georef] context "${ctx?.ContextType?.value ?? '?'}" WCS.Axis=${JSON.stringify(wcsAxis)} TrueNorth=${JSON.stringify(trueNorth)}`,
        );
        if (wcsAxis) {
          // The WCS "Axis" is the local +Z (up) direction. If it leans toward Y
          // or X instead of Z, the geometry's up is that axis.
          const [ax, ay, az] = [Math.abs(wcsAxis[0] ?? 0), Math.abs(wcsAxis[1] ?? 0), Math.abs(wcsAxis[2] ?? 0)];
          if (ay > az && ay > ax) axis = 'y';
          else if (ax > az && ax > ay) axis = 'x';
        }
      }

      const mapIDs = this.ifcAPI.GetLineIDsWithType(modelID, IFCMAPCONVERSION);
      for (let i = 0; i < mapIDs.size(); i++) {
        const m = this.ifcAPI.GetLine(modelID, mapIDs.get(i), true) as Record<string, any>;
        console.info(
          `[IFC-georef] IfcMapConversion E=${m?.Eastings?.value} N=${m?.Northings?.value} H=${m?.OrthogonalHeight?.value} XAxis=(${m?.XAxisAbscissa?.value},${m?.XAxisOrdinate?.value}) scale=${m?.Scale?.value}`,
        );
      }
    } catch (err) {
      console.warn('[IFC-georef] diagnostic read failed', err);
    }
    console.info(`[IFC-georef] using up axis = ${axis} (override: window.__mirUpAxis('x'|'y'|'z'))`);
    return axis;
  }

  /** Re-orient every loaded model to the given up axis and refit the camera. */
  setUpAxis(axis: UpAxis) {
    for (const model of this.models) {
      this.orientGroup(model.group, axis);
      model.upAxis = axis;
    }
    if (this.models.length) this.fitToObject(this.models[0].group);
  }

  /** Up axis currently applied to the most recently loaded model. */
  get upAxis(): UpAxis {
    return this.models.length ? this.models[this.models.length - 1].upAxis : 'z';
  }

  private buildGeometry(modelID: number, placed: PlacedGeometry): THREE.BufferGeometry {
    const geom = this.ifcAPI.GetGeometry(modelID, placed.geometryExpressID);
    const verts = this.ifcAPI.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const indices = this.ifcAPI.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

    // web-ifc interleaves [px,py,pz, nx,ny,nz] per vertex
    const vertexCount = verts.length / 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = verts[i * 6];
      positions[i * 3 + 1] = verts[i * 6 + 1];
      positions[i * 3 + 2] = verts[i * 6 + 2];
      normals[i * 3] = verts[i * 6 + 3];
      normals[i * 3 + 1] = verts[i * 6 + 4];
      normals[i * 3 + 2] = verts[i * 6 + 5];
    }

    const bufferGeometry = new THREE.BufferGeometry();
    bufferGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    bufferGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    bufferGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

    geom.delete();
    return bufferGeometry;
  }

  private getMaterial(
    cache: Map<string, THREE.Material>,
    color: { x: number; y: number; z: number; w: number },
  ): THREE.Material {
    const key = `${color.x.toFixed(3)}_${color.y.toFixed(3)}_${color.z.toFixed(3)}_${color.w.toFixed(3)}`;
    let material = cache.get(key);
    if (!material) {
      material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(color.x, color.y, color.z),
        side: THREE.DoubleSide,
        transparent: color.w !== 1,
        opacity: color.w,
        depthWrite: color.w === 1,
      });
      cache.set(key, material);
    }
    return material;
  }

  // --- selection ---------------------------------------------------------

  private handleClick = (event: MouseEvent) => {
    const hit = this.pick(event.clientX, event.clientY);
    if (!hit) {
      this.clearHighlight();
      this.onSelect(null);
      return;
    }
    this.highlight(hit.modelID, hit.expressID);
    this.onSelect(this.getProperties(hit.modelID, hit.expressID));
  };

  private pick(clientX: number, clientY: number): { modelID: number; expressID: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const meshes = this.allMeshes().filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const mesh = hits[0].object as THREE.Mesh;
    return {
      modelID: mesh.userData.modelID as number,
      expressID: mesh.userData.expressID as number,
    };
  }

  private highlight(modelID: number, expressID: number) {
    this.clearHighlight();
    const meshes = this.meshesFor(modelID, expressID);
    for (const mesh of meshes) {
      this.highlighted.push({ mesh, material: mesh.material });
      const highlightMat = new THREE.MeshLambertMaterial({
        color: HIGHLIGHT_COLOR,
        side: THREE.DoubleSide,
      });
      mesh.material = highlightMat;
    }
  }

  private clearHighlight() {
    for (const { mesh, material } of this.highlighted) {
      (mesh.material as THREE.Material).dispose?.();
      mesh.material = material;
    }
    this.highlighted = [];
  }

  getProperties(modelID: number, expressID: number): ElementProperties {
    const line = this.ifcAPI.GetLine(modelID, expressID, true) as Record<string, unknown>;
    const typeCode = this.ifcAPI.GetLineType(modelID, expressID);
    const type = this.ifcAPI.GetNameFromTypeCode(typeCode) ?? 'Unknown';

    const attributes: { key: string; value: string }[] = [];
    for (const [key, raw] of Object.entries(line)) {
      if (key === 'expressID' || key === 'type') continue;
      const value = this.formatValue(raw);
      if (value !== null) attributes.push({ key, value });
    }

    const name = this.readValue(line.Name) ?? '(unnamed)';
    return { modelID, expressID, type, name, attributes };
  }

  private readValue(raw: unknown): string | null {
    if (raw && typeof raw === 'object' && 'value' in raw) {
      const v = (raw as { value: unknown }).value;
      return v == null ? null : String(v);
    }
    return null;
  }

  private formatValue(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === 'object') {
      if ('value' in raw) return this.readValue(raw);
      return null; // skip nested handles/arrays in the basic panel
    }
    return String(raw);
  }

  // --- visibility helpers (foundation for the 4D timeline) ---------------

  setElementVisible(modelID: number, expressID: number, visible: boolean) {
    for (const mesh of this.meshesFor(modelID, expressID)) mesh.visible = visible;
  }

  hideSelected(selection: { modelID: number; expressID: number } | null) {
    if (!selection) return;
    this.setElementVisible(selection.modelID, selection.expressID, false);
    this.clearHighlight();
  }

  isolate(selection: { modelID: number; expressID: number } | null) {
    if (!selection) return;
    const keep = new Set(this.meshesFor(selection.modelID, selection.expressID));
    for (const mesh of this.allMeshes()) mesh.visible = keep.has(mesh);
  }

  showAll() {
    for (const mesh of this.allMeshes()) mesh.visible = true;
  }

  fitToSelection(selection: { modelID: number; expressID: number } | null) {
    if (!selection) {
      if (this.models.length) this.fitToObject(this.models[0].group);
      return;
    }
    const box = new THREE.Box3();
    for (const mesh of this.meshesFor(selection.modelID, selection.expressID)) {
      box.expandByObject(mesh);
    }
    if (!box.isEmpty()) this.frameBox(box);
  }

  // --- 4D construction layer ---------------------------------------------

  /**
   * Catalog of every loaded element with its IFC Name, used by the 4D layer to
   * map schedule tasks to objects. Names are read once per model and cached.
   */
  getElementCatalog(): ElementInfo[] {
    const out: ElementInfo[] = [];
    for (const model of this.models) {
      let cache = this.nameCache.get(model.modelID);
      if (!cache) {
        cache = new Map<number, string>();
        for (const expressID of model.elementMeshes.keys()) {
          cache.set(expressID, this.readName(model.modelID, expressID));
        }
        this.nameCache.set(model.modelID, cache);
      }
      for (const [expressID, name] of cache) {
        out.push({ modelID: model.modelID, expressID, name });
      }
    }
    return out;
  }

  private readName(modelID: number, expressID: number): string {
    try {
      const line = this.ifcAPI.GetLine(modelID, expressID, false) as Record<string, any>;
      const n = line?.Name?.value;
      return typeof n === 'string' ? n : '';
    } catch {
      return '';
    }
  }

  /**
   * Apply per-element construction states for a point in time. Elements not in
   * `states` are restored to their pre-4D look (so de-mapped/unmapped objects
   * stay visible). Built → original look, active → orange tint, future → hidden
   * or faint ghost per `futureMode`, removed (demolished) → always hidden.
   *
   * Incremental: each mesh remembers its last applied appearance, so during
   * playback only the meshes whose state actually changed are mutated — large
   * models don't churn every tick.
   */
  applyConstruction(
    states: Iterable<{ modelID: number; expressID: number; state: BuildState }>,
    futureMode: FutureMode,
  ) {
    // Resolve desired state per mesh.
    const desired = new Map<THREE.Mesh, BuildState>();
    for (const { modelID, expressID, state } of states) {
      for (const mesh of this.meshesFor(modelID, expressID)) desired.set(mesh, state);
    }

    // Restore meshes that are no longer governed by the 4D layer.
    for (const [mesh, rec] of this.constructionOverrides) {
      if (!desired.has(mesh)) {
        mesh.material = rec.saved.material;
        mesh.visible = rec.saved.visible;
        this.constructionOverrides.delete(mesh);
      }
    }

    // Apply/update governed meshes, skipping ones already in the target look.
    for (const [mesh, state] of desired) {
      let rec = this.constructionOverrides.get(mesh);
      if (!rec) {
        rec = { saved: { material: mesh.material, visible: mesh.visible }, key: '' };
        this.constructionOverrides.set(mesh, rec);
      }
      const key = `${state}|${futureMode}`;
      if (rec.key === key) continue;
      rec.key = key;
      this.applyMeshState(mesh, state, futureMode, rec.saved.material);
    }
  }

  private applyMeshState(
    mesh: THREE.Mesh,
    state: BuildState,
    futureMode: FutureMode,
    original: THREE.Material | THREE.Material[],
  ) {
    if (state === 'active') {
      mesh.material = this.getActiveMaterial();
      mesh.visible = true;
    } else if (state === 'future') {
      if (futureMode === 'ghost') {
        mesh.material = this.getGhostMaterial();
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
    } else if (state === 'removed') {
      mesh.visible = false;
    } else {
      // built
      mesh.material = original;
      mesh.visible = true;
    }
  }

  /** Restore every mesh the 4D layer touched to its pre-4D material/visibility. */
  clearConstruction() {
    for (const [mesh, rec] of this.constructionOverrides) {
      mesh.material = rec.saved.material;
      mesh.visible = rec.saved.visible;
    }
    this.constructionOverrides.clear();
  }

  private getGhostMaterial(): THREE.Material {
    if (!this.ghostMaterial) {
      this.ghostMaterial = new THREE.MeshLambertMaterial({
        color: 0x6b7686,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    return this.ghostMaterial;
  }

  private getActiveMaterial(): THREE.Material {
    if (!this.activeMaterial) {
      this.activeMaterial = new THREE.MeshLambertMaterial({
        color: HIGHLIGHT_COLOR,
        emissive: new THREE.Color(0x442200),
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
      });
    }
    return this.activeMaterial;
  }

  // --- helpers -----------------------------------------------------------

  private meshesFor(modelID: number, expressID: number): THREE.Mesh[] {
    const model = this.models.find((m) => m.modelID === modelID);
    return model?.elementMeshes.get(expressID) ?? [];
  }

  private allMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const model of this.models) {
      for (const list of model.elementMeshes.values()) meshes.push(...list);
    }
    return meshes;
  }

  private fitToObject(object: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    this.frameBox(box);
  }

  private frameBox(box: THREE.Box3) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 1.8;

    this.controls.target.copy(center);
    this.camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private setupSceneHelpers() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404050, 1.0);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    const grid = new THREE.GridHelper(100, 100, 0x445566, 0x2a3340);
    this.scene.add(grid);
  }

  private handleResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
