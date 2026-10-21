import { DataTexture, MeshLambertMaterial, RGBAFormat, ShaderMaterial, UnsignedByteType, NearestFilter, DoubleSide, type Material, type Texture } from 'three';

/**
 * Per-object display state read by the shaders (second viewer, docs/3D뷰_2차_엔진.md). Every vertex carries its
 * object's dbId (_FEATURE_ID_0), so one texel per dbId recolours or hides the object in every level and in tiles
 * that load later — no extra draw pass (the xeokit emphasis pass z-fought) and no per-tile bookkeeping.
 * Texel: rgb = colour, a = 255 colourize (colour mode) · 254 selected · 253 highlighted · 1 hidden · 0 as modelled.
 */
const WIDTH = 1024;
export const SELECT_RGB = [38, 128, 255];
export const HIGHLIGHT_RGB = [255, 158, 20];

export class ObjectStateTexture {
  readonly texture: DataTexture;
  private data: Uint8Array<ArrayBuffer>;
  readonly capacity: number;
  /** Colour per object under the states (colour modes): rgba per dbId, a = 255 painted; null = as modelled. */
  private paint: Uint8Array | null = null;
  private last: { selected: number[]; highlighted: number[]; hidden: number[] } = { selected: [], highlighted: [], hidden: [] };

  constructor(objects: number) {
    const rows = Math.max(1, Math.ceil(Math.max(objects, 1) / WIDTH));
    this.capacity = rows * WIDTH;
    this.data = new Uint8Array(this.capacity * 4);
    this.texture = new DataTexture(this.data, WIDTH, rows, RGBAFormat, UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Colour per object (rgba per dbId, a = 255 painted) under selection, highlight and hiding; null = as modelled. */
  setPaint(paint: Uint8Array | null): void {
    this.paint = paint;
    this.apply(this.last.selected, this.last.highlighted, this.last.hidden);
  }

  /** Whether an object is hidden (walk mode passes through it). */
  isHidden(id: number): boolean {
    return id > 0 && id < this.capacity && this.data[id * 4 + 3] === 1;
  }

  /** Recompute every texel from the sets (precedence: hidden > selected > highlighted > paint). */
  apply(selected: Iterable<number>, highlighted: Iterable<number>, hidden: Iterable<number>): void {
    this.last = { selected: [...selected], highlighted: [...highlighted], hidden: [...hidden] };
    this.data.fill(0);
    if (this.paint) this.data.set(this.paint.subarray(0, Math.min(this.paint.length, this.data.length)));
    const put = (id: number, rgb: number[], a: number) => {
      if (!(id > 0 && id < this.capacity)) return;
      this.data.set([rgb[0], rgb[1], rgb[2], a], id * 4);
    };
    for (const id of this.last.highlighted) put(id, HIGHLIGHT_RGB, 253);
    for (const id of this.last.selected) put(id, SELECT_RGB, 254);
    for (const id of this.last.hidden) put(id, [0, 0, 0], 1);
    this.texture.needsUpdate = true;
  }
}

const STATE_VERTEX = /* glsl */`
attribute float _feature_id_0;
uniform highp sampler2D objectState;
varying vec4 vObjectState;
vec4 readObjectState() {
  int id = int(_feature_id_0 + 0.5);
  return texelFetch(objectState, ivec2(id % ${WIDTH}, id / ${WIDTH}), 0);
}
`;
/**
 * Depth order for faces of different objects in one plane. The model has duplicates (two #인버트 - 27Mpa in tile 949:
 * the same 7,190 triangles) and touching parts drawn as one plane with different triangles (asphalt over a road solid,
 * steel plates on a slab), and with the source's exact coordinates the nearer face changed triangle by triangle or
 * pixel by pixel: mottled patches, outlined. Each object is drawn nearer by its rank (1–31 by id, 32 highlighted, 33
 * selected) × (1.5e-7 in the logarithmic depth + 0.01 of the depth change across a pixel). The constant part separates
 * identical faces (2.5 steps of a 24-bit buffer); the slope part, as a polygon offset does, the interpolation error of
 * differently triangulated ones, which grows at grazing angles. At most 33 × (1.5e-7 + 0.01 px): about 6.5e-5 of the
 * distance and a third of a pixel's depth slope, so only faces closer than that can swap (a selected face 1 cm under a
 * cover seen at 30 m and 25°, both within one pixel). Selected and highlighted objects win over any (a selected piece
 * never shows its twin through it); the terrain (id 0) keeps its depth, so modelled ground wins over the photo.
 * Headless check (SwiftShader, identical and differently triangulated overlaps at 30–1,000 m, MSAA, a gap of 3 cm):
 * one object wins everywhere but a few edge pixels, and the face 3 cm above stays on top. 0.005 per pixel left patches.
 */
const DEPTH_ORDER = /* glsl */`
float mirDepthRank(int id, float state) {
  if (id <= 0) return 0.0;
  if (abs(state - 254.0 / 255.0) < 0.5 / 255.0) return 33.0;
  if (abs(state - 253.0 / 255.0) < 0.5 / 255.0) return 32.0;
  return float(1 + id % 31);
}
`;
const APPLY_DEPTH_ORDER = (id: string) => /* glsl */`
#include <logdepthbuf_fragment>
#if defined( USE_LOGDEPTHBUF )
  {
    float depth = gl_FragDepth;
    gl_FragDepth = max(0.0, depth - mirDepthRank(${id}, vObjectState.a) * (1.5e-7 + 0.01 * fwidth(depth)));
  }
#endif
`;
const HIDE = /* glsl */`
  if (vObjectState.a > 0.0 && vObjectState.a < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // hidden: degenerate
`;

/**
 * Second colour output (location 1) for outlines (outline.ts): the object's dbId, 24 bit RGB as in picking (0 = no
 * object: terrain), and in alpha the view distance over OUTLINE_RANGE metres (outlines fade with distance). Ignored
 * when drawing to a target without that attachment (picking, the plain canvas). The distance has its own varying: this
 * code goes before the material's own declarations (vViewPosition is declared after it).
 */
export const OUTLINE_RANGE = 2000;
const ID_VARYINGS = 'flat varying int vOutlineId;\nvarying float vOutlineDepth;\n';
export const ID_OUTPUT = /* glsl */`
layout(location = 1) out highp vec4 mirOutlineId;
${ID_VARYINGS}
void writeOutlineId(int id) {
  mirOutlineId = vec4(float((id >> 16) & 255) / 255.0, float((id >> 8) & 255) / 255.0, float(id & 255) / 255.0,
    clamp(vOutlineDepth / ${OUTLINE_RANGE}.0, 0.0, 1.0));
}
`;
/** Vertex side of ID_OUTPUT: the id (an expression) after begin_vertex, the view distance after project_vertex. */
function withIdVaryings(vertexShader: string, id: string): string {
  return ID_VARYINGS + vertexShader
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n  vOutlineId = ${id};`)
    .replace('#include <project_vertex>', '#include <project_vertex>\n  vOutlineDepth = -mvPosition.z;');
}

/** Terrain (aerial photo) material with the outline id output (0: terrain is one surface). */
export function createTerrainMaterial(photo: Texture | null): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ map: photo, side: DoubleSide });
  material.onBeforeCompile = shader => {
    shader.vertexShader = withIdVaryings(shader.vertexShader, '0');
    shader.fragmentShader = ID_OUTPUT + shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  writeOutlineId(0);');
  };
  material.customProgramCacheKey = () => 'mir-terrain';
  return material;
}

/** Outline id of the walk-mode figure (no object has it): it reads as one shape against everything else. */
export const FIGURE_ID = 0xfffffe;

/** Material of the walk-mode figure (avatar.ts): a lit colour, outlined as one shape. */
export function createFigureMaterial(color: number): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color });
  material.onBeforeCompile = shader => {
    shader.vertexShader = withIdVaryings(shader.vertexShader, String(FIGURE_ID));
    shader.fragmentShader = ID_OUTPUT + shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  writeOutlineId(vOutlineId);');
  };
  material.customProgramCacheKey = () => 'mir-figure';
  return material;
}

/**
 * Shared surface material: vertex colours, flat shading (the tiles carry no normals), Lambert lighting (cheap on
 * mobile), object-state recolour/hide. One instance for opaque and one for transparent content.
 */
export function createSurfaceMaterial(state: ObjectStateTexture, transparent: boolean): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide, transparent, depthWrite: !transparent });
  material.onBeforeCompile = shader => {
    shader.uniforms.objectState = { value: state.texture };
    shader.vertexShader = STATE_VERTEX + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vObjectState = readObjectState();')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${HIDE}`);
    shader.vertexShader = withIdVaryings(shader.vertexShader, 'int(_feature_id_0 + 0.5)');
    shader.fragmentShader = 'varying vec4 vObjectState;\n' + ID_OUTPUT + DEPTH_ORDER + shader.fragmentShader
      .replace('#include <logdepthbuf_fragment>', APPLY_DEPTH_ORDER('vOutlineId'))
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vObjectState.rgb, step(0.5, vObjectState.a));')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  writeOutlineId(vOutlineId);');
  };
  material.customProgramCacheKey = () => `mir-surface-${transparent}`;
  return material;
}

/**
 * Picking: pass 0 writes the dbId (24 bit RGB, 0 = none), pass 1 the view depth / far packed in RGBA.
 * Hidden objects are skipped like in the surface material.
 */
export function createPickMaterial(state: ObjectStateTexture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { objectState: { value: state.texture }, mode: { value: 0 }, far: { value: 1e6 } },
    side: DoubleSide,
    // The logarithmic depth chunks (no-ops without a log depth buffer) keep the nearest surface the one drawn on screen.
    vertexShader: STATE_VERTEX + /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vDepth;
      flat varying int vId;
      void main() {
        vObjectState = readObjectState();
        vId = int(_feature_id_0 + 0.5);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
        ${HIDE}
      }`,
    // The same depth order as the surfaces, so a click picks the face that is drawn.
    fragmentShader: /* glsl */`
      #include <packing>
      #include <logdepthbuf_pars_fragment>
      uniform int mode;
      uniform float far;
      varying float vDepth;
      varying vec4 vObjectState;
      flat varying int vId;
      ${DEPTH_ORDER}
      void main() {
        ${APPLY_DEPTH_ORDER('vId')}
        if (mode == 0) gl_FragColor = vec4(float((vId >> 16) & 255) / 255.0, float((vId >> 8) & 255) / 255.0, float(vId & 255) / 255.0, 1.0);
        else gl_FragColor = packDepthToRGBA(clamp(vDepth / far, 0.0, 0.999999));
      }`,
  });
}

export type SurfaceMaterials = { opaque: Material; transparent: Material };
