import { OUTLINE_RANGE } from './objectState';
import {
  Mesh, NoColorSpace, OrthographicCamera, PlaneGeometry, SRGBColorSpace, Scene, ShaderMaterial, WebGLRenderTarget,
  type Camera, type WebGLRenderer,
} from 'three';

/**
 * Outlines between objects (docs/3D뷰_2차_엔진.md): the scene draws into a target with two colour outputs — the
 * picture and each pixel's object id (objectState.ts ID_OUTPUT; terrain 0, sky the clear colour) — and one full-screen
 * pass copies the picture to the canvas, darkening pixels whose neighbour shows another object. White structures
 * that meet, overlap or stand in front of each other read as separate shapes, at one pixel whatever their size or
 * level of detail, for one extra pass over the screen (no extra geometry). Specks of small parts get none and the lines
 * fade with distance (ui-check run 204: at 400 m every small part on a deck drew a grey dot).
 */
export class OutlinePass {
  private readonly target: WebGLRenderTarget;
  private readonly quad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly screen = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Outline opacity, 0 … 1 (0: plain copy). */
  strength = 0.45;

  constructor(samples: number) {
    this.target = new WebGLRenderTarget(1, 1, { count: 2, samples, depthBuffer: true });
    // Picture in sRGB (8 bit without banding in the darks), ids as raw bytes.
    this.target.textures[0].colorSpace = SRGBColorSpace;
    this.target.textures[1].colorSpace = NoColorSpace;
    this.quad = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: { picture: { value: this.target.textures[0] }, ids: { value: this.target.textures[1] }, strength: { value: this.strength } },
      depthTest: false, depthWrite: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D picture;
        uniform sampler2D ids;
        uniform float strength;
        varying vec2 vUv;
        float differs(vec3 id, ivec2 q, ivec2 size) {
          return step(0.002, distance(id, texelFetch(ids, clamp(q, ivec2(0), size), 0).rgb));
        }
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(ids, 0) - 1;
          vec4 here = texelFetch(ids, p, 0);
          // Neighbours (right, up, left, down) showing another object. A pixel among mostly other objects is a speck
          // of a small part (sub-pixel detail far away): no outline there, or a deck reads as grey noise.
          float n = differs(here.rgb, p + ivec2(1, 0), size) + differs(here.rgb, p + ivec2(0, 1), size)
            + differs(here.rgb, p - ivec2(1, 0), size) + differs(here.rgb, p - ivec2(0, 1), size);
          float edge = step(0.5, n) * step(n, 2.5);
          // Fade from 250 m to 1.2 km (alpha: view distance / ${OUTLINE_RANGE} m).
          float metres = here.a * ${OUTLINE_RANGE}.0;
          edge *= mix(1.0, 0.25, smoothstep(250.0, 1200.0, metres));
          vec4 colour = texture2D(picture, vUv);
          gl_FragColor = vec4(mix(colour.rgb, colour.rgb * 0.35, edge * strength), 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    this.quad.frustumCulled = false;
    this.screen.add(this.quad);
  }

  /** Match the canvas drawing buffer (device pixels). */
  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  /** Draw `scene` with outlines to the canvas; returns the scene pass's draw calls and triangles. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): { calls: number; triangles: number } {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    const counted = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    renderer.setRenderTarget(null);
    this.quad.material.uniforms.strength.value = this.strength;
    renderer.render(this.screen, this.camera);
    return counted;
  }

  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
