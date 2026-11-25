/** Partition whole objects, never their faces. No geometry is changed or omitted.
 * Oversized individual objects get their own leaf; budgets cannot safely split them.
 */
export function partitionSpatialObjects(objects, triangleBudget) {
  if (!Number.isSafeInteger(triangleBudget) || triangleBudget <= 0) throw new Error('Invalid triangle budget');
  const ids = new Set();
  for (const object of objects) {
    if (ids.has(object.id)) throw new Error('Duplicate object ID');
    ids.add(object.id);
    if (!Array.isArray(object.center) || object.center.length !== 3 || !object.center.every(Number.isFinite) ||
        !Number.isSafeInteger(object.triangles) || object.triangles < 0) throw new Error('Invalid spatial object');
  }
  const leaves = [];
  const split = items => {
    const triangles = items.reduce((n, item) => n + item.triangles, 0);
    if (!items.length) return;
    if (triangles <= triangleBudget || items.length === 1) {
      leaves.push({ objects: items, triangles, oversized: triangles > triangleBudget });
      return;
    }
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const item of items) for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a], item.center[a]); high[a] = Math.max(high[a], item.center[a]);
    }
    const axis = [0, 1, 2].reduce((best, a) => high[a] - low[a] > high[best] - low[best] ? a : best, 0);
    // Stable tie order, deterministic even when all centres coincide. Median splitting
    // keeps recursion bounded; triangle counts, not object counts, decide leaf readiness.
    const sorted = items.slice().sort((a, b) => a.center[axis] - b.center[axis]);
    const middle = Math.floor(sorted.length / 2);
    split(sorted.slice(0, middle));
    split(sorted.slice(middle));
  };
  split(objects.slice());
  return leaves;
}
