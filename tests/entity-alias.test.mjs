import test from 'node:test';
import assert from 'node:assert/strict';
import { indexFragments, estimateOrigin, matchFile } from '../scripts/entity-alias.mjs';

// Source (SVF) boxes in survey coordinates; the converter wrote them shifted by a whole-metre origin.
const origin = [214000, 395000, 30];
const at = (x, y, z, s = 1) => [x, y, z, x + s, y + s, z + s];
const shift = b => b.map((v, a) => v - origin[a % 3]);

test('renamed fragments go to the named object of the same file whose fragment has their box', () => {
  const fragments = indexFragments([
    { dbId: 10, bbox: at(214100, 395100, 40) },          // 10: named in the file
    { dbId: 10, bbox: at(214102, 395100, 40) },          // 10: second fragment → entity-5
    { dbId: 11, bbox: at(214200, 395100, 40, 2) },       // 11: named
    { dbId: 11, bbox: at(214203, 395100, 40) },          // 11: second fragment → entity-7
    { dbId: 12, bbox: at(214203, 395100, 40) },          // 12: same box as 11's, but 12 is not in this file
    { dbId: 13, bbox: at(214300, 395100, 40) },          // single-fragment object
  ]);
  const ids = ['10', 'entity-5', '11', 'entity-7', '13', 'entity-9'];
  const boxes = Float64Array.from([at(214100, 395100, 40), at(214102, 395100, 40), at(214200, 395100, 40, 2),
    at(214203, 395100, 40), at(214300, 395100, 40), at(214900, 395900, 40)].flatMap(shift));
  const file = { ids, boxes, steps: new Float64Array(ids.length * 3).fill(0.005) };
  const est = estimateOrigin([file], fragments);
  assert.deepEqual(est.origin, origin);
  const { pairs, stats } = matchFile(file, fragments, est.origin);
  assert.deepEqual(pairs, [5, 10, 7, 11]);
  assert.equal(stats.generated, 3); assert.equal(stats.matched, 2); assert.equal(stats.named, 3); assert.equal(stats.namedMatched, 3);
});

test('two renamed fragments of one object take different source fragments', () => {
  const fragments = indexFragments([
    { dbId: 20, bbox: at(214100, 395100, 40) },
    { dbId: 20, bbox: at(214100, 395100, 40) },          // identical copy (e.g. two materials on one face)
    { dbId: 20, bbox: at(214100, 395100, 40) },
  ]);
  const ids = ['20', 'entity-1', 'entity-2'];
  const boxes = Float64Array.from([0, 1, 2].flatMap(() => shift(at(214100, 395100, 40))));
  const { pairs, stats } = matchFile({ ids, boxes, steps: new Float64Array(9) }, fragments, origin);
  assert.deepEqual(pairs, [1, 20, 2, 20]);
  assert.equal(stats.ambiguous, 0);
});
