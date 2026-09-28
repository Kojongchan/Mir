import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync('api/r2-inventory.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const inventory = {};
new Function('exports', 'require', 'process', code)(inventory, () => ({}), { env: {} });

test('R2 listing counts exact bytes, rejects incomplete listings and decodes keys', () => {
  const first = inventory.parseR2List('<ListBucketResult><Contents><Key>a/xkt/a&amp;b.xkt</Key><Size>23</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>page&amp;2</NextContinuationToken></ListBucketResult>');
  assert.deepEqual(first, { objects: [{ key: 'a/xkt/a&b.xkt', bytes: 23 }], next: 'page&2' });
  assert.throws(() => inventory.parseR2List('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'));
  assert.throws(() => inventory.parseR2List('<Error><Code>AccessDenied</Code></Error>'));
});

test('active XKT remains separate from unreferenced bytes; broken manifests never mark objects stale', () => {
  const objects = [
    { key: 'active/xkt/manifest.json', bytes: 100 },
    { key: 'active/xkt/current.xkt', bytes: 2_000_000_000 },
    { key: 'active/xkt/older.xkt', bytes: 1_700_000_000 },
    { key: 'legacy/model.glb', bytes: 6_400_000_000 },
  ];
  const manifests = new Map([['active', { xktFiles: ['current.xkt'] }]]);
  const result = inventory.inventorySummary(objects, manifests);
  assert.equal(result.totalBytes, 10_100_000_100);
  assert.equal(result.targetReductionBytes, 300_000_100);
  assert.equal(result.groups.find(group => group.prefix === 'active').referencedXktBytes, 2_000_000_000);
  assert.equal(result.groups.find(group => group.prefix === 'active').staleXktBytes, 1_700_000_000);
  assert.equal(result.groups.find(group => group.prefix === 'legacy').staleXktBytes, null);
  manifests.set('active', { xktFiles: ['missing.xkt'] });
  assert.equal(inventory.inventorySummary(objects, manifests).groups.find(group => group.prefix === 'active').staleXktBytes, null);
});
