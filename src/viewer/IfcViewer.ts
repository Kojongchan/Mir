import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
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
  /** human-readable label (the source file name) for the clash set picker */
  label: string;
}

export type UpAxis = 'x' | 'y' | 'z';

/** Minimal element descriptor used by the 4D layer to map schedule ↔ objects. */
export interface ElementInfo {
  modelID: number;
  expressID: number;
  name: string;
}

/** Element descriptor with IFC category (type), used by the clash layer to
 *  pick "set A vs set B" by model or by category. */
export interface ElementMeta {
  modelID: number;
  expressID: number;
  name: string;
  /** IFC type name, e.g. "IFCWALL" / "IFCBEAM" (from the type code). */
  category: string;
}

/** A loaded model summary for the clash set picker. */
export interface ModelSummary {
  modelID: number;
  label: string;
  count: number;
}

/** World-space geometry + BVH for one element, used in clash narrow phase. */
export interface ClashGeom {
  geometry: THREE.BufferGeometry;
  box: THREE.Box3;
  bvh: MeshBVH;
}

/** Serializable camera pose for saved viewpoints (Three.js world space). */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

/** A reference to one side of a clash. */
export interface ClashElementRef {
  modelID: number;
  expressID: number;
}

/**
 * Per-element appearance state for the 4D timeline (Navisworks-style):
 * hidden / normal(model) / ghost(not-yet) / active per task kind.
 */
export type CellState =
  | 'hidden'
  | 'normal'
  | 'ghost'
  | 'active-construct'
  | 'active-demolish'
  | 'active-temporary';

/** What to do with not-yet-built elements: fully hide or show as a faint ghost. */
export type FutureMode = 'hidden' | 'ghost';

/** Tunable look of the 4D layer (per-kind active colors + opacity). */
export interface AppearanceSettings {
  /** opacity of in-progress (active) elements, 0..1 */
  activeOpacity: number;
  /** CSS hex colors for active states by task kind */
  colorConstruct: string;
  colorDemolish: string;
  colorTemporary: string;
  /** show not-yet-built elements as a faint ghost instead of hiding them */
  ghostFuture: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  activeOpacity: 0.5,
  colorConstruct: '#22c55e', // green
  colorDemolish: '#ef4444', // red
  colorTemporary: '#eab308', // yellow
  ghostFuture: false,
};

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
  /** shared 4D materials, keyed by `${hex}|${opacity}` (never per-mesh cloned) */
  private material4dCache = new Map<string, THREE.Material>();
  private ghostMaterial: THREE.Material | null = null;
  /** expressID name cache per model, populated on first catalog request */
  private nameCache = new Map<number, Map<number, string>>();
  /** expressID -> IFC category(type) cache per model, for the clash picker */
  private categoryCache = new Map<number, Map<number, string>>();

  // --- 측정 / 단면(클리핑) ----------------------------------------------
  private measureMode = false;
  private measurePts: THREE.Vector3[] = [];
  private readonly measureGroup = new THREE.Group();
  private onMeasure: (text: string | null) => void = () => {};
  private readonly sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private sectionEnabled = false;
  private sectionAxis: 'x' | 'y' | 'z' = 'y';
  private sectionOffset = 0.5;
  private sectionFlip = false;

  /** materials swapped in to highlight a clash pair (A green / B red) */
  private clashHighlighted: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  /** other meshes dimmed (ghosted) while reviewing a clash, kept to restore */
  private clashDimmed: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  private clashGhostMaterial: THREE.Material | null = null;

  private onSelect: SelectCallback = () => {};
  /** active camera fly-through tween (Animator / viewpoint walkthrough) */
  private cameraTween: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toTgt: THREE.Vector3;
    fov0: number;
    fov1: number;
    start: number;
    dur: number;
    onDone?: () => void;
  } | null = null;
  /** fired when an issue pin is clicked (issueId + screen coords) */
  private onIssuePin: (issueId: string, clientX: number, clientY: number) => void = () => {};
  private initialized = false;
  private disposed = false;
  private resizeObserver?: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene.background = new THREE.Color(0xffffff);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.localClippingEnabled = true;
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

    this.scene.add(this.measureGroup);
    this.setupSceneHelpers();

    this.renderer.domElement.addEventListener('click', this.handleClick);
    window.addEventListener('resize', this.handleResize);
    // Container can resize without a window resize (e.g. the 4D timeline panel
    // expanding/collapsing, or switching modules in the portal shell) — keep the
    // canvas matched to its box.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
    }

    this.animate();
  }

  setOnSelect(cb: SelectCallback) {
    this.onSelect = cb;
  }

  setOnIssuePin(cb: (issueId: string, clientX: number, clientY: number) => void) {
    this.onIssuePin = cb;
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

  /** Runtime web-ifc modelID of the most recently loaded model (null if none). */
  get primaryModelID(): number | null {
    return this.models.length ? this.models[this.models.length - 1].modelID : null;
  }

  // --- IFC loading -------------------------------------------------------

  async loadIfc(data: Uint8Array, opts?: { upAxis?: UpAxis; label?: string }): Promise<LoadedModel> {
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

    this.logGeoref(modelID, group);

    // Up axis: a remembered per-model override wins; otherwise default to Y-up.
    // The IFC files we handle (bridge exports) deliver Y-up geometry, so no
    // rotation is applied by default. If a genuinely Z-up model ever needs it,
    // override via setUpAxis() / window.__mirUpAxis('z') (remembered per model).
    const upAxis = opts?.upAxis ?? 'y';

    this.scene.add(group);

    const label = opts?.label ?? `모델 ${this.models.length + 1}`;
    const model: LoadedModel = { modelID, group, elementMeshes, upAxis, label };
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
   * Log georeferencing diagnostics (bbox, representation-context axes, map
   * conversion) for the loaded model. Read-only — orientation uses the fixed
   * default in `loadIfc`, overridable per model via `setUpAxis()`.
   */
  private logGeoref(modelID: number, group: THREE.Group) {
    try {
      const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
      console.info(
        `[IFC-georef] model-space bbox size = x:${size.x.toFixed(1)} y:${size.y.toFixed(1)} z:${size.z.toFixed(1)}`,
      );

      const ctxIDs = this.ifcAPI.GetLineIDsWithType(modelID, IFCGEOMETRICREPRESENTATIONCONTEXT);
      for (let i = 0; i < ctxIDs.size(); i++) {
        const ctx = this.ifcAPI.GetLine(modelID, ctxIDs.get(i), true) as Record<string, any>;
        console.info(
          `[IFC-georef] context "${ctx?.ContextType?.value ?? '?'}" WCS.Axis=${JSON.stringify(ctx?.WorldCoordinateSystem?.Axis?.DirectionRatios)} TrueNorth=${JSON.stringify(ctx?.TrueNorth?.DirectionRatios)}`,
        );
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
  }

  /** Frame the camera on one loaded model (used by the integrated model list). */
  fitModel(modelID: number) {
    const model = this.models.find((m) => m.modelID === modelID);
    if (model) this.fitToObject(model.group);
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
    // 측정 모드: 표면 점을 찍어 두 점 사이 거리를 잰다.
    if (this.measureMode) {
      const p = this.pickPoint(event.clientX, event.clientY);
      if (p) this.addMeasurePoint(p);
      return;
    }
    // 이슈 핀을 먼저 픽 — 핀을 클릭하면 객체 선택 대신 핀 콜백을 쏜다.
    const pin = this.pickIssuePin(event.clientX, event.clientY);
    if (pin) {
      this.onIssuePin(pin, event.clientX, event.clientY);
      return;
    }
    const hit = this.pick(event.clientX, event.clientY);
    if (!hit) {
      this.clearHighlight();
      this.onSelect(null);
      return;
    }
    this.highlight(hit.modelID, hit.expressID);
    this.onSelect(this.getProperties(hit.modelID, hit.expressID));
  };

  private pickIssuePin(clientX: number, clientY: number): string | null {
    if (!this.issuePinGroup || !this.issuePinGroup.visible) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.issuePinGroup.children, false);
    const id = hits[0]?.object.userData.issueId;
    return typeof id === 'string' ? id : null;
  }

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

  /** Programmatically select an element: highlight it, fit the camera, and
   *  fire onSelect so the properties panel updates. Used to jump to an issue's
   *  pinned object. Returns false if the element isn't found in a loaded model. */
  focusElement(modelID: number, expressID: number): boolean {
    if (this.meshesFor(modelID, expressID).length === 0) return false;
    this.highlight(modelID, expressID);
    this.fitToSelection({ modelID, expressID });
    this.onSelect(this.getProperties(modelID, expressID));
    return true;
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

  /**
   * Apply a visibility predicate across every element (used by the integrated
   * model's per-model / per-category show-hide filters). `pred` decides whether
   * an element is shown.
   */
  applyVisibility(pred: (modelID: number, expressID: number) => boolean) {
    for (const model of this.models) {
      for (const [expressID, meshes] of model.elementMeshes) {
        const v = pred(model.modelID, expressID);
        for (const mesh of meshes) mesh.visible = v;
      }
    }
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

  // --- 저장 뷰포인트(카메라 상태) ---------------------------------------

  /**
   * Snapshot the current camera (position/target/up/fov/near/far) so it can be
   * named, stored, and recalled later (Navisworks Saved Viewpoints). Coordinates
   * are in Three.js world space — stable across reloads as long as the same
   * models are loaded (we recenter by a pure translation, no per-load jitter).
   */
  getCameraState(): CameraState {
    const t = this.controls.target;
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [t.x, t.y, t.z],
      up: [this.camera.up.x, this.camera.up.y, this.camera.up.z],
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
    };
  }

  /** Restore a previously saved camera state and refresh the controls. */
  applyCameraState(s: CameraState) {
    if (!s || !s.position || !s.target) return;
    this.camera.position.set(s.position[0], s.position[1], s.position[2]);
    this.controls.target.set(s.target[0], s.target[1], s.target[2]);
    if (s.up) this.camera.up.set(s.up[0], s.up[1], s.up[2]);
    if (typeof s.fov === 'number') this.camera.fov = s.fov;
    if (typeof s.near === 'number') this.camera.near = s.near;
    if (typeof s.far === 'number') this.camera.far = s.far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Smoothly fly the camera to a saved camera state over `durationMs`
   * (eased), used by the viewpoint walkthrough / Animator. `onDone` fires once
   * the destination is reached (or immediately if there's nothing to animate).
   * Controls input is suspended during the flight and restored on completion.
   */
  tweenCameraTo(s: CameraState, durationMs = 1400, onDone?: () => void) {
    if (!s || !s.position || !s.target) {
      onDone?.();
      return;
    }
    if (s.up) this.camera.up.set(s.up[0], s.up[1], s.up[2]);
    // Widen near/far up front so nothing clips mid-flight.
    if (typeof s.near === 'number') this.camera.near = Math.min(this.camera.near, s.near);
    if (typeof s.far === 'number') this.camera.far = Math.max(this.camera.far, s.far);
    this.camera.updateProjectionMatrix();
    this.cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(s.position[0], s.position[1], s.position[2]),
      fromTgt: this.controls.target.clone(),
      toTgt: new THREE.Vector3(s.target[0], s.target[1], s.target[2]),
      fov0: this.camera.fov,
      fov1: typeof s.fov === 'number' ? s.fov : this.camera.fov,
      start: performance.now(),
      dur: Math.max(1, durationMs),
      onDone,
    };
    this.controls.enabled = false;
  }

  /** Abort an in-progress camera flight and hand control back to the user. */
  cancelCameraTween() {
    if (!this.cameraTween) return;
    this.cameraTween = null;
    this.controls.enabled = true;
  }

  /**
   * Render once and return a downscaled JPEG data URL of the current view, used
   * as a viewpoint thumbnail. `maxW` caps the width (height keeps aspect).
   * preserveDrawingBuffer is on, so reading the canvas after a render is valid.
   */
  captureThumbnail(maxW = 320, quality = 0.7): string {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const scale = Math.min(1, maxW / (src.width || maxW));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return src.toDataURL('image/jpeg', quality);
    ctx.drawImage(src, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  /** Full-resolution PNG snapshot of the current view (for issue attachments). */
  captureSnapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
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

  // --- clash detection support ------------------------------------------

  /** Loaded models with element counts, for the clash "set A vs set B" picker. */
  getLoadedModels(): ModelSummary[] {
    return this.models.map((m) => ({
      modelID: m.modelID,
      label: m.label,
      count: m.elementMeshes.size,
    }));
  }

  /**
   * Every loaded element with its IFC Name and category(type). The clash layer
   * filters this list to build set A and set B (by model or by category).
   * Categories are read once per model and cached.
   */
  getElementMeta(): ElementMeta[] {
    const out: ElementMeta[] = [];
    for (const model of this.models) {
      let names = this.nameCache.get(model.modelID);
      if (!names) {
        names = new Map<number, string>();
        for (const expressID of model.elementMeshes.keys()) {
          names.set(expressID, this.readName(model.modelID, expressID));
        }
        this.nameCache.set(model.modelID, names);
      }
      let cats = this.categoryCache.get(model.modelID);
      if (!cats) {
        cats = new Map<number, string>();
        for (const expressID of model.elementMeshes.keys()) {
          cats.set(expressID, this.readCategory(model.modelID, expressID));
        }
        this.categoryCache.set(model.modelID, cats);
      }
      for (const expressID of model.elementMeshes.keys()) {
        out.push({
          modelID: model.modelID,
          expressID,
          name: names.get(expressID) ?? '',
          category: cats.get(expressID) ?? 'UNKNOWN',
        });
      }
    }
    return out;
  }

  private readCategory(modelID: number, expressID: number): string {
    try {
      const typeCode = this.ifcAPI.GetLineType(modelID, expressID);
      return this.ifcAPI.GetNameFromTypeCode(typeCode) ?? 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  /**
   * Build a world-space merged geometry + BVH for one element, used by the
   * clash narrow phase (`bvh.intersectsGeometry`). Returns null if the element
   * has no drawable geometry. Caller is responsible for disposing the geometry.
   */
  buildClashGeom(modelID: number, expressID: number): ClashGeom | null {
    const meshes = this.meshesFor(modelID, expressID);
    if (meshes.length === 0) return null;

    const parts: { pos: Float32Array; idx: Uint32Array }[] = [];
    let totalVerts = 0;
    let totalIdx = 0;
    const v = new THREE.Vector3();

    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const geom = mesh.geometry as THREE.BufferGeometry;
      const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!posAttr) continue;

      const pos = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
      }

      const index = geom.getIndex();
      let idx: Uint32Array;
      if (index) {
        idx = new Uint32Array(index.count);
        for (let i = 0; i < index.count; i++) idx[i] = index.getX(i);
      } else {
        idx = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) idx[i] = i;
      }

      parts.push({ pos, idx });
      totalVerts += posAttr.count;
      totalIdx += idx.length;
    }
    if (parts.length === 0) return null;

    const positions = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(totalIdx);
    let vOff = 0;
    let iOff = 0;
    for (const p of parts) {
      positions.set(p.pos, vOff * 3);
      const base = vOff;
      for (let i = 0; i < p.idx.length; i++) indices[iOff + i] = p.idx[i] + base;
      vOff += p.pos.length / 3;
      iOff += p.idx.length;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const bvh = new MeshBVH(geometry);
    // three-mesh-bvh reads `geometry.boundsTree` to accelerate the *other* side
    // of intersectsGeometry; attach it so both directions are fast.
    (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
    const box = new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    return { geometry, box, bvh };
  }

  /**
   * Review a clash: dim every other element to a faint ghost, paint element A
   * green and element B red, and fit the camera tightly to the pair (zoom in).
   * Restores on the next call or clearClashView().
   */
  showClash(a: ClashElementRef, b: ClashElementRef) {
    this.clearClashView();
    this.clearHighlight();

    const aMeshes = new Set(this.meshesFor(a.modelID, a.expressID));
    const bMeshes = new Set(this.meshesFor(b.modelID, b.expressID));
    const ghost = this.getClashGhostMaterial();

    // Dim all other currently-visible meshes (Navisworks "기타 항목 흐리게").
    for (const mesh of this.allMeshes()) {
      if (aMeshes.has(mesh) || bMeshes.has(mesh) || !mesh.visible) continue;
      this.clashDimmed.push({ mesh, material: mesh.material });
      mesh.material = ghost;
    }

    const matA = new THREE.MeshLambertMaterial({ color: 0x16a34a, side: THREE.DoubleSide }); // green
    const matB = new THREE.MeshLambertMaterial({ color: 0xdc2626, side: THREE.DoubleSide }); // red
    for (const mesh of aMeshes) {
      this.clashHighlighted.push({ mesh, material: mesh.material });
      mesh.material = matA;
      mesh.visible = true;
    }
    for (const mesh of bMeshes) {
      this.clashHighlighted.push({ mesh, material: mesh.material });
      mesh.material = matB;
      mesh.visible = true;
    }

    const box = this.pairBox(a, b);
    if (!box.isEmpty()) this.frameBox(box, 1.1);
  }

  /** Restore the meshes touched by showClash() (highlight + dimmed others). */
  clearClashView() {
    for (const { mesh, material } of this.clashHighlighted) {
      (mesh.material as THREE.Material).dispose?.();
      mesh.material = material;
    }
    this.clashHighlighted = [];
    for (const { mesh, material } of this.clashDimmed) mesh.material = material;
    this.clashDimmed = [];
  }

  private getClashGhostMaterial(): THREE.Material {
    if (!this.clashGhostMaterial) {
      this.clashGhostMaterial = new THREE.MeshLambertMaterial({
        color: 0xb8c2d0,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    return this.clashGhostMaterial;
  }

  private pairBox(a: ClashElementRef, b: ClashElementRef): THREE.Box3 {
    const box = new THREE.Box3();
    for (const mesh of this.meshesFor(a.modelID, a.expressID)) box.expandByObject(mesh);
    for (const mesh of this.meshesFor(b.modelID, b.expressID)) box.expandByObject(mesh);
    return box;
  }

  /**
   * Capture `count` PNG snapshots of the current clash from evenly-spaced
   * orbit angles (the pair must already be highlighted via showClash). Returns
   * data URLs. Restores the camera afterwards.
   */
  captureClashViews(a: ClashElementRef, b: ClashElementRef, count = 4): string[] {
    const box = this.pairBox(a, b);
    if (box.isEmpty()) return [];
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const dist = radius * 3;

    const savedPos = this.camera.position.clone();
    const savedTarget = this.controls.target.clone();

    const shots: string[] = [];
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      this.camera.position.set(
        center.x + Math.cos(ang) * dist,
        center.y + radius * 1.5 + dist * 0.35,
        center.z + Math.sin(ang) * dist,
      );
      this.camera.lookAt(center);
      this.camera.updateMatrixWorld(true);
      this.renderer.render(this.scene, this.camera);
      shots.push(this.renderer.domElement.toDataURL('image/png'));
    }

    this.camera.position.copy(savedPos);
    this.controls.target.copy(savedTarget);
    this.camera.lookAt(savedTarget);
    this.controls.update();
    return shots;
  }

  /** Hide everything except the two clash elements (Navisworks "기타 항목 숨기기"). */
  isolateClashPair(a: ClashElementRef, b: ClashElementRef) {
    const keep = new Set([
      ...this.meshesFor(a.modelID, a.expressID),
      ...this.meshesFor(b.modelID, b.expressID),
    ]);
    for (const mesh of this.allMeshes()) mesh.visible = keep.has(mesh);
  }

  // --- 측정(거리) -------------------------------------------------------

  setOnMeasure(cb: (text: string | null) => void) {
    this.onMeasure = cb;
  }

  setMeasureMode(on: boolean) {
    this.measureMode = on;
    this.measurePts = [];
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    if (!on) this.onMeasure(null);
  }

  /** Raycast against visible meshes and return the world-space hit point. */
  private pickPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.allMeshes().filter((m) => m.visible), false);
    return hits[0]?.point.clone() ?? null;
  }

  private addMeasurePoint(p: THREE.Vector3) {
    this.measurePts.push(p);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(this.measureDotRadius(), 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false }),
    );
    dot.position.copy(p);
    dot.renderOrder = 1000;
    this.measureGroup.add(dot);

    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const dist = a.distanceTo(b);
      const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({ color: 0x2563eb, depthTest: false }),
      );
      line.renderOrder = 1000;
      this.measureGroup.add(line);
      this.measureGroup.add(this.makeLabel(`${dist.toFixed(3)} m`, a.clone().lerp(b, 0.5)));
      this.onMeasure(`거리: ${dist.toFixed(3)} m`);
      this.measurePts = [];
    } else {
      this.onMeasure('두 번째 점을 클릭하세요…');
    }
  }

  private measureDotRadius(): number {
    const box = new THREE.Box3();
    for (const m of this.models) box.expandByObject(m.group);
    const d = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length();
    return Math.max(d * 0.004, 0.08);
  }

  /** A camera-facing text sprite (canvas texture) used for measurement labels. */
  private makeLabel(text: string, pos: THREE.Vector3): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
    roundRect(ctx, 4, 4, 248, 56, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.position.copy(pos);
    const s = this.measureDotRadius() * 18;
    sprite.scale.set(s * 2, s * 0.5, 1);
    sprite.renderOrder = 1001;
    return sprite;
  }

  clearMeasurements() {
    for (const child of [...this.measureGroup.children]) {
      this.measureGroup.remove(child);
      const o = child as THREE.Mesh & { material?: THREE.Material; geometry?: THREE.BufferGeometry };
      o.geometry?.dispose?.();
      const mat = o.material as (THREE.Material & { map?: THREE.Texture }) | undefined;
      mat?.map?.dispose?.();
      mat?.dispose?.();
    }
    this.measurePts = [];
    this.onMeasure(null);
  }

  // --- 단면(클리핑 평면) ------------------------------------------------

  setSection(opts: { enabled?: boolean; axis?: 'x' | 'y' | 'z'; offset?: number; flip?: boolean }) {
    if (opts.enabled !== undefined) this.sectionEnabled = opts.enabled;
    if (opts.axis !== undefined) this.sectionAxis = opts.axis;
    if (opts.offset !== undefined) this.sectionOffset = opts.offset;
    if (opts.flip !== undefined) this.sectionFlip = opts.flip;
    this.applySection();
  }

  private applySection() {
    if (!this.sectionEnabled) {
      this.renderer.clippingPlanes = [];
      return;
    }
    const box = new THREE.Box3();
    for (const m of this.models) box.expandByObject(m.group);
    if (box.isEmpty()) {
      this.renderer.clippingPlanes = [];
      return;
    }
    const min = box.min;
    const max = box.max;
    const sign = this.sectionFlip ? -1 : 1;
    const normal = new THREE.Vector3(
      this.sectionAxis === 'x' ? sign : 0,
      this.sectionAxis === 'y' ? sign : 0,
      this.sectionAxis === 'z' ? sign : 0,
    );
    const lo = this.sectionAxis === 'x' ? min.x : this.sectionAxis === 'y' ? min.y : min.z;
    const hi = this.sectionAxis === 'x' ? max.x : this.sectionAxis === 'y' ? max.y : max.z;
    const coord = lo + (hi - lo) * this.sectionOffset;
    const point = new THREE.Vector3(
      this.sectionAxis === 'x' ? coord : 0,
      this.sectionAxis === 'y' ? coord : 0,
      this.sectionAxis === 'z' ? coord : 0,
    );
    this.sectionPlane.setFromNormalAndCoplanarPoint(normal, point);
    this.renderer.clippingPlanes = [this.sectionPlane];
  }

  // --- issue pins (통합모델 3D) -----------------------------------------

  private issuePinGroup: THREE.Group | null = null;

  /**
   * Drop a marker on each issue-linked element so the integrated 3D model shows
   * where issues live. Color encodes status (open=red / closed=green). Toggle
   * with setIssuePinsVisible(). Elements not found are skipped.
   */
  setIssuePins(pins: { modelID: number; expressID: number; color?: number; issueId?: string }[]) {
    this.clearIssuePins();
    if (pins.length === 0) return;

    const sceneBox = new THREE.Box3();
    for (const model of this.models) sceneBox.expandByObject(model.group);
    const maxDim = sceneBox.isEmpty() ? 10 : sceneBox.getSize(new THREE.Vector3()).length();
    const r = Math.max(maxDim * 0.01, 0.25);

    const group = new THREE.Group();
    const box = new THREE.Box3();
    for (const p of pins) {
      box.makeEmpty();
      for (const mesh of this.meshesFor(p.modelID, p.expressID)) box.expandByObject(mesh);
      if (box.isEmpty()) continue;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(r, 14, 14),
        new THREE.MeshBasicMaterial({
          color: p.color ?? 0xdc2626,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      marker.position.copy(box.getCenter(new THREE.Vector3()));
      marker.renderOrder = 998;
      marker.userData.issueId = p.issueId;
      group.add(marker);
    }
    this.issuePinGroup = group;
    this.scene.add(group);
  }

  setIssuePinsVisible(visible: boolean) {
    if (this.issuePinGroup) this.issuePinGroup.visible = visible;
  }

  clearIssuePins() {
    if (!this.issuePinGroup) return;
    this.scene.remove(this.issuePinGroup);
    this.issuePinGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      (m.material as THREE.Material)?.dispose?.();
    });
    this.issuePinGroup = null;
  }

  /**
   * Apply per-element appearance states for a point in time, using `opts` for
   * per-kind active colors / opacity / ghost mode. Elements not in `states` are
   * restored to their pre-4D look (so unmapped objects stay visible).
   *
   * Incremental: each mesh remembers its last applied appearance (state + the
   * settings signature), so during playback only changed meshes are mutated —
   * large models don't churn every tick.
   */
  applyConstruction(
    states: Iterable<{ modelID: number; expressID: number; state: CellState }>,
    opts: AppearanceSettings,
  ) {
    const desired = new Map<THREE.Mesh, CellState>();
    for (const { modelID, expressID, state } of states) {
      for (const mesh of this.meshesFor(modelID, expressID)) desired.set(mesh, state);
    }

    // Restore meshes no longer governed by the 4D layer.
    for (const [mesh, rec] of this.constructionOverrides) {
      if (!desired.has(mesh)) {
        mesh.material = rec.saved.material;
        mesh.visible = rec.saved.visible;
        this.constructionOverrides.delete(mesh);
      }
    }

    const sig = `${opts.activeOpacity}|${opts.colorConstruct}|${opts.colorDemolish}|${opts.colorTemporary}|${opts.ghostFuture}`;
    for (const [mesh, state] of desired) {
      let rec = this.constructionOverrides.get(mesh);
      if (!rec) {
        rec = { saved: { material: mesh.material, visible: mesh.visible }, key: '' };
        this.constructionOverrides.set(mesh, rec);
      }
      const key = `${state}|${sig}`;
      if (rec.key === key) continue;
      rec.key = key;
      this.applyMeshState(mesh, state, opts, rec.saved.material);
    }
  }

  private applyMeshState(
    mesh: THREE.Mesh,
    state: CellState,
    opts: AppearanceSettings,
    original: THREE.Material | THREE.Material[],
  ) {
    switch (state) {
      case 'hidden':
        mesh.visible = false;
        break;
      case 'normal':
        mesh.material = original;
        mesh.visible = true;
        break;
      case 'ghost':
        if (opts.ghostFuture) {
          mesh.material = this.getGhostMaterial();
          mesh.visible = true;
        } else {
          mesh.visible = false;
        }
        break;
      case 'active-construct':
        mesh.material = this.getColorMaterial(opts.colorConstruct, opts.activeOpacity);
        mesh.visible = true;
        break;
      case 'active-demolish':
        mesh.material = this.getColorMaterial(opts.colorDemolish, opts.activeOpacity);
        mesh.visible = true;
        break;
      case 'active-temporary':
        mesh.material = this.getColorMaterial(opts.colorTemporary, opts.activeOpacity);
        mesh.visible = true;
        break;
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

  private getColorMaterial(hex: string, opacity: number): THREE.Material {
    const key = `${hex}|${opacity}`;
    let mat = this.material4dCache.get(key);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(hex),
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
        side: THREE.DoubleSide,
      });
      this.material4dCache.set(key, mat);
    }
    return mat;
  }

  private getGhostMaterial(): THREE.Material {
    if (!this.ghostMaterial) {
      this.ghostMaterial = new THREE.MeshLambertMaterial({
        color: 0x6b7686,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    return this.ghostMaterial;
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

  private frameBox(box: THREE.Box3, factor = 1.8) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * factor;

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

    // 흰색 배경에서 보이도록 밝은 회색 그리드(중심선은 약간 진하게).
    const grid = new THREE.GridHelper(100, 100, 0x9aa5b5, 0xd7dde6);
    this.scene.add(grid);
  }

  private handleResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return; // hidden/collapsed — skip to avoid NaN aspect
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.stepCameraTween();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /** Advance the camera fly-through one frame (smoothstep easing). */
  private stepCameraTween() {
    const tw = this.cameraTween;
    if (!tw) return;
    const t = Math.min(1, (performance.now() - tw.start) / tw.dur);
    const e = t * t * (3 - 2 * t); // smoothstep
    this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    this.controls.target.lerpVectors(tw.fromTgt, tw.toTgt, e);
    if (tw.fov0 !== tw.fov1) {
      this.camera.fov = tw.fov0 + (tw.fov1 - tw.fov0) * e;
      this.camera.updateProjectionMatrix();
    }
    if (t >= 1) {
      const done = tw.onDone;
      this.cameraTween = null;
      this.controls.enabled = true;
      done?.();
    }
  };

  dispose() {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Draw a rounded-rectangle path (fallback for label backgrounds). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
