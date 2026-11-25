/** Navigation quality controlled by inactivity, never by the previous frame's duration. */
export class NavigationQuality {
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private held = false;
  private disposed = false;
  constructor(private options: { enter: () => void; leave: () => void; delayMs?: number }) {}
  moved() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    if (!this.active) { this.active = true; this.options.enter(); }
    if (!this.held) this.timer = setTimeout(() => {
      if (this.disposed || this.held) return;
      this.active = false;
      this.options.leave();
    }, this.options.delayMs ?? 350);
  }
  hold(value: boolean) {
    if (this.disposed) return;
    if (this.held === value) return;
    this.held = value;
    this.moved();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    if (this.active) this.options.leave();
    this.active = false;
  }
}
