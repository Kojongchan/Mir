import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('src/viewer/ObjectIndex.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { objectIdOf, ObjectIndex, applyStates, updateFlag, SELECT_COLOR, HIGHLIGHT_COLOR } = mod;

test('objectIdOf reads the dbId of every tile representation and ignores other models', () => {
  assert.equal(objectIdOf('tile961-far#15676'), '15676');
  assert.equal(objectIdOf('tile12#345'), '345');
  assert.equal(objectIdOf('tile12-detail#345'), '345');
  assert.equal(objectIdOf('base0#terrain'), null);
  assert.equal(objectIdOf('15676'), null);
  // Converter-generated names are reused by unrelated objects in other tiles: keyed per tile.
  assert.equal(objectIdOf('tile4-detail#entity-117'), 'tile4#entity-117');
  assert.equal(objectIdOf('tile4-far#entity-117'), 'tile4#entity-117');
  assert.equal(objectIdOf('tile9#entity-117'), 'tile9#entity-117');
});

test('an object without a dbId selects only its own tile', () => {
  const index = new ObjectIndex();
  const objects = {};
  for (const id of ['tile4#entity-117', 'tile4-far#entity-117', 'tile4-detail#entity-117', 'tile9#entity-117']) objects[id] = { colorize: null, visible: true };
  index.add(Object.keys(objects));
  const states = { selected: new Set([objectIdOf('tile4-detail#entity-117')]), highlighted: new Set(), hidden: new Set() };
  updateFlag(index, objects, 'selected', new Set(), states);
  assert.deepEqual(Object.keys(objects).filter(id => objects[id].colorize === SELECT_COLOR).sort(),
    ['tile4#entity-117', 'tile4-detail#entity-117', 'tile4-far#entity-117']);
});

test('selection follows an object across far, light and detail tiles', () => {
  const index = new ObjectIndex();
  const objects = {};
  const mk = id => (objects[id] = { colorize: null, visible: true });
  ['tile1#7', 'tile1-far#7', 'tile2#7', 'tile1#8'].forEach(mk);
  index.add(Object.keys(objects));
  const states = { selected: new Set(['7']), highlighted: new Set(['8']), hidden: new Set() };
  updateFlag(index, objects, 'selected', new Set(), states);
  updateFlag(index, objects, 'highlighted', new Set(), states);
  const painted = c => Object.entries(objects).filter(([, o]) => o.colorize === c).map(([id]) => id).sort();
  assert.deepEqual(painted(SELECT_COLOR), ['tile1#7', 'tile1-far#7', 'tile2#7']);
  assert.deepEqual(painted(HIGHLIGHT_COLOR), ['tile1#8']);
  // Selecting a highlighted object shows blue; deselecting returns it to amber, others to their own colour.
  const prev = states.selected;
  states.selected = new Set(['8']);
  updateFlag(index, objects, 'selected', prev, states);
  assert.deepEqual(painted(SELECT_COLOR), ['tile1#8']);
  assert.deepEqual(painted(null), ['tile1#7', 'tile1-far#7', 'tile2#7']);
  const prev2 = states.selected;
  states.selected = new Set();
  updateFlag(index, objects, 'selected', prev2, states);
  assert.deepEqual(painted(HIGHLIGHT_COLOR), ['tile1#8']);
  // A detail tile that loads later picks up the current states.
  const later = { 'tile1-detail#8': { colorize: null, visible: true }, 'tile1-detail#9': { colorize: null, visible: true } };
  index.add(Object.keys(later));
  applyStates(later, { selected: new Set(['8']), highlighted: new Set(), hidden: new Set(['9']) });
  assert.equal(later['tile1-detail#8'].colorize, SELECT_COLOR);
  assert.equal(later['tile1-detail#9'].visible, false);
  index.remove(['tile1#7', 'tile1-far#7', 'tile2#7']);
  assert.equal(index.has('7'), false);
});
