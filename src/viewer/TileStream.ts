/** Bounded tile loading. byteLength is encoded size, NOT a GPU-memory measurement. */
export type StreamTile = { id: string; byteLength?: number };
type State = 'idle' | 'loading' | 'loaded' | 'failed';
type Entry<T> = { tile: T; state: State; attempts: number; used: number; controller?: AbortController };
export type StreamStats = { selected: number; total: number; loaded: number; loading: number; failed: number; encodedBytes: number };

export class TileStream<T extends StreamTile> {
  private entries = new Map<string, Entry<T>>();
  private wanted: Entry<T>[] = [];
  private candidates: T[] = [];
  private total = 0;
  private clock = 0;
  private paused = false;
  private disposed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: {
    load: (tile: T, signal: AbortSignal) => Promise<void>;
    unload: (tile: T) => void;
    onChange: (stats: StreamStats) => void;
    concurrency?: number;
    maxTiles?: number;
    maxEncodedBytes?: number;
    fallbackBytes?: number;
    retryMs?: number;
    loadTimeoutMs?: number;
  }) {}

  private bytes(e: Entry<T>) {
    const n = e.tile.byteLength;
    return n && Number.isFinite(n) && n > 0 ? n : (this.options.fallbackBytes ?? 16 * 1024 * 1024);
  }
  private resident() { return [...this.entries.values()].filter(e => e.state === 'loaded' || e.state === 'loading'); }
  /** Reconcile old manifests' estimates with observed network bytes before creating GPU resources. */
  accountBytes(id: string, bytes: number): boolean {
    const e = this.entries.get(id);
    if (this.disposed || !e || e.state !== 'loading' || !Number.isFinite(bytes) || bytes <= 0) return false;
    const others = this.resident().filter(r => r !== e).reduce((sum, r) => sum + this.bytes(r), 0);
    if (others + bytes > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024)) return false;
    e.tile.byteLength = bytes;
    this.notify();
    return true;
  }
  private release(e: Entry<T>) {
    e.controller?.abort();
    e.controller = undefined;
    this.options.unload(e.tile);
    e.state = 'idle';
  }
  /** Sorted candidates. Keep the budget explicit instead of promising full-scene completion. */
  select(tiles: T[]) {
    if (this.disposed) return;
    this.candidates = tiles;
    this.total = tiles.length;
    this.plan();
    this.pump();
  }
  /** Revisit the full candidate list when estimates become measured file sizes. */
  private plan() {
    this.wanted = [];
    let bytes = 0;
    const seen = new Set<string>();
    for (const tile of this.candidates) {
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      let e = this.entries.get(tile.id);
      if (!e) { e = { tile, state: 'idle', attempts: 0, used: 0 }; this.entries.set(tile.id, e); }
      if (this.wanted.length >= (this.options.maxTiles ?? 24)) break;
      if (bytes + this.bytes(e) > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024)) continue;
      bytes += this.bytes(e);
      e.used = ++this.clock;
      this.wanted.push(e);
    }
    const wanted = new Set(this.wanted);
    for (const e of this.entries.values()) {
      if (e.state === 'loading' && !wanted.has(e)) this.release(e);
    }
  }
  setPaused(paused: boolean) {
    if (this.disposed) return;
    this.paused = paused;
    if (!paused) this.pump();
  }
  private notify() {
    if (this.disposed) return;
    const all = this.resident();
    this.options.onChange({
      selected: this.wanted.length, total: this.total,
      loaded: this.wanted.filter(e => e.state === 'loaded').length,
      loading: all.filter(e => e.state === 'loading').length,
      failed: this.wanted.filter(e => e.state === 'failed').length,
      encodedBytes: all.reduce((sum, e) => sum + this.bytes(e), 0),
    });
  }
  private pump() {
    if (this.disposed) return;
    if (!this.paused) {
      this.plan();
      for (const e of this.wanted) {
        if (this.resident().filter(r => r.state === 'loading').length >= (this.options.concurrency ?? 2)) break;
        if (e.state !== 'idle') continue;
        const wanted = new Set(this.wanted);
        const old = this.resident().filter(r => !wanted.has(r)).sort((a, b) => a.used - b.used);
        while (this.resident().length >= (this.options.maxTiles ?? 24) ||
          this.resident().reduce((sum, r) => sum + this.bytes(r), 0) + this.bytes(e) > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024)) {
          const victim = old.shift();
          if (!victim) break;
          this.release(victim);
        }
        if (this.resident().length >= (this.options.maxTiles ?? 24) ||
          this.resident().reduce((sum, r) => sum + this.bytes(r), 0) + this.bytes(e) > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024)) continue;
        const controller = new AbortController();
        e.controller = controller;
        e.state = 'loading';
        e.attempts++;
        // Timeout covers the network phase as well as parsing; an offline request cannot hold a slot forever.
        const timeout = setTimeout(() => controller.abort(), this.options.loadTimeoutMs ?? 60_000);
        let onAbort: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('tile request aborted or timed out'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const work = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('cancelled');
          return this.options.load(e.tile, controller.signal);
        });
        void Promise.race([work, aborted]).finally(() => {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', onAbort);
        }).then(() => {
          if (this.disposed || e.controller !== controller) return;
          e.state = 'loaded';
          e.attempts = 0;
          this.pump();
        }, () => {
          if (this.disposed || e.controller !== controller) return;
          this.options.unload(e.tile);
          e.state = 'failed';
          // One delayed retry; persistent failures never produce an endless request loop.
          if (e.attempts < 2 && !this.retryTimer) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = undefined;
              if (this.disposed) return;
              for (const f of this.wanted) if (f.state === 'failed' && f.attempts < 2) f.state = 'idle';
              this.pump();
            }, this.options.retryMs ?? 1500);
          }
          this.pump();
        });
      }
    }
    this.notify();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    for (const e of this.entries.values()) if (e.state === 'loaded' || e.state === 'loading') this.release(e);
    this.entries.clear();
    this.wanted = [];
    this.candidates = [];
  }
}
