// One-off R2 cleanup approved by the user on 2026-10-13 (storage at 9.03 of 9.8 GB). Only these targets:
//   1. old-generation XKT of the 평택-오송 integrated model: `.xkt` files under <model>/xkt/ whose path appears nowhere
//      in its manifest (every string in it ending in .xkt counts as in use: detail, far, light, nav, base, inst, lod…)
//   2. two old single large objects without a manifest, and three `validate…` test folders — each only if its object
//      count and byte total still match the inventory the user saw
// Dry run by default (prints the plan); DIAG_OPTIONS="apply=1" deletes. Nothing else in the bucket is touched.
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const MODEL = 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLkp4';
export const EXACT = [
  { prefix: 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLlMy', objects: 1, bytes: 1223199756, what: 'old large file (no manifest)' },
  { prefix: 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLmgt', objects: 1, bytes: 1191239304, what: 'old large file (no manifest)' },
  { prefix: 'validatezellipsespline', objects: 2, bytes: 153405649, what: 'test files' },
  { prefix: 'validatebulgefix', objects: 2, bytes: 120140561, what: 'test files' },
  { prefix: 'validatesplinezlayers', objects: 2, bytes: 72955861, what: 'test files' },
];
/** Files changed this recently are never removed (a job may have written them before updating the manifest). */
export const MIN_AGE_MS = 6 * 3600 * 1000;

/** Every `.xkt` path anywhere in the manifest — values and object keys (chunkInfo is keyed by file) — as bucket keys. */
export function referencedXkt(prefix, manifest) {
  const refs = new Set();
  const walk = v => {
    if (typeof v === 'string') {
      if (v.endsWith('.xkt')) {
        if (v.startsWith('/') || v.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe manifest path ${v}`);
        refs.add(`${prefix}/xkt/${v}`);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
  };
  walk(manifest);
  return refs;
}

const inPrefix = (key, prefix) => key === prefix || key.startsWith(`${prefix}/`);

/**
 * @param {{ key: string, bytes: number, modified: Date }[]} objects the whole bucket listing
 * @param {unknown} manifest the model's parsed xkt/manifest.json
 * @returns {{ deletions: { key: string, bytes: number, reason: string }[], skipped: string[], kept: { referenced: number, missing: string[] } }}
 */
export function planCleanup(objects, manifest, now = Date.now()) {
  const deletions = [], skipped = [];
  // 1. Old-generation XKT of the model.
  const refs = referencedXkt(MODEL, manifest);
  const keys = new Set(objects.map(o => o.key));
  const missing = [...refs].filter(k => !keys.has(k));
  const manifests = objects.filter(o => inPrefix(o.key, MODEL) && o.key.endsWith('/manifest.json'));
  if (!Array.isArray(manifest?.tiles) || !manifest.tiles.length || refs.size === 0) skipped.push('model: manifest has no tiles; nothing removed');
  else if (missing.length) skipped.push(`model: ${missing.length} files the manifest uses are missing; nothing removed`);
  else if (manifests.length !== 1) skipped.push(`model: ${manifests.length} manifests; nothing removed`);
  else {
    for (const o of objects) {
      if (!o.key.startsWith(`${MODEL}/xkt/`) || !o.key.endsWith('.xkt') || refs.has(o.key)) continue;
      if (now - o.modified.getTime() < MIN_AGE_MS) { skipped.push(`model: ${o.key} changed within 6 h; kept`); continue; }
      deletions.push({ key: o.key, bytes: o.bytes, reason: 'old generation (not in manifest)' });
    }
  }
  // 2. Exact groups.
  for (const t of EXACT) {
    const group = objects.filter(o => inPrefix(o.key, t.prefix));
    const bytes = group.reduce((n, o) => n + o.bytes, 0);
    if (group.length !== t.objects || bytes !== t.bytes) { skipped.push(`${t.prefix}: ${group.length} objects / ${bytes} bytes, expected ${t.objects} / ${t.bytes}; kept`); continue; }
    for (const o of group) deletions.push({ key: o.key, bytes: o.bytes, reason: t.what });
  }
  return { deletions, skipped, kept: { referenced: refs.size, missing } };
}

async function main() {
  const env = process.env;
  const apply = /(?:^|,)\s*apply=1\b/.test(env.DIAG_OPTIONS || '');
  const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  const Bucket = env.R2_BUCKET;
  const list = async () => {
    const out = [];
    let token;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const o of page.Contents ?? []) out.push({ key: o.Key, bytes: o.Size, modified: new Date(o.LastModified) });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  };
  const readManifest = async () => {
    const r = await client.send(new GetObjectCommand({ Bucket, Key: `${MODEL}/xkt/manifest.json` }));
    const b = Buffer.from(await r.Body.transformToByteArray());
    return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString());
  };
  const GB = n => (n / 1e9).toFixed(3);
  const objects = await list();
  const total = objects.reduce((n, o) => n + o.bytes, 0);
  const manifest = await readManifest();
  const plan = planCleanup(objects, manifest);
  console.log(`Bucket: ${objects.length} objects, ${GB(total)} GB. Manifest uses ${plan.kept.referenced} XKT files (all present: ${!plan.kept.missing.length}).`);
  console.log(`Manifest fields: ${Object.keys(manifest).join(', ')}; tiles with far ${manifest.tiles?.filter(t => t?.far).length ?? 0}, with light ${manifest.tiles?.filter(t => t?.motion).length ?? 0}`);
  const byReason = new Map();
  for (const d of plan.deletions) { const r = byReason.get(d.reason) ?? { n: 0, bytes: 0 }; r.n++; r.bytes += d.bytes; byReason.set(d.reason, r); }
  for (const [reason, r] of byReason) console.log(`Plan: ${reason}: ${r.n} objects, ${GB(r.bytes)} GB`);
  const folders = new Map();
  for (const d of plan.deletions.filter(x => x.key.startsWith(`${MODEL}/`))) {
    const folder = d.key.split('/').slice(0, -1).join('/');
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  for (const [folder, n] of folders) console.log(`  old generation in ${folder}: ${n} files`);
  for (const d of plan.deletions.filter(x => x.key.startsWith(`${MODEL}/`)).slice(0, 40))
    console.log(`    ${d.key.slice(MODEL.length + 1)} (${(d.bytes / 1048576).toFixed(1)} MB, modified ${objects.find(o => o.key === d.key).modified.toISOString()})`);
  for (const d of plan.deletions.filter(x => !x.key.startsWith(`${MODEL}/`)))
    console.log(`  ${d.key} (${GB(d.bytes)} GB, modified ${objects.find(o => o.key === d.key).modified.toISOString()})`);
  for (const s of plan.skipped) console.log(`Skipped: ${s}`);
  const planned = plan.deletions.reduce((n, d) => n + d.bytes, 0);
  console.log(`Planned removal ${GB(planned)} GB → ${GB(total - planned)} GB${apply ? '' : ' (dry run: nothing deleted; DIAG_OPTIONS=apply=1 to delete)'}`);
  if (!apply) return;
  let removed = 0;
  for (const d of plan.deletions) { await client.send(new DeleteObjectCommand({ Bucket, Key: d.key })); removed++; }
  // Verify: everything the manifest uses is still there.
  const after = await list();
  const keys = new Set(after.map(o => o.key));
  const lost = [...referencedXkt(MODEL, await readManifest())].filter(k => !keys.has(k));
  console.log(`Deleted ${removed} objects. Bucket now ${after.length} objects, ${GB(after.reduce((n, o) => n + o.bytes, 0))} GB. Files in use missing: ${lost.length}`);
  if (lost.length) throw new Error(`Files in use are missing: ${lost.slice(0, 5).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
