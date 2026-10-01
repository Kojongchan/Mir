/** Bounded tile loading. byteLength is encoded size, NOT a GPU-memory measurement. */
export type StreamTile = { id: string; byteLength?: number };
type State = 'idle' | 'loading' | 'loaded' | 'failed';
type Entry<T> = { tile: T; state: State; attempts: number; used: number; controller?: AbortController };
export type StreamStats = { selected: number; total: number; loaded: number; loading: number; failed: number; encodedBytes: number; resident: number };

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
    /** Keep tiles that left the wanted set on screen until a replacement has loaded. Resident bytes may
     * exceed the budget by the in-flight downloads; each completion trims lowest-priority stale tiles. */
    replaceAfterLoad?: boolean;
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
    const budget = this.options.maxEncodedBytes ?? 192 * 1024 * 1024;
    if (bytes > budget) return false;
    const wanted = new Set(this.wanted);
    const replace = !!this.options.replaceAfterLoad;
    let others = this.resident().filter(r => r !== e && (!replace || wanted.has(r))).reduce((sum, r) => sum + this.bytes(r), 0);
    if (!replace) for (const victim of this.evictionOrder(this.resident().filter(r => r !== e && !wanted.has(r)))) {
      if (others + bytes <= budget) break;
      others -= this.bytes(victim);
      this.release(victim);
    }
    if (others + bytes > budget) return false;
    e.tile.byteLength = bytes;
    this.notify();
    return true;
  }
  /** Victims first: not a candidate, then lowest current priority, then least recently wanted. */
  private evictionOrder(entries: Entry<T>[]) {
    const rank = new Map(this.candidates.map((t, i) => [t.id, i]));
    const order = (e: Entry<T>) => rank.get(e.tile.id) ?? Number.MAX_SAFE_INTEGER;
    return [...entries].sort((a, b) => order(b) - order(a) || a.used - b.used);
  }
  /** replaceAfterLoad: bring resident data back within limits by dropping loaded stale tiles only. */
  private trimStale() {
    if (!this.options.replaceAfterLoad) return;
    const wanted = new Set(this.wanted);
    const maxTiles = this.options.maxTiles ?? 24, budget = this.options.maxEncodedBytes ?? 192 * 1024 * 1024;
    // In-flight tiles are not counted: each one trims for itself when it lands (swap, not pre-evict).
    const loaded = this.resident().filter(r => r.state === 'loaded');
    let count = loaded.length, bytes = loaded.reduce((sum, r) => sum + this.bytes(r), 0);
    for (const victim of this.evictionOrder(loaded.filter(r => !wanted.has(r)))) {
      if (count <= maxTiles && bytes <= budget) break;
      count--; bytes -= this.bytes(victim);
      this.release(victim);
    }
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
  /** Camera priority can change without narrowing the fixed region or interrupting a request. */
  prioritize(ids: string[]) {
    if (this.disposed) return;
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.candidates = [...this.candidates].sort((a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
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
  /** Explicit user-selected limits; narrowing releases non-selected resident data immediately. */
  setLimits(limits: { maxTiles: number; maxEncodedBytes: number; concurrency: number }) {
    if (this.disposed) return;
    if (![limits.maxTiles, limits.maxEncodedBytes, limits.concurrency].every(n => n > 0 && !Number.isNaN(n))) throw new Error('invalid stream limits');
    Object.assign(this.options, limits);
    this.plan();
    const wanted = new Set(this.wanted);
    for (const entry of this.resident()) if (!wanted.has(entry)) this.release(entry);
    this.pump();
  }
  /** Stop outstanding work while retaining already loaded geometry. */
  stopLoading() {
    this.paused = true;
    for (const entry of this.resident()) if (entry.state === 'loading') this.release(entry);
    this.notify();
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
      resident: all.filter(e => e.state === 'loaded').length,
    });
  }
  private pump() {
    if (this.disposed) return;
    if (!this.paused) {
      this.plan();
      const wanted = new Set(this.wanted);
      // replaceAfterLoad: stale tiles do not block loads; they are trimmed after each completion.
      const pool = () => this.options.replaceAfterLoad ? this.resident().filter(r => wanted.has(r)) : this.resident();
      for (const e of this.wanted) {
        if (e.state !== 'idle') continue;
        if (this.resident().filter(r => r.state === 'loading').length >= (this.options.concurrency ?? 2)) break;
        const old = this.evictionOrder(this.resident().filter(r => !wanted.has(r)));
        while (!this.options.replaceAfterLoad && (this.resident().length >= (this.options.maxTiles ?? 24) ||
          this.resident().reduce((sum, r) => sum + this.bytes(r), 0) + this.bytes(e) > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024))) {
          const victim = old.shift();
          if (!victim) break;
          this.release(victim);
        }
        if (pool().length >= (this.options.maxTiles ?? 24) ||
          pool().reduce((sum, r) => sum + this.bytes(r), 0) + this.bytes(e) > (this.options.maxEncodedBytes ?? 192 * 1024 * 1024)) continue;
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
          this.trimStale();
          this.pump();
        }, () => {
          if (this.disposed || e.controller !== controller) return;
          this.options.unload(e.tile);
          e.state = 'failed';
          this.trimStale();
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
