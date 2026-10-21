import {
  BoxGeometry, CapsuleGeometry, CylinderGeometry, Group, Mesh, SphereGeometry, type BufferGeometry, type Material, type Object3D,
} from 'three';
import { createFigureMaterial } from './objectState';
import { STATURE } from './walk';

const COLOURS = {
  helmet: 0xffc400, // yellow hard hat
  vest: 0xff7a00, // fluorescent orange safety vest
  band: 0xdcdcdc, // reflective bands
  jacket: 0x34466b, // navy work clothes
  trousers: 0x2b3a55,
  boots: 0x4a3626, // safety boots
  gloves: 0xd9cfb0,
  skin: 0xe2b48c,
  eyes: 0x2a2018,
};

/**
 * The walk-mode figure (user request "보행모드에는 건설 캐릭터 하나 만들어서 움직이게"): a construction worker — yellow
 * hard hat, orange safety vest with reflective bands, navy work clothes, gloves and safety boots — built from simple
 * shapes at STATURE and scaled to the walker's height. It faces −Z with its feet at the origin, and walks, runs and
 * jumps by turning its hips, knees, shoulders and elbows (pose).
 */
export class WorkerFigure {
  readonly group = new Group();
  private readonly body = new Group();
  private readonly joints: Record<'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR', Group>;
  private readonly owned: (BufferGeometry | Material)[] = [];
  /** Step cycle (radians, π a step), standing 0 … walking 1 … running 2, on the ground 0 … in the air 1 (eased). */
  private phase = 0;
  private gait = 0;
  private air = 0;

  constructor() {
    const materials = new Map<number, Material>();
    const material = (colour: number) => {
      let m = materials.get(colour);
      if (!m) { m = createFigureMaterial(colour); materials.set(colour, m); this.owned.push(m); }
      return m;
    };
    const put = (parent: Object3D, geometry: BufferGeometry, colour: number, x: number, y: number, z: number, scale?: [number, number, number]) => {
      this.owned.push(geometry);
      const mesh = new Mesh(geometry, material(colour));
      mesh.position.set(x, y, z);
      if (scale) mesh.scale.set(...scale);
      parent.add(mesh);
      return mesh;
    };
    const joint = (parent: Object3D, x: number, y: number, z = 0) => { const g = new Group(); g.position.set(x, y, z); parent.add(g); return g; };
    this.group.add(this.body);
    const b = this.body;
    // Legs: hip at 0.91 m, knee 0.42 m below it, the boot's sole on the ground.
    const leg = (side: number) => {
      const hip = joint(b, side * 0.095, 0.91);
      put(hip, new CapsuleGeometry(0.075, 0.3, 4, 10), COLOURS.trousers, 0, -0.21, 0);
      const knee = joint(hip, 0, -0.42);
      put(knee, new CapsuleGeometry(0.06, 0.28, 4, 10), COLOURS.trousers, 0, -0.2, 0);
      put(knee, new BoxGeometry(0.12, 0.1, 0.28), COLOURS.boots, 0, -0.44, -0.04);
      return [hip, knee];
    };
    const [hipL, kneeL] = leg(-1), [hipR, kneeR] = leg(1);
    // Trunk: hips, jacket, the vest over it with two reflective bands and shoulder straps, neck, head.
    put(b, new BoxGeometry(0.3, 0.16, 0.2), COLOURS.trousers, 0, 0.93, 0);
    put(b, new CapsuleGeometry(0.18, 0.18, 4, 12), COLOURS.jacket, 0, 1.21, 0, [1, 1, 0.62]);
    put(b, new BoxGeometry(0.385, 0.4, 0.245), COLOURS.vest, 0, 1.2, 0);
    for (const y of [1.08, 1.25]) put(b, new BoxGeometry(0.39, 0.035, 0.25), COLOURS.band, 0, y, 0);
    for (const side of [-1, 1]) put(b, new BoxGeometry(0.075, 0.1, 0.25), COLOURS.vest, side * 0.13, 1.43, 0);
    put(b, new CylinderGeometry(0.05, 0.055, 0.08, 10), COLOURS.skin, 0, 1.5, 0);
    put(b, new SphereGeometry(0.105, 16, 12), COLOURS.skin, 0, 1.615, 0, [0.95, 1.08, 1]);
    for (const side of [-1, 1]) put(b, new SphereGeometry(0.013, 8, 6), COLOURS.eyes, side * 0.037, 1.63, -0.097);
    // Hard hat: dome, rim, front peak and ridge.
    put(b, new SphereGeometry(0.125, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), COLOURS.helmet, 0, 1.645, 0, [1, 0.85, 1.05]);
    put(b, new CylinderGeometry(0.135, 0.135, 0.014, 20), COLOURS.helmet, 0, 1.648, 0);
    put(b, new BoxGeometry(0.17, 0.012, 0.07), COLOURS.helmet, 0, 1.648, -0.16);
    put(b, new BoxGeometry(0.03, 0.025, 0.24), COLOURS.helmet, 0, 1.75, 0);
    // Arms: shoulder at 1.42 m, elbow 0.28 m below, gloved hands.
    const arm = (side: number) => {
      const shoulder = joint(b, side * 0.22, 1.42);
      shoulder.rotation.z = side * 0.06;
      put(shoulder, new CapsuleGeometry(0.05, 0.18, 4, 10), COLOURS.jacket, 0, -0.13, 0);
      const elbow = joint(shoulder, 0, -0.28);
      put(elbow, new CapsuleGeometry(0.045, 0.16, 4, 10), COLOURS.jacket, 0, -0.12, 0);
      put(elbow, new SphereGeometry(0.05, 10, 8), COLOURS.gloves, 0, -0.27, 0, [0.8, 1.1, 0.9]);
      return [shoulder, elbow];
    };
    const [shoulderL, elbowL] = arm(-1), [shoulderR, elbowR] = arm(1);
    this.joints = { hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, elbowL, elbowR };
  }

  /** Still easing its limbs toward the last pose (standing still or landing). */
  get settling(): boolean { return this.gait > 1e-3 || this.air > 1e-3; }

  /** Stand at `feet` facing yaw (radians about +Y; 0 = −Z), `height` m tall. */
  place(feet: { x: number; y: number; z: number }, yaw: number, height: number): void {
    this.group.position.set(feet.x, feet.y, feet.z);
    this.group.rotation.y = yaw;
    this.group.scale.setScalar(height / STATURE);
  }

  /**
   * Animate for `dt` s: `step` m walked this frame (negative: backwards), running or not, in the air or not. Legs and
   * arms swing a step per stride (0.7 m walking, 1 m running at STATURE), the knees bend while a leg swings forward,
   * running leans forward with bent elbows, a jump tucks the legs.
   */
  pose(dt: number, step: number, running: boolean, airborne: boolean): void {
    const scale = this.group.scale.x || 1;
    const target = Math.abs(step) < 1e-5 ? 0 : running ? 2 : 1;
    this.gait += (target - this.gait) * Math.min(1, dt * 8);
    this.air += ((airborne ? 1 : 0) - this.air) * Math.min(1, dt * 10);
    this.phase += (step / ((running ? 1 : 0.7) * scale)) * Math.PI;
    const walk = Math.min(1, this.gait), run = Math.max(0, this.gait - 1), ground = 1 - this.air;
    const s = Math.sin(this.phase), c = Math.cos(this.phase), j = this.joints;
    const legSwing = (0.45 + 0.3 * run) * walk * ground, knee = (0.6 + 0.6 * run) * walk * ground;
    const armSwing = (0.35 + 0.4 * run) * walk * ground;
    j.hipL.rotation.x = legSwing * s + this.air * 0.5;
    j.hipR.rotation.x = -legSwing * s - this.air * 0.15;
    j.kneeL.rotation.x = -(knee * Math.max(0, c) + this.air * 0.9);
    j.kneeR.rotation.x = -(knee * Math.max(0, -c) + this.air * 0.4);
    j.shoulderL.rotation.x = -armSwing * s + this.air * 0.7;
    j.shoulderR.rotation.x = armSwing * s + this.air * 0.7;
    j.elbowL.rotation.x = j.elbowR.rotation.x = 0.15 + 0.2 * walk + 0.9 * run;
    this.body.position.y = 0.025 * walk * ground * Math.abs(s);
    this.body.rotation.x = -0.12 * run;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
