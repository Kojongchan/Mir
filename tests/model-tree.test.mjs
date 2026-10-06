import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('src/viewer/ModelTree.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { ModelTree } = mod;

// 1 Model.nwd ─ 2 교량.nwc ─ 4 교각 P3, 5 교각 P4
//            └ 3 터널.nwc ─ 6 라이닝
const data = { v: 1, n: 7, parent: [0, 0, 1, 1, 2, 2, 3], name: ['', 'Model.nwd', '교량.nwc', '터널.nwc', '교각 P3', '교각 P4', '라이닝'],
  type: [0, 0, 0, 0, 1, 1, 2], types: ['', 'Structural Columns', 'Walls'] };

test('children, paths and subtrees follow the parent array', () => {
  const tree = new ModelTree(data);
  assert.deepEqual(tree.roots, [1]);
  assert.deepEqual(Array.from(tree.children(1)), [2, 3]);
  assert.equal(tree.childCount(2), 2);
  assert.deepEqual(tree.path(5), [1, 2, 5]);
  assert.deepEqual(tree.subtree(2), [2, 4, 5]);
  assert.equal(tree.type(4), 'Structural Columns');
});

test('search matches every term against name or type, case-insensitively', () => {
  const tree = new ModelTree(data);
  assert.deepEqual(tree.search('교각').ids, [4, 5]);
  assert.deepEqual(tree.search('교각 p4').ids, [5]);
  assert.deepEqual(tree.search('walls').ids, [6]);
  const limited = tree.search('nwc', 1);
  assert.equal(limited.total, 2);
  assert.deepEqual(limited.ids, [2]);
});

test('invalid parent links become roots instead of cycles', () => {
  const tree = new ModelTree({ ...data, parent: [0, 0, 1, 1, 2, 99, 6] });
  assert.ok(tree.roots.includes(5));
  assert.deepEqual(tree.path(6), [6]);
});
