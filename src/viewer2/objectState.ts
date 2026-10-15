import { DataTexture, MeshLambertMaterial, RGBAFormat, ShaderMaterial, UnsignedByteType, NearestFilter, DoubleSide, type Material, type Texture } from 'three';

/**
 * Per-object display state read by the shaders (second viewer, docs/3D뷰_2차_엔진.md). Every vertex carries its
 * object's dbId (_FEATURE_ID_0), so one texel per dbId recolours or hides the object in every level and in tiles
 * that load later — no extra draw pass (the xeokit emphasis pass z-fought) and no per-tile bookkeeping.
 * Texel: rgb = colour, a = 255 colourize (selection, highlight, colour mode) · 1 hidden · 0 as modelled.
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

  /** Recompute every texel from the sets (precedence: hidden > selected > highlighted > paint). */
  apply(selected: Iterable<number>, highlighted: Iterable<number>, hidden: Iterable<number>): void {
    this.last = { selected: [...selected], highlighted: [...highlighted], hidden: [...hidden] };
    this.data.fill(0);
    if (this.paint) this.data.set(this.paint.subarray(0, Math.min(this.paint.length, this.data.length)));
    const put = (id: number, rgb: number[], a: number) => {
      if (!(id > 0 && id < this.capacity)) return;
      this.data.set([rgb[0], rgb[1], rgb[2], a], id * 4);
    };
    for (const id of this.last.highlighted) put(id, HIGHLIGHT_RGB, 255);
    for (const id of this.last.selected) put(id, SELECT_RGB, 255);
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
const HIDE = /* glsl */`
  if (vObjectState.a > 0.0 && vObjectState.a < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // hidden: degenerate
`;

/**
 * Second colour output (location 1) for outlines (outline.ts): the object's dbId, 24 bit RGB as in picking (0 = no
 * object: terrain). Ignored when drawing to a target without that attachment (picking, the plain canvas).
 */
export const ID_OUTPUT = /* glsl */`
layout(location = 1) out highp vec4 mirOutlineId;
flat varying int vOutlineId;
void writeOutlineId(int id) {
  mirOutlineId = vec4(float((id >> 16) & 255) / 255.0, float((id >> 8) & 255) / 255.0, float(id & 255) / 255.0, 1.0);
}
`;

/** Terrain (aerial photo) material with the outline id output (0: terrain is one surface). */
export function createTerrainMaterial(photo: Texture | null): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ map: photo, side: DoubleSide });
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'flat varying int vOutlineId;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vOutlineId = 0;');
    shader.fragmentShader = ID_OUTPUT + shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  writeOutlineId(0);');
  };
  material.customProgramCacheKey = () => 'mir-terrain';
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
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vOutlineId = int(_feature_id_0 + 0.5);');
    shader.vertexShader = 'flat varying int vOutlineId;\n' + shader.vertexShader;
    shader.fragmentShader = 'varying vec4 vObjectState;\n' + ID_OUTPUT + shader.fragmentShader
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
    fragmentShader: /* glsl */`
      #include <packing>
      #include <logdepthbuf_pars_fragment>
      uniform int mode;
      uniform float far;
      varying float vDepth;
      flat varying int vId;
      void main() {
        #include <logdepthbuf_fragment>
        if (mode == 0) gl_FragColor = vec4(float((vId >> 16) & 255) / 255.0, float((vId >> 8) & 255) / 255.0, float(vId & 255) / 255.0, 1.0);
        else gl_FragColor = packDepthToRGBA(clamp(vDepth / far, 0.0, 0.999999));
      }`,
  });
}

export type SurfaceMaterials = { opaque: Material; transparent: Material };
