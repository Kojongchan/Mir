import test from 'node:test';
import assert from 'node:assert/strict';
import { weldExact } from '../scripts/exact-weld.mjs';

test('thin faces survive and identical vertices share storage', () => {
  const vertices = new Float64Array([0, 0, 0, .005, 0, 0, 0, .005, 0, 0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2, 3, 2, 1]);
  const result = weldExact(vertices, indices, null);
  assert.equal(result.verts.length, 9);
  assert.deepEqual([...result.idx], [0, 1, 2, 0, 2, 1]);
  for (let i = 0; i < indices.length; i++) for (let a = 0; a < 3; a++)
    assert.equal(result.verts[result.idx[i] * 3 + a], vertices[indices[i] * 3 + a]);
});

test('normal seams and high precision coordinates are preserved', () => {
  const x = 250000.000123;
  const result = weldExact([x, 0, 0, x, 0, 0], [0, 1], [0, 0, 1, 0, 1, 0]);
  assert.equal(result.verts.length, 6);
  assert.equal(result.verts[0], x);
  assert.deepEqual([...result.normals], [0, 0, 1, 0, 1, 0]);
});

test('invalid data fails before emitting a partial mesh', () => {
  assert.throws(() => weldExact([0, 0], [], null));
  assert.throws(() => weldExact([0, 0, Infinity], [0], null));
  assert.throws(() => weldExact([0, 0, 0], [1], null));
  assert.throws(() => weldExact([0, 0, 0], [0], [1]));
});
