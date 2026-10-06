/** Model tree from the index's tree.json (scripts/meta-index.mjs): parent/name/type per dbId. */
export type TreeData = { v: number; n: number; parent: number[]; name: string[]; type: number[]; types: string[] };

export class ModelTree {
  readonly n: number;
  readonly parent: Int32Array;
  readonly names: string[];
  readonly typeOf: Int32Array;
  readonly types: string[];
  /** Children in CSR form: children of id are childList[childStart[id] .. childStart[id + 1]). */
  private childStart: Int32Array;
  private childList: Int32Array;
  readonly roots: number[];
  private lowered: string[] | null = null;

  constructor(data: TreeData) {
    const n = data.n;
    if (!Number.isSafeInteger(n) || n < 1 || data.parent.length !== n || data.name.length !== n) throw new Error('Invalid model tree');
    this.n = n;
    this.parent = Int32Array.from(data.parent, p => (p > 0 && p < n ? p : 0));
    // Break any parent cycle (including self-parents) so walks and subtrees always terminate.
    const state = new Uint8Array(n); // 0 unvisited, 1 on current walk, 2 done
    for (let id = 1; id < n; id++) {
      const walk: number[] = [];
      let cur = id;
      while (cur > 0 && state[cur] === 0) { state[cur] = 1; walk.push(cur); cur = this.parent[cur]; }
      if (cur > 0 && state[cur] === 1) this.parent[walk[walk.length - 1]] = 0;
      for (const w of walk) state[w] = 2;
    }
    this.names = data.name;
    this.typeOf = Int32Array.from(data.type ?? new Array(n).fill(0));
    this.types = data.types ?? [''];
    const counts = new Int32Array(n + 1);
    for (let id = 1; id < n; id++) counts[this.parent[id]]++;
    this.childStart = new Int32Array(n + 1);
    for (let id = 0; id < n; id++) this.childStart[id + 1] = this.childStart[id] + counts[id];
    this.childList = new Int32Array(this.childStart[n]);
    const fill = this.childStart.slice(0, n);
    for (let id = 1; id < n; id++) this.childList[fill[this.parent[id]]++] = id;
    this.roots = Array.from(this.children(0));
  }

  children(id: number): Int32Array {
    return this.childList.subarray(this.childStart[id], this.childStart[id + 1]);
  }

  childCount(id: number): number {
    return this.childStart[id + 1] - this.childStart[id];
  }

  name(id: number): string {
    return this.names[id] || `#${id}`;
  }

  type(id: number): string {
    return this.types[this.typeOf[id]] ?? '';
  }

  /** Root-to-object chain (excluding the virtual root 0). */
  path(id: number): number[] {
    const out: number[] = [];
    for (let cur = id, guard = 0; cur > 0 && guard < this.n; cur = this.parent[cur], guard++) out.push(cur);
    return out.reverse();
  }

  /** The object and everything below it. */
  subtree(id: number): number[] {
    const out: number[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      const kids = this.children(cur);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  /** Case-insensitive match on name or type; every term must match. Returns all matches in tree order. */
  search(query: string, limit = Number.POSITIVE_INFINITY): { total: number; ids: number[] } {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { total: 0, ids: [] };
    this.lowered ??= this.names.map(s => (s || '').toLowerCase());
    const typeLower = this.types.map(t => t.toLowerCase());
    const ids: number[] = [];
    let total = 0;
    for (let id = 1; id < this.n; id++) {
      const name = this.lowered[id], type = typeLower[this.typeOf[id]];
      if (terms.every(t => name.includes(t) || type.includes(t))) {
        total++;
        if (ids.length < limit) ids.push(id);
      }
    }
    return { total, ids };
  }
}
