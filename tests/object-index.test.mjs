import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('src/viewer/ObjectIndex.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { objectIdOf, ObjectIndex, applyStates, updateFlag } = mod;

test('objectIdOf reads the dbId of every tile representation and ignores other models', () => {
  assert.equal(objectIdOf('tile961-far#15676'), '15676');
  assert.equal(objectIdOf('tile12#345'), '345');
  assert.equal(objectIdOf('tile12-detail#345'), '345');
  assert.equal(objectIdOf('base0#terrain'), null);
  assert.equal(objectIdOf('15676'), null);
});

test('selection follows an object across far, light and detail tiles', () => {
  const index = new ObjectIndex();
  const objects = {};
  const mk = id => (objects[id] = { selected: false, highlighted: false, visible: true });
  ['tile1#7', 'tile1-far#7', 'tile2#7', 'tile1#8'].forEach(mk);
  index.add(Object.keys(objects));
  updateFlag(index, objects, 'selected', new Set(), new Set(['7']));
  assert.deepEqual(Object.entries(objects).filter(([, o]) => o.selected).map(([id]) => id).sort(), ['tile1#7', 'tile1-far#7', 'tile2#7']);
  updateFlag(index, objects, 'selected', new Set(['7']), new Set(['8']));
  assert.deepEqual(Object.entries(objects).filter(([, o]) => o.selected).map(([id]) => id), ['tile1#8']);
  // A detail tile that loads later picks up the current states.
  const later = { 'tile1-detail#8': { selected: false, highlighted: false, visible: true }, 'tile1-detail#9': { selected: false, highlighted: false, visible: true } };
  index.add(Object.keys(later));
  applyStates(later, { selected: new Set(['8']), highlighted: new Set(), hidden: new Set(['9']) });
  assert.equal(later['tile1-detail#8'].selected, true);
  assert.equal(later['tile1-detail#9'].visible, false);
  index.remove(['tile1#7', 'tile1-far#7', 'tile2#7']);
  assert.equal(index.has('7'), false);
});
