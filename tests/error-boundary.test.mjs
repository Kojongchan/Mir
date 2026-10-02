import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('src/components/ErrorBoundary.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
new Function('exports', 'require', code)(exports, name => (name === 'react' ? { Component: class {} } : { jsx() {}, jsxs() {} }));

test('stale deploy chunk errors are recognised across browsers; ordinary errors are not', () => {
  for (const m of ['Failed to fetch dynamically imported module: https://x/assets/Issues-abc.js',
    'Importing a module script failed.', 'error loading dynamically imported module'])
    assert.equal(exports.isChunkLoadError(new TypeError(m)), true, m);
  assert.equal(exports.isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
});
