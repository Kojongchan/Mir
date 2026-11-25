/**
 * Property-value search over the model index's property shards. Values repeat heavily across objects
 * (same material, family, level…), so entries are kept once in a vocabulary of "label value" strings
 * and each object holds a list of vocabulary ids: a search scans the vocabulary per term, then keeps the
 * objects that have a matching entry for every term.
 */
export type Shard = Record<string, { p: [string, string, unknown, string?][]; x?: string }>;

export class PropSearchIndex {
  private vocab: string[] = [];
  private vocabIds: Map<string, number> | null = new Map();
  private objects: number[] | Int32Array = [];
  private starts: number[] | Int32Array = [0];
  private entries: number[] | Int32Array = [];

  /** Add one shard (objects must be added once, all before `seal`). */
  addShard(shard: Shard): void {
    const vocabIds = this.vocabIds;
    if (!vocabIds) throw new Error('Index is sealed');
    const entries = this.entries as number[], objects = this.objects as number[], starts = this.starts as number[];
    const entry = (text: string) => {
      let v = vocabIds.get(text);
      if (v === undefined) { v = this.vocab.length; this.vocab.push(text); vocabIds.set(text, v); }
      return v;
    };
    for (const [key, obj] of Object.entries(shard)) {
      const id = Number(key);
      if (!Number.isSafeInteger(id)) continue;
      const seen = new Set<number>();
      for (const [, label, value, unit] of obj.p) {
        const v = entry(`${label} ${typeof value === 'number' ? value : String(value)}${unit ? ` ${unit}` : ''}`.toLowerCase());
        if (!seen.has(v)) { seen.add(v); entries.push(v); }
      }
      if (obj.x) entries.push(entry(`external id ${obj.x}`.toLowerCase()));
      objects.push(id);
      starts.push(entries.length);
    }
  }

  /** After the last shard: drop the build-time lookup and pack the lists (≈12M entries for 250k objects). */
  seal(): void {
    this.vocabIds = null;
    this.objects = Int32Array.from(this.objects);
    this.starts = Int32Array.from(this.starts);
    this.entries = Int32Array.from(this.entries);
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
