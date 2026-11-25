/** Downloads may overlap; model parsing/GPU construction enters one at a time.
 * Lower priority numbers enter first (FIFO within a priority), e.g. the whole-site far level ahead of detail. */
export class ModelLoadQueue {
  private busy = false;
  private disposed = false;
  private pending: Array<{ signal: AbortSignal; priority: number; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }> = [];

  acquire(signal: AbortSignal, priority = 1): Promise<() => void> {
    if (signal.aborted || this.disposed) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const entry = { signal, priority, resolve, reject, abort: () => {
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        signal.removeEventListener('abort', entry.abort);
        reject(new Error('cancelled'));
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      const at = this.pending.findIndex(p => p.priority > priority);
      if (at === -1) this.pending.push(entry); else this.pending.splice(at, 0, entry);
      this.pump();
    });
  }

  private pump() {
    if (this.busy || this.disposed) return;
    const entry = this.pending.shift();
    if (!entry) return;
    entry.signal.removeEventListener('abort', entry.abort);
    this.busy = true;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      this.busy = false;
      this.pump();
    });
  }

  dispose() {
    this.disposed = true;
    for (const entry of [...this.pending]) entry.abort();
  }
}
