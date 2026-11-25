import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetaIndex } from '../scripts/meta-index.mjs';

// Minimal property database: 1 = model root, 2 = file, 3 = wall instance of type 4.
function sampleDb() {
  const attrs = [
    null,
    ['parent', '__parent__', 11, '', '', '', 0, 0],
    ['name', '__name__', 20, '', '', '', 0, 0],
    ['Category', '__category__', 20, '', '', '', 0, 0],
    ['instanceof_objid', '__instanceof__', 11, '', '', '', 0, 0],
    ['Length', 'Dimensions', 3, 'autodesk.unit.unit:meters-1.0.0', '', '길이', 0, 2],
    ['Mark', 'Identity Data', 20, '', '', '', 0, 0],
    ['Secret', 'Other', 20, '', '', '', 1, 0],
    ['Material', 'Materials', 20, '', '', '재료', 0, 0],
  ];
  const vals = ['', 'Model.nwd', 'Bridge.nwc', '교각 P3', 1, 2, 'Revit Walls', 12.3456789, 'P3', 'x', 'Concrete', 'Wall Type A', 'Steel', 4];
  // [attr, val] pairs per object
  const props = {
    1: [[2, 1]],
    2: [[1, 4], [2, 2]],
    3: [[1, 5], [2, 3], [3, 6], [4, 13], [5, 7], [6, 8], [7, 9], [8, 12]],
    4: [[2, 11], [8, 10], [6, 8]],
  };
  const offs = [0], avs = [];
  for (let id = 1; id <= 4; id++) { offs[id] = avs.length / 2; for (const [a, v] of props[id]) avs.push(a, v); }
  return { ids: ['', 'r', 'f', 'w-guid', 't-guid'], offs, avs, attrs, vals };
}

test('tree carries parents, names and a searchable type', () => {
  const { tree, stats } = buildMetaIndex(sampleDb(), { shardSize: 2 });
  assert.deepEqual(tree.parent, [0, 0, 1, 2, 0]);
  assert.deepEqual(tree.name, ['', 'Model.nwd', 'Bridge.nwc', '교각 P3', 'Wall Type A']);
  assert.equal(tree.types[tree.type[3]], 'Revit Walls');
  assert.equal(stats.objects, 4);
});

test('properties use display names and units, hide internal/hidden ones and inherit from the type', () => {
  const { shards } = buildMetaIndex(sampleDb(), { shardSize: 2 });
  const wall = shards.get(1)[3];
  assert.equal(wall.x, 'w-guid');
  assert.deepEqual(wall.p.find(p => p[1] === '길이'), ['Dimensions', '길이', 12.345679, 'meters']);
  assert.ok(!wall.p.some(p => p[1] === 'Secret'), 'hidden attribute leaked');
  assert.ok(!wall.p.some(p => p[0].startsWith('__')), 'internal attribute leaked');
  // Own material (Steel) wins over the type's (Concrete); the type's Mark is not duplicated.
  assert.deepEqual(wall.p.filter(p => p[1] === '재료'), [['Materials', '재료', 'Steel']]);
  assert.equal(wall.p.filter(p => p[1] === 'Mark').length, 1);
});
