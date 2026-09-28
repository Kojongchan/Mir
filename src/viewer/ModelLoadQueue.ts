/** Downloads may overlap; model parsing/GPU construction enters one at a time. */
export class ModelLoadQueue {
  private busy = false;
  private disposed = false;
  private pending: Array<{ signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }> = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted || this.disposed) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        signal.removeEventListener('abort', entry.abort);
        reject(new Error('cancelled'));
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.pending.push(entry);
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
