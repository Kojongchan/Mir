/** Reduce raster work without changing model visibility or geometry. */
export class NavigationResolution {
  private active = false;
  private scale = 0.5;
  private samples: number[] = [];
  constructor(private apply: (scale: number) => void) {}
  begin() { this.active = true; this.samples = []; this.apply(this.scale); }
  sample(ms: number) {
    if (!this.active || !Number.isFinite(ms) || ms <= 0) return;
    this.samples.push(ms);
    if (this.samples.length < 8) return;
    const average = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples = [];
    // Monotonic within a drag: no oscillating resolution during sustained overload.
    if (average > 40 && this.scale > 0.25) {
      this.scale = Math.max(0.25, this.scale - 0.1);
      this.apply(this.scale);
    }
  }
  end() { this.active = false; this.samples = []; this.apply(1); }
}
