import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import {
  IfcAPI,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCMAPCONVERSION,
  IFCSIUNIT,
  IFCCONVERSIONBASEDUNIT,
  IFCRELDEFINESBYPROPERTIES,
  IFCPROJECT,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  type FlatMesh,
  type PlacedGeometry,
} from 'web-ifc';

export interface PropertyGroup {
  /** Group title — the IFC property-set / quantity-set name (Revit exports these
   *  as 일반·치수·구속조건·재료 및 마감재 등, so we surface them verbatim). */
  name: string;
  props: { key: string; value: string }[];
}

export interface ElementProperties {
  modelID: number;
  expressID: number;
  type: string;
  name: string;
  /** Flat direct attributes (kept for existing consumers). */
  attributes: { key: string; value: string }[];
  /** Grouped view: 일반(직접 속성) + IFC 속성세트/수량세트별 묶음. */
  groups: PropertyGroup[];
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
  /**
   * Translation subtracted from every transform at load time so far-from-origin
   * georeferenced geometry stays near the local origin (float32 precision). Add
   * it back after `group.worldToLocal()` to recover original project coordinates.
   */
  offset: THREE.Vector3;
}

export type UpAxis = 'x' | 'y' | 'z';

/** Minimal element descriptor used by the 4D layer to map schedule ↔ objects. */
export interface ElementInfo {
  modelID: number;
  expressID: number;
  name: string;
}

/** 측정 객체 스냅 종류(보완1): 정점·중간점·면중심·근처점. */
export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'nearest';

/** 측정 종류(추가의견3): 거리·각도·면적·연속. */
export type MeasureType = 'distance' | 'angle' | 'area' | 'continuous';

/** 버전 diff 투명도 옵션(추가의견1). */
export interface DiffOpts {
  addedOpacity?: number;
  removedOpacity?: number;
  sameOpacity?: number;
}

const MEASURE_HINT: Record<MeasureType, string> = {
  distance: '두 점을 클릭해 거리를 잽니다.',
  angle: '세 점(꼭짓점은 두 번째)을 클릭합니다.',
  area: '경계 점들을 클릭하고 완료를 누릅니다.',
  continuous: '점을 이어 클릭하고 완료를 누릅니다(누적 거리).',
};

/** 3D 다각형 면적(Newell normal 기반, 비평면도 근사). */
function polygonArea(pts: THREE.Vector3[]): number {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.length() / 2;
}

/** A node in the IFC spatial/decomposition tree (Project→Site→…→부재). */
export interface SpatialNode {
  modelID: number;
  expressID: number;
  name: string;
  type: string;
  /** True when this node has geometry (selectable / visibility leaf). */
  isElement: boolean;
  children: SpatialNode[];
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

/**
 * Raw quantities for one element, expressed in the model's own length unit
 * (NOT yet normalized to metres). `source` records where each came from:
 * 'ifc' = read from an IfcElementQuantity (BaseQuantities), 'mesh' = derived
 * from the rendered triangle mesh (volume/area integral + bbox), 'count' =
 * geometry-less (only the object count is meaningful). The quantification
 * layer (`src/lib/quantities.ts`) scales these to m/m²/m³.
 */
export interface RawElementQty {
  /** longest meaningful linear measure (model units); 0 if unknown */
  length: number;
  /** surface/section area (model units²); 0 if unknown */
  area: number;
  /** volume (model units³); 0 if unknown */
  volume: number;
  source: 'ifc' | 'mesh' | 'count';
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

/** On-screen size of an issue pin (sprite scale, sizeAttenuation off; the sprite
 *  spans this fraction of the NDC cube, i.e. half this fraction of the viewport). */
/** On-demand 렌더: 마지막 활동 후 이 시간(ms)까지만 매 프레임 그린다. */
const RENDER_GRACE_MS = 350;

const PIN_SIZE = 0.075;
/** Pin canvas aspect (width / height) — teardrop is taller than wide. */
const PIN_ASPECT = 0.8;

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
  /** Shared recenter offset (first model's origin) so all models keep true relative
   *  positions instead of stacking on the project base point (추가의견2). */
  private sceneOffset: THREE.Vector3 | null = null;
  /** On-demand 렌더: 마지막 활동 시각(ms). animate 는 이후 RENDER_GRACE_MS 만 그린다. */
  private lastActive = performance.now();

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
  /** metres-per-model-length-unit cache (null = undetectable) per model (QTO) */
  private lengthScaleCache = new Map<number, number | null>();
  /** expressID -> IfcElementQuantity BaseQuantities cache per model (QTO) */
  private quantityIndexCache = new Map<number, Map<number, { length: number; area: number; volume: number }>>();

  // --- 측정 / 단면(클리핑) ----------------------------------------------
  private measureMode = false;
  private measureType: MeasureType = 'distance';
  private measurePts: THREE.Vector3[] = [];
  /** 측정 스냅(추가4/보완1): 커서 근처로 스냅된 월드 점(없으면 null) + 표시 마커. */
  private snapWorld: THREE.Vector3 | null = null;
  private snapSprite?: THREE.Sprite;
  private snapTextures = new Map<SnapKind, THREE.CanvasTexture>();
  /** 켜진 스냅 모드(AutoCAD 객체 스냅 유사). */
  private snapModes: Record<SnapKind, boolean> = {
    vertex: true,
    midpoint: true,
    center: true,
    nearest: false,
  };
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
  /** fired on mouse move with the hovered point in project coords (null = empty) */
  private onHover: (p: THREE.Vector3 | null) => void = () => {};
  /** rAF handle throttling hover raycasts to one per frame */
  private hoverRaf = 0;
  private hoverEvent: { x: number; y: number } | null = null;
  private initialized = false;
  private disposed = false;
  private resizeObserver?: ResizeObserver;

  /** R/G/B axes at the model origin (off by default; setOriginVisible) */
  private originHelper?: THREE.AxesHelper;

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
    // On-demand 렌더: 카메라가 움직이면(댐핑 포함) 활성 표시 → 그 후 잠깐만 렌더.
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(this.measureGroup);
    this.setupSceneHelpers();

    this.renderer.domElement.addEventListener('click', this.handleClick);
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove);
    this.renderer.domElement.addEventListener('mouseleave', this.handleMouseLeave);
    this.renderer.domElement.addEventListener('pointerdown', this.requestRender);
    this.renderer.domElement.addEventListener('wheel', this.requestRender, { passive: true });
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

  /**
   * Report the hovered surface point in project coordinates as the mouse moves
   * (rAF-throttled, one raycast per frame). The callback gets null over empty
   * space. Used by the coordinate HUD.
   */
  setOnHover(cb: (p: THREE.Vector3 | null) => void) {
    this.onHover = cb;
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
      // 원형 단면(말뚝·기둥 등)을 다각형이 아닌 매끈한 원으로 보이게 분할수를 올린다.
      // web-ifc 기본 12 → 24 (실루엣이 충분히 둥글면서 삼각형 증가는 제한적).
      CIRCLE_SEGMENTS: 24,
    });

    const group = new THREE.Group();
    const elementMeshes = new Map<number, THREE.Mesh[]>();
    const materialCache = new Map<string, THREE.Material>();

    // Recentering offset. The FIRST loaded model's first-element origin becomes a
    // single shared scene offset; every later model is recentered by the SAME
    // offset so georeferenced models keep their true relative positions instead of
    // all stacking on the project base point (추가의견2). Far-from-origin
    // coordinates still stay near the local origin for float32 precision.
    let modelOffset: THREE.Vector3 | null = this.sceneOffset ? this.sceneOffset.clone() : null;

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
          // First model in the scene → its first-element origin defines the shared offset.
          modelOffset = new THREE.Vector3().setFromMatrixPosition(matrix);
          this.sceneOffset = modelOffset.clone();
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
    const model: LoadedModel = {
      modelID,
      group,
      elementMeshes,
      upAxis,
      label,
      offset: modelOffset ?? new THREE.Vector3(0, 0, 0),
    };
    this.models.push(model);
    this.spatialTreeCache = undefined; // 모델 구성이 바뀌면 공간 트리 재계산

    this.orientGroup(group, upAxis);
    this.fitToObject(group);
    this.requestRender();
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

  /**
   * Convert a Three.js world-space point to the project's survey coordinates so
   * the numbers match the authoring tool's project base point (Revit 동서/남북/높이,
   * IFC Easting/Northing/Elevation). The group is rotated for the up-axis and
   * recentered by `offset` at load, so we first undo the world transform
   * (`worldToLocal`) and add the offset back to recover raw model-space coords.
   *
   * The bridge IFC exports we handle are delivered Y-up, where the raw model axes
   * are (Easting, Elevation, −Northing) — i.e. height is Y and the horizontal
   * plane is X(동서)/Z, with North along −Z. We remap those to
   * x=동서(Easting), y=남북(Northing), z=높이(Elevation) so a hovered point lines
   * up with the project base point shown in Revit. Genuine Z-up models already
   * carry (Easting, Northing, Elevation) and pass through unchanged.
   * Returns null if the model isn't loaded.
   */
  worldToProject(modelID: number, p: THREE.Vector3): THREE.Vector3 | null {
    const model = this.models.find((m) => m.modelID === modelID);
    if (!model) return null;
    const local = model.group.worldToLocal(p.clone()).add(model.offset);
    if (model.upAxis === 'y') return new THREE.Vector3(local.x, -local.z, local.y);
    return local;
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
    // 측정 모드: 스냅된 점(끝점·중간점)이 있으면 그 점을, 없으면 표면 점을 찍는다.
    if (this.measureMode) {
      const p = this.snapWorld?.clone() ?? this.pickPoint(event.clientX, event.clientY);
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

  // Hover → coordinate HUD. Coalesce moves to one raycast per animation frame so
  // fast mouse motion over large models doesn't flood the picker.
  private handleMouseMove = (event: MouseEvent) => {
    this.hoverEvent = { x: event.clientX, y: event.clientY };
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const e = this.hoverEvent;
      if (!e) return;
      const hit = this.pickHover(e.x, e.y);
      this.onHover(hit);
      // 측정 모드에서는 커서 근처 꼭짓점/중간점으로 스냅 마커를 갱신(렌더 유지).
      if (this.measureMode) {
        this.updateSnap(e.x, e.y);
        this.requestRender();
      }
    });
  };

  private handleMouseLeave = () => {
    this.hoverEvent = null;
    this.onHover(null);
  };

  /** Raycast against visible meshes; return the hit point in project coords. */
  private pickHover(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.allMeshes().filter((m) => m.visible), false);
    const hit = hits[0];
    if (!hit) return null;
    const modelID = (hit.object.userData.modelID as number) ?? this.primaryModelID;
    if (modelID == null) return null;
    return this.worldToProject(modelID, hit.point);
  }

  /**
   * Pick an issue pin by screen-space proximity. The pins are constant-size
   * billboards (sizeAttenuation off), so their world scale is tiny and a normal
   * raycast misses; instead we project each pin to screen pixels and take the
   * nearest one within a click radius, preferring pins closer to the camera.
   */
  private pickIssuePin(clientX: number, clientY: number): string | null {
    if (!this.issuePinGroup || !this.issuePinGroup.visible) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Pins are anchored at their teardrop tip and the body sits above it. Bias the
    // hit centre up by ~half the rendered height and use a radius covering the body.
    const pinH = PIN_SIZE * 0.5 * rect.height; // rendered pin height in px
    const bias = pinH * 0.5;
    const threshold = Math.max(24, pinH);
    const v = new THREE.Vector3();
    let best: { id: string; depth: number } | null = null;
    for (const child of this.issuePinGroup.children) {
      const id = child.userData.issueId;
      if (typeof id !== 'string') continue;
      v.setFromMatrixPosition(child.matrixWorld).project(this.camera);
      if (v.z > 1) continue; // behind the camera
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height - bias;
      const dist2 = (sx - px) ** 2 + (sy - py) ** 2;
      if (dist2 > threshold * threshold) continue;
      if (!best || v.z < best.depth) best = { id, depth: v.z };
    }
    return best?.id ?? null;
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

  /** Select an element from the object tree: highlight + fire onSelect, without
   *  moving the camera (use focusElement when a camera jump is wanted). */
  selectElement(modelID: number, expressID: number): boolean {
    if (this.meshesFor(modelID, expressID).length === 0) return false;
    this.highlight(modelID, expressID);
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
    this.requestRender();
  }

  private clearHighlight() {
    for (const { mesh, material } of this.highlighted) {
      (mesh.material as THREE.Material).dispose?.();
      mesh.material = material;
    }
    this.highlighted = [];
    this.requestRender();
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

    // 그룹뷰: 일반(직접 속성) + IFC 속성세트/수량세트별 묶음.
    const groups: PropertyGroup[] = [];
    if (attributes.length) groups.push({ name: '일반', props: attributes });
    groups.push(...this.propertyGroupsFor(modelID, expressID));

    return { modelID, expressID, type, name, attributes, groups };
  }

  // expressID → 속성세트/수량세트 그룹. 모델당 1회 인덱싱 후 캐시.
  private propertyGroupsCache = new Map<number, Map<number, PropertyGroup[]>>();

  private propertyGroupsFor(modelID: number, expressID: number): PropertyGroup[] {
    let index = this.propertyGroupsCache.get(modelID);
    if (!index) {
      try {
        index = this.buildPropertyIndex(modelID);
      } catch {
        index = new Map();
      }
      this.propertyGroupsCache.set(modelID, index);
    }
    return index.get(expressID) ?? [];
  }

  /**
   * Index every element's IFC property sets (IfcPropertySet → IfcPropertySingleValue)
   * and quantity sets (IfcElementQuantity), grouped by set name. Revit exports its
   * 매개변수 groups as these set names, so the result mirrors the authoring tool.
   */
  private buildPropertyIndex(modelID: number): Map<number, PropertyGroup[]> {
    const out = new Map<number, PropertyGroup[]>();
    const rels = this.ifcAPI.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      try {
        const rel = this.ifcAPI.GetLine(modelID, rels.get(i), false) as Record<string, any>;
        const pdId = rel?.RelatingPropertyDefinition?.value as number | undefined;
        const related = rel?.RelatedObjects;
        if (pdId == null || !Array.isArray(related)) continue;

        const pd = this.ifcAPI.GetLine(modelID, pdId, true) as Record<string, any>;
        const setName = this.readValue(pd?.Name) ?? 'IFC 매개변수';
        const props: { key: string; value: string }[] = [];

        if (Array.isArray(pd?.HasProperties)) {
          for (const p of pd.HasProperties) {
            const key = this.readValue(p?.Name);
            const val = this.readValue(p?.NominalValue);
            if (key && val != null) props.push({ key, value: val });
          }
        } else if (Array.isArray(pd?.Quantities)) {
          for (const q of pd.Quantities) {
            const key = this.readValue(q?.Name);
            const val =
              this.readValue(q?.LengthValue) ??
              this.readValue(q?.AreaValue) ??
              this.readValue(q?.VolumeValue) ??
              this.readValue(q?.CountValue) ??
              this.readValue(q?.WeightValue);
            if (key && val != null) props.push({ key, value: val });
          }
        }
        if (props.length === 0) continue;

        for (const ro of related) {
          const id = ro?.value as number | undefined;
          if (id == null) continue;
          const arr = out.get(id) ?? [];
          arr.push({ name: setName, props });
          out.set(id, arr);
        }
      } catch {
        /* skip malformed relation */
      }
    }
    return out;
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
    this.requestRender();
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
    this.requestRender();
  }

  showAll() {
    for (const mesh of this.allMeshes()) mesh.visible = true;
    this.requestRender();
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
    this.requestRender();
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

  private spatialTreeCache?: SpatialNode[];

  /**
   * IFC spatial/decomposition tree (추가3): Project → Site → Building → Storey →
   * 부재, built from IfcRelAggregates (공간 분해) + IfcRelContainedInSpatialStructure
   * (요소→공간 배치). Leaves that carry geometry are marked `isElement` so the UI
   * can select them. Cached; combined across loaded models.
   */
  getSpatialTree(): SpatialNode[] {
    if (this.spatialTreeCache) return this.spatialTreeCache;
    const out: SpatialNode[] = [];
    for (const model of this.models) {
      try {
        out.push(...this.spatialTreeForModel(model.modelID));
      } catch {
        /* skip malformed model */
      }
    }
    this.spatialTreeCache = out;
    return out;
  }

  private spatialTreeForModel(modelID: number): SpatialNode[] {
    const childrenOf = new Map<number, number[]>();
    const add = (parent: number, kids: number[]) => {
      const arr = childrenOf.get(parent) ?? [];
      for (const k of kids) if (!arr.includes(k)) arr.push(k);
      childrenOf.set(parent, arr);
    };
    const collectRel = (relType: number, parentKey: string, childKey: string) => {
      const rels = this.ifcAPI.GetLineIDsWithType(modelID, relType);
      for (let i = 0; i < rels.size(); i++) {
        try {
          const rel = this.ifcAPI.GetLine(modelID, rels.get(i), false) as Record<string, any>;
          const parent = rel?.[parentKey]?.value as number | undefined;
          const kids = rel?.[childKey];
          if (parent == null || !Array.isArray(kids)) continue;
          add(parent, kids.map((k: any) => k?.value).filter((v: unknown): v is number => v != null));
        } catch {
          /* skip */
        }
      }
    };
    collectRel(IFCRELAGGREGATES, 'RelatingObject', 'RelatedObjects');
    collectRel(IFCRELCONTAINEDINSPATIALSTRUCTURE, 'RelatingStructure', 'RelatedElements');

    const geom = new Set(this.models.find((m) => m.modelID === modelID)?.elementMeshes.keys() ?? []);
    const seen = new Set<number>();
    const build = (id: number, depth: number): SpatialNode | null => {
      if (seen.has(id) || depth > 30) return null;
      seen.add(id);
      const kids = (childrenOf.get(id) ?? [])
        .map((k) => build(k, depth + 1))
        .filter((n): n is SpatialNode => n !== null);
      const isElement = geom.has(id);
      // 지오메트리도 없고 하위 노드도 없는 빈 가지는 버린다.
      if (!isElement && kids.length === 0) return null;
      return {
        modelID,
        expressID: id,
        name: this.readName(modelID, id) || this.readCategory(modelID, id),
        type: this.readCategory(modelID, id),
        isElement,
        children: kids,
      };
    };

    const projects = this.ifcAPI.GetLineIDsWithType(modelID, IFCPROJECT);
    const roots: SpatialNode[] = [];
    for (let i = 0; i < projects.size(); i++) {
      const n = build(projects.get(i), 0);
      if (n) roots.push(n);
    }
    return roots;
  }

  private readCategory(modelID: number, expressID: number): string {
    try {
      const typeCode = this.ifcAPI.GetLineType(modelID, expressID);
      return this.ifcAPI.GetNameFromTypeCode(typeCode) ?? 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  // --- 5D quantification (QTO) support ----------------------------------

  /**
   * Metres per model length unit, read from the model's IfcUnitAssignment
   * (IfcSIUnit LENGTHUNIT prefix, or an IfcConversionBasedUnit factor). e.g. a
   * millimetre model returns 0.001. Returns null when the unit cannot be
   * determined, so the caller can fall back to a manual mm/m toggle. Cached.
   */
  getLengthUnitToMeters(modelID: number): number | null {
    if (this.lengthScaleCache.has(modelID)) return this.lengthScaleCache.get(modelID) ?? null;
    let scale: number | null = null;
    try {
      scale = this.readSiLengthScale(modelID) ?? this.readConversionLengthScale(modelID);
    } catch {
      scale = null;
    }
    this.lengthScaleCache.set(modelID, scale);
    return scale;
  }

  /** SI prefix → factor relative to the base unit (metre). */
  private static readonly SI_PREFIX: Record<string, number> = {
    EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
    HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3,
    MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
  };

  private readSiLengthScale(modelID: number): number | null {
    const ids = this.ifcAPI.GetLineIDsWithType(modelID, IFCSIUNIT);
    for (let i = 0; i < ids.size(); i++) {
      const u = this.ifcAPI.GetLine(modelID, ids.get(i), false) as Record<string, any>;
      if (u?.UnitType?.value !== 'LENGTHUNIT') continue;
      const prefix = u?.Prefix?.value as string | undefined;
      return prefix ? IfcViewer.SI_PREFIX[prefix] ?? 1 : 1; // METRE base = 1 m
    }
    return null;
  }

  /** Imperial / custom length units defined via IfcConversionBasedUnit. */
  private readConversionLengthScale(modelID: number): number | null {
    const ids = this.ifcAPI.GetLineIDsWithType(modelID, IFCCONVERSIONBASEDUNIT);
    for (let i = 0; i < ids.size(); i++) {
      const u = this.ifcAPI.GetLine(modelID, ids.get(i), true) as Record<string, any>;
      if (u?.UnitType?.value !== 'LENGTHUNIT') continue;
      const factor = Number(u?.ConversionFactor?.ValueComponent?.value);
      if (!Number.isFinite(factor) || factor <= 0) continue;
      // The referenced unit is the SI base it converts to (almost always metre).
      const refUnit = u?.ConversionFactor?.UnitComponent as Record<string, any> | undefined;
      const refPrefix = refUnit?.Prefix?.value as string | undefined;
      const refScale = refPrefix ? IfcViewer.SI_PREFIX[refPrefix] ?? 1 : 1;
      return factor * refScale;
    }
    return null;
  }

  /**
   * BaseQuantities (IfcElementQuantity) for one element, in model length units,
   * or null if the element has none. The per-model index of element→quantities
   * is built once (walking IfcRelDefinesByProperties) and cached.
   */
  getElementBaseQuantities(modelID: number, expressID: number): { length: number; area: number; volume: number } | null {
    let index = this.quantityIndexCache.get(modelID);
    if (!index) {
      try {
        index = this.buildQuantityIndex(modelID);
      } catch {
        index = new Map();
      }
      this.quantityIndexCache.set(modelID, index);
    }
    return index.get(expressID) ?? null;
  }

  private buildQuantityIndex(modelID: number): Map<number, { length: number; area: number; volume: number }> {
    const out = new Map<number, { length: number; area: number; volume: number }>();
    const rels = this.ifcAPI.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      try {
        const rel = this.ifcAPI.GetLine(modelID, rels.get(i), false) as Record<string, any>;
        const pdId = rel?.RelatingPropertyDefinition?.value as number | undefined;
        if (pdId == null) continue;
        const pd = this.ifcAPI.GetLine(modelID, pdId, true) as Record<string, any>;
        const quantities = pd?.Quantities;
        if (!Array.isArray(quantities)) continue; // not an IfcElementQuantity
        const q = this.pickBaseQuantities(quantities);
        if (q.length === 0 && q.area === 0 && q.volume === 0) continue;
        const related = rel?.RelatedObjects;
        if (!Array.isArray(related)) continue;
        for (const ro of related) {
          const id = ro?.value as number | undefined;
          if (id == null) continue;
          const prev = out.get(id);
          // Keep the richer record if an element is defined by multiple psets.
          if (!prev) out.set(id, { ...q });
          else out.set(id, {
            length: prev.length || q.length,
            area: prev.area || q.area,
            volume: prev.volume || q.volume,
          });
        }
      } catch {
        /* skip malformed relation */
      }
    }
    return out;
  }

  /**
   * From an IfcElementQuantity's quantity list pick the best Length/Area/Volume.
   * Prefers Net* then Gross* then any, matching common BaseQuantities naming.
   */
  private pickBaseQuantities(quantities: any[]): { length: number; area: number; volume: number } {
    const rank = (name: string): number => {
      const n = name.toLowerCase();
      if (n.startsWith('net')) return 0;
      if (n.startsWith('gross')) return 1;
      return 2;
    };
    let length = 0, area = 0, volume = 0;
    let lr = 99, ar = 99, vr = 99;
    for (const q of quantities) {
      const name = (q?.Name?.value as string) ?? '';
      const r = rank(name);
      const vol = q?.VolumeValue?.value;
      const ara = q?.AreaValue?.value;
      const len = q?.LengthValue?.value;
      if (vol != null && Number.isFinite(Number(vol)) && r < vr) { volume = Math.abs(Number(vol)); vr = r; }
      else if (ara != null && Number.isFinite(Number(ara)) && r < ar) { area = Math.abs(Number(ara)); ar = r; }
      else if (len != null && Number.isFinite(Number(len)) && r < lr) { length = Math.abs(Number(len)); lr = r; }
    }
    return { length, area, volume };
  }

  /**
   * Mesh-based quantities for one element (model length units): closed-volume
   * via the signed tetrahedron (divergence) integral, total surface area, and
   * bounding-box dimensions. Returns null if the element has no geometry.
   * Used as the fallback when an element carries no IfcElementQuantity.
   */
  getMeshQuantities(modelID: number, expressID: number): { volume: number; area: number; bbox: THREE.Vector3 } | null {
    const meshes = this.meshesFor(modelID, expressID);
    if (meshes.length === 0) return null;
    let volume = 0;
    let area = 0;
    const box = new THREE.Box3();
    box.makeEmpty();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const geom = mesh.geometry as THREE.BufferGeometry;
      const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) continue;
      const m = mesh.matrixWorld;
      const index = geom.getIndex();
      const triCount = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        box.expandByPoint(a);
        box.expandByPoint(b);
        box.expandByPoint(c);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        cross.crossVectors(ab, ac);
        area += cross.length() * 0.5;
        // signed volume of the tetrahedron (origin, a, b, c) = a · (b × c) / 6
        volume += a.dot(cross.copy(b).cross(c)) / 6;
      }
    }
    const bbox = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    return { volume: Math.abs(volume), area, bbox };
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
    this.requestRender();
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
    if (!on) {
      this.onMeasure(null);
      this.snapWorld = null;
      if (this.snapSprite) this.snapSprite.visible = false;
    }
    this.requestRender();
  }

  /**
   * Measurement snap (추가4): find the nearest model vertex (끝점) or triangle edge
   * midpoint (중간점) to the cursor, within a screen-pixel threshold, and place a
   * snap marker there. The snapped world point (if any) is used on the next click.
   */
  private updateSnap(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.allMeshes().filter((m) => m.visible), false);
    const hit = hits[0];
    if (!hit || !hit.face) {
      this.snapWorld = null;
      if (this.snapSprite) this.snapSprite.visible = false;
      return;
    }
    const geom = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) {
      this.snapWorld = null;
      if (this.snapSprite) this.snapSprite.visible = false;
      return;
    }
    const mw = (hit.object as THREE.Mesh).matrixWorld;
    const { a, b, c } = hit.face;
    const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mw);
    const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mw);
    const vc = new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(mw);

    // 켜진 모드별 후보. 우선순위 bias(작을수록 우대): 정점 > 중간점 > 면중심 > 근처점.
    const candidates: { p: THREE.Vector3; bias: number; kind: SnapKind }[] = [];
    if (this.snapModes.vertex) {
      candidates.push({ p: va, bias: 0, kind: 'vertex' });
      candidates.push({ p: vb, bias: 0, kind: 'vertex' });
      candidates.push({ p: vc, bias: 0, kind: 'vertex' });
    }
    if (this.snapModes.midpoint) {
      candidates.push({ p: va.clone().lerp(vb, 0.5), bias: 3, kind: 'midpoint' });
      candidates.push({ p: vb.clone().lerp(vc, 0.5), bias: 3, kind: 'midpoint' });
      candidates.push({ p: vc.clone().lerp(va, 0.5), bias: 3, kind: 'midpoint' });
    }
    if (this.snapModes.center) {
      candidates.push({
        p: new THREE.Vector3().add(va).add(vb).add(vc).multiplyScalar(1 / 3),
        bias: 5,
        kind: 'center',
      });
    }
    if (this.snapModes.nearest) {
      candidates.push({ p: hit.point.clone(), bias: 10, kind: 'nearest' });
    }

    const SNAP_PX = 14;
    let best: { p: THREE.Vector3; kind: SnapKind } | null = null;
    let bestScore = SNAP_PX;
    for (const cand of candidates) {
      const proj = cand.p.clone().project(this.camera);
      const sx = rect.left + (proj.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-proj.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY) + cand.bias;
      if (d < bestScore) {
        bestScore = d;
        best = { p: cand.p, kind: cand.kind };
      }
    }
    this.snapWorld = best?.p ?? null;
    this.showSnapMarker(best);
  }

  /** Enable/disable snap modes (객체 스냅 옵션). */
  setSnapModes(modes: Partial<Record<SnapKind, boolean>>) {
    this.snapModes = { ...this.snapModes, ...modes };
  }

  private showSnapMarker(best: { p: THREE.Vector3; kind: SnapKind } | null) {
    this.requestRender();
    if (!best) {
      if (this.snapSprite) this.snapSprite.visible = false;
      return;
    }
    if (!this.snapSprite) {
      this.snapSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true }),
      );
      this.snapSprite.renderOrder = 1004;
      this.snapSprite.scale.set(0.028, 0.028, 1);
      this.scene.add(this.snapSprite);
    }
    (this.snapSprite.material as THREE.SpriteMaterial).map = this.snapTexture(best.kind);
    (this.snapSprite.material as THREE.SpriteMaterial).needsUpdate = true;
    this.snapSprite.position.copy(best.p);
    this.snapSprite.visible = true;
    this.requestRender();
  }

  /** Per-kind snap marker glyph (정점=사각, 중간점=삼각, 면중심=원, 근처점=X). */
  private snapTexture(kind: SnapKind): THREE.CanvasTexture {
    const cached = this.snapTextures.get(kind);
    if (cached) return cached;
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d')!;
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    const color = { vertex: '#16a34a', midpoint: '#f59e0b', center: '#2563eb', nearest: '#a855f7' }[kind];
    ctx.strokeStyle = color;
    const m = 10;
    if (kind === 'vertex') {
      ctx.strokeRect(m, m, s - 2 * m, s - 2 * m);
    } else if (kind === 'midpoint') {
      ctx.beginPath();
      ctx.moveTo(s / 2, m);
      ctx.lineTo(s - m, s - m);
      ctx.lineTo(m, s - m);
      ctx.closePath();
      ctx.stroke();
    } else if (kind === 'center') {
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2 - m, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(m, m);
      ctx.lineTo(s - m, s - m);
      ctx.moveTo(s - m, m);
      ctx.lineTo(m, s - m);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    this.snapTextures.set(kind, tex);
    return tex;
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

  /** 측정 종류 선택(거리·각도·면적·연속). */
  setMeasureType(t: MeasureType) {
    this.measureType = t;
    this.measurePts = [];
    this.onMeasure(MEASURE_HINT[t]);
  }

  /** 면적/연속 측정을 종료(현재까지 누적된 점으로 마무리). */
  finishMeasure() {
    const pts = this.measurePts;
    if (this.measureType === 'area' && pts.length >= 3) {
      this.drawSegment(pts[pts.length - 1], pts[0]);
      const area = polygonArea(pts);
      const center = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      this.measureGroup.add(this.makeLabel(`${area.toFixed(3)} m²`, center));
      this.onMeasure(`면적: ${area.toFixed(3)} m²`);
    } else if (this.measureType === 'continuous' && pts.length >= 2) {
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
      this.measureGroup.add(this.makeLabel(`Σ ${total.toFixed(3)} m`, pts[pts.length - 1]));
      this.onMeasure(`누적 거리: ${total.toFixed(3)} m`);
    }
    this.measurePts = [];
    this.requestRender();
  }

  private drawSegment(a: THREE.Vector3, b: THREE.Vector3) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0x2563eb, depthTest: false }),
    );
    line.renderOrder = 1000;
    this.measureGroup.add(line);
  }

  private addMeasurePoint(p: THREE.Vector3) {
    this.measurePts.push(p);
    this.measureGroup.add(this.makeMeasureDot(p));
    const pts = this.measurePts;

    switch (this.measureType) {
      case 'distance':
        if (pts.length === 2) {
          const d = pts[0].distanceTo(pts[1]);
          this.drawSegment(pts[0], pts[1]);
          this.measureGroup.add(this.makeLabel(`${d.toFixed(3)} m`, pts[0].clone().lerp(pts[1], 0.5)));
          this.onMeasure(`거리: ${d.toFixed(3)} m`);
          this.measurePts = [];
        } else this.onMeasure('두 번째 점을 클릭하세요…');
        break;
      case 'continuous': {
        if (pts.length >= 2) this.drawSegment(pts[pts.length - 2], pts[pts.length - 1]);
        let total = 0;
        for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
        this.onMeasure(pts.length < 2 ? '다음 점…(완료로 종료)' : `누적 ${total.toFixed(3)} m · 완료로 종료`);
        break;
      }
      case 'angle':
        if (pts.length >= 2) this.drawSegment(pts[pts.length - 2], pts[pts.length - 1]);
        if (pts.length === 3) {
          const v1 = pts[0].clone().sub(pts[1]);
          const v2 = pts[2].clone().sub(pts[1]);
          const deg = (v1.angleTo(v2) * 180) / Math.PI;
          this.measureGroup.add(this.makeLabel(`${deg.toFixed(1)}°`, pts[1]));
          this.onMeasure(`각도: ${deg.toFixed(1)}°`);
          this.measurePts = [];
        } else this.onMeasure('세 점(꼭짓점은 두 번째)을 클릭하세요…');
        break;
      case 'area':
        if (pts.length >= 2) this.drawSegment(pts[pts.length - 2], pts[pts.length - 1]);
        this.onMeasure(`점 ${pts.length}개 · 완료로 면적 계산`);
        break;
    }
    this.requestRender();
  }

  /** Small constant-size dot sprite marking a measurement point. */
  private makeMeasureDot(p: THREE.Vector3): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.measureDotTexture(),
        depthTest: false,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    sprite.position.copy(p);
    sprite.scale.set(0.014, 0.014, 1);
    sprite.renderOrder = 1002;
    return sprite;
  }

  private _dotTex?: THREE.CanvasTexture;
  private measureDotTexture(): THREE.CanvasTexture {
    if (this._dotTex) return this._dotTex;
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = '#2563eb';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    this._dotTex = new THREE.CanvasTexture(c);
    return this._dotTex;
  }

  /** A camera-facing, constant on-screen-size text label for measurements. */
  private makeLabel(text: string, pos: THREE.Vector3): THREE.Sprite {
    const dpr = 2;
    const fontPx = 26;
    const padX = 14;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `600 ${fontPx}px sans-serif`;
    const textW = Math.ceil(probe.measureText(text).width);
    const w = textW + padX * 2;
    const h = fontPx + 16;
    const canvas = document.createElement('canvas');
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
    roundRect(ctx, 0, 0, w, h, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }),
    );
    sprite.position.copy(pos);
    const screenH = 0.05; // 화면 높이 대비 일정 비율(거리에 무관하게 일정 크기)
    sprite.scale.set(screenH * (w / h), screenH, 1);
    sprite.renderOrder = 1003;
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
    this.requestRender();
  }

  // --- 단면(클리핑 평면) ------------------------------------------------

  setSection(opts: { enabled?: boolean; axis?: 'x' | 'y' | 'z'; offset?: number; flip?: boolean }) {
    if (opts.enabled !== undefined) this.sectionEnabled = opts.enabled;
    if (opts.axis !== undefined) this.sectionAxis = opts.axis;
    if (opts.offset !== undefined) this.sectionOffset = opts.offset;
    if (opts.flip !== undefined) this.sectionFlip = opts.flip;
    this.applySection();
    this.requestRender();
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
  setIssuePins(
    pins: {
      modelID: number;
      expressID: number;
      color?: number;
      issueId?: string;
      /** label drawn inside the pin (e.g. issue number) */
      label?: string;
      /** unresolved issues gently pulse to draw the eye */
      open?: boolean;
    }[],
  ) {
    this.clearIssuePins();
    if (pins.length === 0) return;

    const group = new THREE.Group();
    const box = new THREE.Box3();
    for (const p of pins) {
      box.makeEmpty();
      for (const mesh of this.meshesFor(p.modelID, p.expressID)) box.expandByObject(mesh);
      if (box.isEmpty()) continue;
      const color = new THREE.Color(p.color ?? 0xdc2626).getStyle();
      const tex = new THREE.CanvasTexture(makePinTexture(color, p.label ?? ''));
      tex.anisotropy = 4;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          depthTest: false,
          // constant on-screen size regardless of distance (Navisworks-style markers)
          sizeAttenuation: false,
          transparent: true,
        }),
      );
      // anchor the teardrop tip (bottom-centre of the canvas) on the element
      sprite.center.set(0.5, 0);
      sprite.position.copy(box.getCenter(new THREE.Vector3()));
      sprite.renderOrder = 998;
      sprite.scale.set(PIN_SIZE * PIN_ASPECT, PIN_SIZE, 1);
      sprite.userData.issueId = p.issueId;
      sprite.userData.pulse = !!p.open;
      group.add(sprite);
    }
    this.issuePinGroup = group;
    this.scene.add(group);
    this.requestRender();
  }

  /** Gently pulse unresolved issue pins (called once per animation frame). */
  private pulseIssuePins() {
    if (!this.issuePinGroup || !this.issuePinGroup.visible) return;
    const f = 1 + 0.14 * Math.sin(performance.now() / 280);
    let pulsed = false;
    for (const child of this.issuePinGroup.children) {
      const s = child as THREE.Sprite;
      if (!s.userData.pulse) continue;
      s.scale.set(PIN_SIZE * PIN_ASPECT * f, PIN_SIZE * f, 1);
      pulsed = true;
    }
    if (pulsed) this.requestRender(); // 펄스 동안 계속 렌더
  }

  setIssuePinsVisible(visible: boolean) {
    if (this.issuePinGroup) this.issuePinGroup.visible = visible;
    this.requestRender();
  }

  clearIssuePins() {
    if (!this.issuePinGroup) return;
    this.scene.remove(this.issuePinGroup);
    this.issuePinGroup.traverse((o) => {
      const m = o as THREE.Mesh & THREE.Sprite;
      m.geometry?.dispose?.();
      const mat = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined;
      mat?.map?.dispose?.();
      mat?.dispose?.();
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
    this.requestRender();
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
    this.requestRender();
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

  /** Frame the camera on every loaded model combined (the "home/start" view). */
  frameAll() {
    const box = new THREE.Box3();
    for (const m of this.models) box.expandByObject(m.group);
    if (!box.isEmpty()) this.frameBox(box);
  }

  private frameBox(box: THREE.Box3, factor = 1.2) {
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
  }

  /**
   * Toggle an R/G/B axes indicator marking the model's coordinate origin
   * (insertion point). We deliberately do NOT use the survey origin (IFC 0,0,0):
   * georeferenced infrastructure models sit hundreds of km from 0,0,0, so an
   * indicator placed there is always off-screen ("작동 안 함"). The model's own
   * origin is at the group's local (0,0,0), which lands right on the geometry and
   * is close to the project base point. Sized to the loaded scene, off by default.
   */
  setOriginVisible(on: boolean) {
    if (!on) {
      if (this.originHelper) this.originHelper.visible = false;
      this.requestRender();
      return;
    }
    const model = this.models[0];
    if (!model) return;
    const box = new THREE.Box3();
    for (const m of this.models) box.expandByObject(m.group);
    const span = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length();
    const size = Math.max(span * 0.08, 1);
    if (!this.originHelper) {
      this.originHelper = new THREE.AxesHelper(1);
      (this.originHelper.material as THREE.Material).depthTest = false;
      this.originHelper.renderOrder = 997;
      this.scene.add(this.originHelper);
    }
    this.originHelper.scale.setScalar(size);
    this.originHelper.position.copy(model.group.localToWorld(new THREE.Vector3(0, 0, 0)));
    this.originHelper.visible = true;
    this.requestRender();
  }

  private handleResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return; // hidden/collapsed — skip to avoid NaN aspect
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.requestRender();
  };

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.stepCameraTween();
    this.pulseIssuePins();
    this.controls.update();
    // On-demand: 마지막 활동(카메라 이동·씬 변경·트윈·핀 펄스) 후 RENDER_GRACE_MS
    // 동안만 실제로 그린다 → 유휴 시 GPU 루프가 멈춰 잔렉/발열이 준다.
    if (performance.now() - this.lastActive < RENDER_GRACE_MS) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  /** Mark the scene dirty so the on-demand loop renders for a short window. */
  requestRender = () => {
    this.lastActive = performance.now();
  };

  /** Advance the camera fly-through one frame (smoothstep easing). */
  private stepCameraTween() {
    const tw = this.cameraTween;
    if (!tw) return;
    this.requestRender(); // 트윈 동안 계속 렌더
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

  /**
   * Remove a loaded model from the scene and free its GPU/wasm resources. Used by
   * version switching (B-2): unload the shown version before loading another.
   */
  unloadModel(modelID: number) {
    const idx = this.models.findIndex((m) => m.modelID === modelID);
    if (idx < 0) return;
    const model = this.models[idx];
    this.scene.remove(model.group);
    const mats = new Set<THREE.Material>();
    model.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => mats.add(x));
      else if (m) mats.add(m);
    });
    mats.forEach((m) => m.dispose());
    model.elementMeshes.clear();
    this.models.splice(idx, 1);
    if (this.models.length === 0) this.sceneOffset = null; // 모두 비면 기준 재설정
    this.spatialTreeCache = undefined;
    this.globalIdCache.delete(modelID);
    this.nameCache.delete(modelID);
    this.categoryCache.delete(modelID);
    this.quantityIndexCache.delete(modelID);
    this.propertyGroupsCache.delete(modelID);
    try {
      this.ifcAPI.CloseModel(modelID);
    } catch {
      /* already closed */
    }
    this.clearHighlight();
  }

  // --- 버전 diff(추가의견1) ----------------------------------------------
  private globalIdCache = new Map<number, Map<number, string>>();
  private diffOverrides: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[]; visible: boolean }[] = [];

  private globalIdMap(modelID: number): Map<number, string> {
    let m = this.globalIdCache.get(modelID);
    if (m) return m;
    m = new Map();
    const model = this.models.find((x) => x.modelID === modelID);
    if (model) {
      for (const eid of model.elementMeshes.keys()) {
        try {
          const line = this.ifcAPI.GetLine(modelID, eid, false) as Record<string, any>;
          const gid = line?.GlobalId?.value as string | undefined;
          if (gid) m.set(eid, gid);
        } catch {
          /* skip */
        }
      }
    }
    this.globalIdCache.set(modelID, m);
    return m;
  }

  /**
   * Colour two loaded versions by IfcRoot GlobalId diff (추가의견1). Colours avoid
   * the issue/clash red·green palette: 신규=청록, 삭제=주황(반투명), 동일=옅은 회색.
   * Opacities are adjustable (`opts`). Originals restored by clearVersionDiff().
   */
  applyVersionDiff(newID: number, oldID: number, opts?: DiffOpts) {
    this.clearVersionDiff();
    const addedOp = opts?.addedOpacity ?? 1;
    const removedOp = opts?.removedOpacity ?? 0.5;
    const sameOp = opts?.sameOpacity ?? 0.35;
    const oldVals = new Set(this.globalIdMap(oldID).values());
    const newVals = new Set(this.globalIdMap(newID).values());
    const override = (mesh: THREE.Mesh, hex: number, opacity: number) => {
      this.diffOverrides.push({ mesh, mat: mesh.material, visible: mesh.visible });
      if (opacity <= 0) {
        mesh.visible = false;
        return;
      }
      mesh.material = new THREE.MeshLambertMaterial({
        color: hex,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
      });
    };
    const newModel = this.models.find((m) => m.modelID === newID);
    const oldModel = this.models.find((m) => m.modelID === oldID);
    const gidN = this.globalIdMap(newID);
    const gidO = this.globalIdMap(oldID);
    if (newModel) {
      for (const [eid, meshes] of newModel.elementMeshes) {
        const gid = gidN.get(eid);
        const added = gid != null && !oldVals.has(gid);
        for (const mesh of meshes) override(mesh, added ? 0x06b6d4 : 0xc2c9d4, added ? addedOp : sameOp);
      }
    }
    if (oldModel) {
      for (const [eid, meshes] of oldModel.elementMeshes) {
        const gid = gidO.get(eid);
        const removed = gid != null && !newVals.has(gid);
        for (const mesh of meshes) override(mesh, 0xf59e0b, removed ? removedOp : 0); // 동일은 숨김
      }
    }
    this.requestRender();
  }

  clearVersionDiff() {
    for (const o of this.diffOverrides) {
      const cur = o.mesh.material;
      if (cur !== o.mat) {
        (Array.isArray(cur) ? cur : [cur]).forEach((m) => (m as THREE.Material).dispose?.());
      }
      o.mesh.material = o.mat;
      o.mesh.visible = o.visible;
    }
    this.diffOverrides = [];
    this.requestRender();
  }

  /**
   * Tint a whole model translucent — used to distinguish an overlaid version
   * (B-2 중첩) from the base model when their geometry is identical. Overrides
   * every mesh material's colour/opacity in place (the overlay has its own fresh
   * material instances from load, so the base model is unaffected).
   */
  setModelTint(modelID: number, hex: number, opacity: number) {
    const model = this.models.find((m) => m.modelID === modelID);
    if (!model) return;
    const color = new THREE.Color(hex);
    model.group.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (mat && 'color' in mat) {
        mat.color.copy(color);
        mat.transparent = true;
        mat.opacity = opacity;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      }
    });
    this.requestRender();
  }

  dispose() {
    this.disposed = true;
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove);
    this.renderer.domElement.removeEventListener('mouseleave', this.handleMouseLeave);
    this.renderer.domElement.removeEventListener('pointerdown', this.requestRender);
    this.renderer.domElement.removeEventListener('wheel', this.requestRender);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * Render a map-style teardrop issue pin to a canvas: status-coloured drop with a
 * white outline and an inner white disc carrying the issue number. Returns the
 * canvas for use as a Sprite texture. Drawn at 2× for crisp edges.
 */
function makePinTexture(color: string, label: string): HTMLCanvasElement {
  const s = 2; // supersample
  const canvas = document.createElement('canvas');
  canvas.width = 64 * s;
  canvas.height = 80 * s;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(s, s);
  const cx = 32;
  const cy = 26;
  const r = 22;
  const tipY = 76;

  // teardrop body
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.quadraticCurveTo(cx - r, cy + r * 0.75, cx - r, cy);
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.quadraticCurveTo(cx + r, cy + r * 0.75, cx, tipY);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // inner disc
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.56, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // number
  if (label) {
    ctx.fillStyle = color;
    ctx.font = `bold ${label.length > 2 ? 18 : 24}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 1);
  }
  return canvas;
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
