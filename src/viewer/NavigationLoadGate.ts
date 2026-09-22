/** Delay expensive GPU/model work during navigation; downloads may finish normally. */
export class NavigationLoadGate {
  private paused = false;
  private disposed = false;
  private waiters = new Set<() => void>();
  setPaused(value: boolean) {
    this.paused = value;
    if (!value) for (const finish of [...this.waiters]) finish();
  }
  wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) return Promise.reject(new Error('cancelled'));
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.waiters.delete(finish);
        signal.removeEventListener('abort', finish);
        if (signal.aborted || this.disposed) reject(new Error('cancelled'));
        else resolve();
      };
      this.waiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  dispose() {
    this.disposed = true;
    for (const finish of [...this.waiters]) finish();
  }
}
