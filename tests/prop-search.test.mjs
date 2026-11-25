import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('src/viewer/PropSearchIndex.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { PropSearchIndex } = mod;

test('every term must match some "label value" of the object, across shards', () => {
  const idx = new PropSearchIndex();
  idx.addShard({ 5: { p: [['Item', '재료', '콘크리트 C30'], ['Dimensions', '높이', 12.5, 'm']], x: 'abc-1' }, 6: { p: [['Item', '재료', '강재 SM490']] } });
  idx.addShard({ 1030: { p: [['Element', '공정', '교각 기초'], ['Item', '재료', '콘크리트 C24']] } });
  assert.deepEqual(idx.search('콘크리트'), [5, 1030]);
  assert.deepEqual(idx.search('재료 c30'), [5]);
  assert.deepEqual(idx.search('12.5'), [5]);
  assert.deepEqual(idx.search('공정 기초'), [1030]);
  assert.deepEqual(idx.search('abc-1'), [5]);
  assert.deepEqual(idx.search('없는값'), []);
  assert.equal(idx.size, 3);
});

test('a sealed index answers the same and takes no more shards', () => {
  const idx = new PropSearchIndex();
  idx.addShard({ 5: { p: [['Item', '재료', '콘크리트 C30']] }, 9: { p: [['사용자', 'A1_객체재료', '콘크리트']] } });
  const before = idx.search('콘크리트');
  idx.seal();
  assert.deepEqual(idx.search('콘크리트'), before);
  assert.deepEqual(idx.search('a1_객체재료'), [9]);
  assert.throws(() => idx.addShard({ 10: { p: [] } }), /sealed/);
});
