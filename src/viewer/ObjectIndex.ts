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

export class ObjectIndex {
  private byObject = new Map<string, Set<string>>();

  /** Register a loaded model's entity ids; returns the dbIds it contains. */
  add(entityIds: Iterable<string>): string[] {
    const added: string[] = [];
    for (const id of entityIds) {
      const db = objectIdOf(id);
      if (db === null) continue;
      let set = this.byObject.get(db);
      if (!set) { set = new Set(); this.byObject.set(db, set); }
      set.add(id);
      added.push(db);
    }
    return added;
  }

  remove(entityIds: Iterable<string>): void {
    for (const id of entityIds) {
      const db = objectIdOf(id);
      if (db === null) continue;
      const set = this.byObject.get(db);
      if (!set) continue;
      set.delete(id);
      if (!set.size) this.byObject.delete(db);
    }
  }

  entities(dbId: string): Iterable<string> {
    return this.byObject.get(dbId) ?? [];
  }

  has(dbId: string): boolean {
    return this.byObject.has(dbId);
  }

  clear(): void {
    this.byObject.clear();
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

/** Apply the object sets to one newly loaded model's entities. */
export function applyStates(objects: Record<string, Paintable>, states: ObjectStates): void {
  for (const [id, entity] of Object.entries(objects)) {
    const db = objectIdOf(id);
    if (db === null) continue;
    const color = colorFor(db, states);
    if (color) entity.colorize = color;
    if (states.hidden.has(db)) entity.visible = false;
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
