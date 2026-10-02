/** Bounded LRU of downloaded tile files (encoded bytes), so a tile unloaded by the memory cap and
 * wanted again skips the network. Parsing still runs; GPU/geometry memory is not cached here. */
export class ByteCache {
  private entries = new Map<string, ArrayBuffer>();
  private bytes = 0;
  constructor(private maxBytes: number) {}
  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: ArrayBuffer) {
    if (value.byteLength > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.byteLength; this.entries.delete(key); }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k); this.bytes -= v.byteLength;
    }
  }
  get size() { return this.bytes; }
  clear() { this.entries.clear(); this.bytes = 0; }
}
