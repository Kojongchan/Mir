/**
 * Property-value search over the model index's property shards. Values repeat heavily across objects
 * (same material, family, level…), so entries are kept once in a vocabulary of "label value" strings
 * and each object holds a list of vocabulary ids: a search scans the vocabulary per term, then keeps the
 * objects that have a matching entry for every term.
 */
export type Shard = Record<string, { p: [string, string, unknown, string?][]; x?: string }>;

export class PropSearchIndex {
  private vocab: string[] = [];
  private vocabIds = new Map<string, number>();
  private objects: number[] = [];
  private starts: number[] = [0];
  private entries: number[] = [];

  /** Add one shard (objects must be added once). */
  addShard(shard: Shard): void {
    for (const [key, obj] of Object.entries(shard)) {
      const id = Number(key);
      if (!Number.isSafeInteger(id)) continue;
      const seen = new Set<number>();
      for (const [, label, value, unit] of obj.p) {
        const text = `${label} ${typeof value === 'number' ? value : String(value)}${unit ? ` ${unit}` : ''}`.toLowerCase();
        let v = this.vocabIds.get(text);
        if (v === undefined) { v = this.vocab.length; this.vocab.push(text); this.vocabIds.set(text, v); }
        if (!seen.has(v)) { seen.add(v); this.entries.push(v); }
      }
      if (obj.x) {
        const text = `external id ${obj.x}`.toLowerCase();
        let v = this.vocabIds.get(text);
        if (v === undefined) { v = this.vocab.length; this.vocab.push(text); this.vocabIds.set(text, v); }
        this.entries.push(v);
      }
      this.objects.push(id);
      this.starts.push(this.entries.length);
    }
  }

  get size(): number { return this.objects.length; }

  /** Objects whose properties contain every term (case-insensitive substring of "label value"). */
  search(query: string): number[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hit = terms.map(t => {
      const marks = new Uint8Array(this.vocab.length);
      let any = false;
      for (let v = 0; v < this.vocab.length; v++) if (this.vocab[v].includes(t)) { marks[v] = 1; any = true; }
      return any ? marks : null;
    });
    if (hit.some(m => m === null)) return [];
    const out: number[] = [];
    for (let o = 0; o < this.objects.length; o++) {
      const from = this.starts[o], to = this.starts[o + 1];
      let all = true;
      for (const marks of hit as Uint8Array[]) {
        let found = false;
        for (let i = from; i < to; i++) if (marks[this.entries[i]]) { found = true; break; }
        if (!found) { all = false; break; }
      }
      if (all) out.push(this.objects[o]);
    }
    return out.sort((a, b) => a - b);
  }
}
