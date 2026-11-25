/**
 * Original object (SVF dbId) ↔ scene entities. Tiles load with globalizeObjectIds, so one design object
 * appears as `tile12#345` (light/original), `tile12-far#345` and `tile12-detail#345`, and an object that
 * spans tiles appears once per tile. Selection, search highlights and visibility act on the dbId so every
 * representation that is (or later becomes) loaded follows.
 *
 * Geometry without a dbId gets a converter-generated name (`entity-117`) that is only unique inside its
 * tile, and unrelated objects in other tiles reuse it; those are keyed per tile (`tile12#entity-117`) so
 * only that tile's own representations follow.
 */
const TILE_ENTITY = /^(tile\d+)(?:-far|-detail)?#(.+)$/;

/** dbId of a tile entity (or its per-tile key when it has none); null for terrain/base models and others. */
export function objectIdOf(entityId: string): string | null {
  const m = TILE_ENTITY.exec(entityId);
  if (!m) return null;
  return /^\d+$/.test(m[2]) ? m[2] : `${m[1]}#${m[2]}`;
}

/** Renamed-fragment table (scripts/build-entity-alias.mjs): per tile index, its entity count and [N, dbId, …]. */
export type AliasTable = { v: number; tiles: Record<string, { n: number; a: number[] }> };

export class ObjectIndex {
  private byObject = new Map<string, Set<string>>();
  private keyOfEntity = new Map<string, string>();
  private aliases = new Map<string, string>();      // `tile12#entity-117` → '345'
  private aliasCounts = new Map<string, number>();  // `tile12` → entity count of the file the table describes
  private mismatched = new Set<string>();           // tiles whose loaded file is not the one the table describes
  private loadedCounts = new Map<string, Set<number>>(); // entity counts of the files loaded per tile

  /** Object key of a tile entity: its dbId, its owner's dbId for a renamed fragment, else a per-tile key. */
  keyOf(entityId: string): string | null {
    const m = TILE_ENTITY.exec(entityId);
    if (!m) return null;
    if (/^\d+$/.test(m[2])) return m[2];
    const local = `${m[1]}#${m[2]}`;
    return (!this.mismatched.has(m[1]) && this.aliases.get(local)) || local;
  }

  /** Register one loaded model's entity ids; returns the ids whose object changed because the table was rejected. */
  add(entityIds: Iterable<string>): string[] {
    const ids = [...entityIds];
    // Every representation of a tile keeps the source file's entities: another count is another conversion.
    const tile = ids.length ? TILE_ENTITY.exec(ids[0])?.[1] : undefined;
    let changed: string[] = [];
    if (tile) {
      const counts = this.loadedCounts.get(tile) ?? new Set();
      this.loadedCounts.set(tile, counts.add(ids.length));
      if (this.aliasCounts.has(tile) && this.aliasCounts.get(tile) !== ids.length && !this.mismatched.has(tile)) {
        this.mismatched.add(tile);
        changed = this.rekey();
      }
    }
    for (const id of ids) {
      const key = this.keyOf(id);
      if (key !== null) this.link(id, key);
    }
    return changed;
  }

  remove(entityIds: Iterable<string>): void {
    for (const id of entityIds) {
      const key = this.keyOfEntity.get(id);
      if (key === undefined) continue;
      this.keyOfEntity.delete(id);
      const set = this.byObject.get(key);
      if (!set) continue;
      set.delete(id);
      if (!set.size) this.byObject.delete(key);
    }
  }

  /** Install the renamed-fragment table; returns the loaded entity ids that now belong to another object. */
  setAliases(table: AliasTable | null): string[] {
    this.aliases.clear(); this.aliasCounts.clear(); this.mismatched.clear();
    for (const [index, { n, a }] of Object.entries(table?.tiles ?? {})) {
      if (!/^\d+$/.test(index) || !Array.isArray(a)) continue;
      const tile = `tile${index}`;
      this.aliasCounts.set(tile, n);
      if ([...this.loadedCounts.get(tile) ?? []].some(c => c !== n)) this.mismatched.add(tile);
      for (let i = 0; i + 1 < a.length; i += 2) this.aliases.set(`${tile}#entity-${a[i]}`, String(a[i + 1]));
    }
    return this.rekey();
  }

  entities(dbId: string): Iterable<string> {
    return this.byObject.get(dbId) ?? [];
  }

  has(dbId: string): boolean {
    return this.byObject.has(dbId);
  }

  clear(): void {
    this.byObject.clear();
    this.keyOfEntity.clear();
    this.loadedCounts.clear();
    this.setAliases(null);
  }

  private link(id: string, key: string): void {
    this.keyOfEntity.set(id, key);
    let set = this.byObject.get(key);
    if (!set) { set = new Set(); this.byObject.set(key, set); }
    set.add(id);
  }

  private rekey(): string[] {
    const changed: string[] = [];
    for (const [id, key] of [...this.keyOfEntity]) {
      const next = this.keyOf(id);
      if (next === null || next === key) continue;
      this.remove([id]);
      this.link(id, next);
      changed.push(id);
    }
    return changed;
  }
}

/** Object sets driving entity state: selected = clicked (blue), highlighted = search hits (amber), hidden = tree. */
export type ObjectStates = { selected: ReadonlySet<string>; highlighted: ReadonlySet<string>; hidden: ReadonlySet<string> };
type Paintable = { colorize: number[] | null; visible: boolean };

// Selection recolours the object instead of drawing xeokit's emphasis pass over it: that second pass
// z-fights with the surface under the logarithmic depth buffer and showed as scattered blue specks.
// SceneModel colorize replaces the colour (lighting kept) and `null` restores the original.
export const SELECT_COLOR = [0.15, 0.5, 1.0];
export const HIGHLIGHT_COLOR = [1.0, 0.62, 0.08];

function colorFor(db: string, states: ObjectStates): number[] | null {
  return states.selected.has(db) ? SELECT_COLOR : states.highlighted.has(db) ? HIGHLIGHT_COLOR : null;
}

/**
 * Apply the object sets to a newly loaded model's entities (only what differs from a fresh entity), or, with
 * `ids`, fully to entities that now belong to another object.
 */
export function applyStates(index: ObjectIndex, objects: Record<string, Paintable | undefined>, states: ObjectStates,
  ids?: Iterable<string>): void {
  for (const id of ids ?? Object.keys(objects)) {
    const entity = objects[id], db = index.keyOf(id);
    if (!entity || db === null) continue;
    const color = colorFor(db, states), hidden = states.hidden.has(db);
    if (ids) { entity.colorize = color; entity.visible = !hidden; continue; }
    if (color) entity.colorize = color;
    if (hidden) entity.visible = false;
  }
}

/** After `states[flag]` changed from `previous`, update only the entities of objects that changed. */
export function updateFlag(
  index: ObjectIndex,
  objects: Record<string, Paintable | undefined>,
  flag: 'selected' | 'highlighted' | 'hidden',
  previous: ReadonlySet<string>,
  states: ObjectStates,
): void {
  const next = states[flag];
  const touch = (db: string) => {
    const color = colorFor(db, states), hidden = states.hidden.has(db);
    for (const id of index.entities(db)) {
      const entity = objects[id];
      if (!entity) continue;
      if (flag === 'hidden') entity.visible = !hidden;
      else entity.colorize = color;
    }
  };
  for (const db of previous) if (!next.has(db)) touch(db);
  for (const db of next) if (!previous.has(db)) touch(db);
}
