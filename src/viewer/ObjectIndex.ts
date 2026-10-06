/**
 * Original object (SVF dbId) ↔ scene entities. Tiles load with globalizeObjectIds, so one design object
 * appears as `tile12#345` (light/original), `tile12-far#345` and `tile12-detail#345`, and an object that
 * spans tiles appears once per tile. Selection, search highlights and visibility act on the dbId so every
 * representation that is (or later becomes) loaded follows.
 */
const TILE_ENTITY = /^tile\d+(?:-far|-detail)?#(.+)$/;

/** dbId of a tile entity; null for terrain/base models and anything else. */
export function objectIdOf(entityId: string): string | null {
  const m = TILE_ENTITY.exec(entityId);
  return m ? m[1] : null;
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

/** Entity flags driven by object sets (selected = clicked, highlighted = search hits, hidden = tree). */
export type ObjectStates = { selected: ReadonlySet<string>; highlighted: ReadonlySet<string>; hidden: ReadonlySet<string> };
type Flaggable = { selected: boolean; highlighted: boolean; visible: boolean };

/** Apply the object sets to one newly loaded model's entities. */
export function applyStates(objects: Record<string, Flaggable>, states: ObjectStates): void {
  for (const [id, entity] of Object.entries(objects)) {
    const db = objectIdOf(id);
    if (db === null) continue;
    if (states.selected.has(db)) entity.selected = true;
    if (states.highlighted.has(db)) entity.highlighted = true;
    if (states.hidden.has(db)) entity.visible = false;
  }
}

/** Move one flag from the previous object set to the next, touching only entities that change. */
export function updateFlag(
  index: ObjectIndex,
  objects: Record<string, Flaggable | undefined>,
  flag: 'selected' | 'highlighted' | 'hidden',
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): void {
  const set = (db: string, on: boolean) => {
    for (const id of index.entities(db)) {
      const entity = objects[id];
      if (!entity) continue;
      if (flag === 'hidden') entity.visible = !on;
      else entity[flag] = on;
    }
  };
  for (const db of previous) if (!next.has(db)) set(db, false);
  for (const db of next) if (!previous.has(db)) set(db, true);
}
