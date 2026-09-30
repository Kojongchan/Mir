type Member = { id: string; originalSystemId?: string };
type Model = { objects: Record<string, Member>; aabb: ArrayLike<number> };

/** A manifest label alone cannot authorize hiding detail. Check decoded objects
 * and placement. This is a coverage guard, not a geometric accuracy proof. */
export function motionPairMatches(detail: Model, proxy: Model): boolean {
  const ids = (m: Model) => Object.values(m.objects).map(o => o.originalSystemId || o.id).sort();
  const a = ids(detail), b = ids(proxy);
  if (!a.length || a.length !== b.length || a.some((id, i) => !id || id !== b[i])) return false;
  const box = Array.from(detail.aabb), other = Array.from(proxy.aabb);
  if (box.length !== 6 || other.length !== 6 || ![...box, ...other].every(Number.isFinite)) return false;
  for (let axis = 0; axis < 3; axis++) {
    if (box[axis] > box[axis + 3] || other[axis] > other[axis + 3]) return false;
    const tolerance = Math.max(.0001, (box[axis + 3] - box[axis]) * .01);
    if (Math.abs(box[axis] - other[axis]) > tolerance || Math.abs(box[axis+3] - other[axis+3]) > tolerance) return false;
  }
  return true;
}

export function motionTileVisibility(inView: boolean, moving: boolean, ready: boolean) {
  return { detailCulled: !inView || (moving && ready), proxyCulled: !inView || !moving || !ready };
}
