import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/viewer2/prefetch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = {};
new Function('exports', code)(mod);
const { leafFiles, nearestFiles } = mod;

const box = (x, y, z, h) => [x, y, z, h, 0, 0, 0, h, 0, 0, 0, h];
const tileset = {
  boundingVolume: { box: box(0, 0, 0, 1000) }, content: { uri: 'c/h0.glb' }, children: [
    { boundingVolume: { box: box(0, 0, 0, 50) }, content: { uri: 'c/m2-1.glb' }, children: [{ boundingVolume: { box: box(0, 0, 0, 50) }, content: { uri: 'c/d1.glb' } }] },
    { boundingVolume: { box: box(300, 0, 0, 50) }, content: { uri: 'c/m0-2.glb' }, children: [{ boundingVolume: { box: box(300, 0, 0, 50) }, content: { uri: 'c/d2.glb' } }] },
    { boundingVolume: { box: box(2000, 0, 0, 50) }, content: { uri: 'c/d3.glb' } },
    { boundingVolume: { sphere: [100, 0, 0, 10] }, content: { uri: 'c/f4.glb' } },
  ],
};

test('leaf files: the original level and its copies with their tile spheres, not parents or far files', () => {
  const files = leafFiles(tileset);
  assert.deepEqual(files.map(f => f.path).sort(), ['c/d1.glb', 'c/d2.glb', 'c/d3.glb', 'c/m0-2.glb', 'c/m2-1.glb']);
  const d1 = files.find(f => f.path === 'c/d1.glb');
  assert.deepEqual(d1.centre, [0, 0, 0]);
  assert.ok(Math.abs(d1.radius - Math.sqrt(3) * 50) < 1e-9);
  assert.deepEqual(leafFiles(null), []);
});

test('nearest files: within reach of the eye, nearest first, leaving out the ones done', () => {
  const files = leafFiles(tileset);
  const near = nearestFiles(files, [10, 0, 0], 250, new Set());
  assert.deepEqual(near.slice(0, 2).sort(), ['c/d1.glb', 'c/m2-1.glb']);
  assert.deepEqual(near.slice(2).sort(), ['c/d2.glb', 'c/m0-2.glb']);
  assert.ok(!near.includes('c/d3.glb'), '2 km away');
  assert.deepEqual(nearestFiles(files, [10, 0, 0], 250, new Set(['c/d1.glb', 'c/m2-1.glb'])).sort(), ['c/d2.glb', 'c/m0-2.glb']);
});
