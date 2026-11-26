// One-off R2 cleanup approved by the user on 2026-11-26 ("우리가 지금 사용하지 않는 정리대상은 지워도 돼, 남겨야 할 것 같은
// 건 남겨놔도 되고"; storage 7.52 of 10 GB). The previous one-off (2026-10-13: old XKT generation, two old large files,
// validate* folders) has run. Only these targets:
//   1. the second viewer's plain tileset `<model>/tiles3d/` — the site (통합모델·간섭검토) and the 4D/5D branch use
//      `tiles3d-svf/`; the hidden test page model-test-2 can rebuild it
//   2. the first viewer's light pairs (manifest `tiles[].motion`, xeokit page model-test only; tile builds read the far
//      and original files): dropped from the manifest first (written back only if unchanged since read), then removed
//   3. `.xkt` files of the model that the (rewritten) manifest no longer names — old generations and the light pairs
//   4. old caches of other models (no manifest, no alias: model.glb / error.json of early conversions), only the groups
//      listed in ORPHANS with the object count and bytes seen in the dry run
// Kept: original and far XKT, nav/base/terrain and every other file the manifest names, meta/, tiles3d-svf/, alias.json
// and claim.json, files/ (same-file index), anything changed within 6 h. Dry run by default; DIAG_OPTIONS="apply=1" deletes.
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const MODEL = 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLkp4';
/** Other models' old caches the user's approval covers — filled from the dry run (prefix, objects, bytes must match). */
export const ORPHANS = [];
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

/** The manifest without the light pairs (tiles[].motion and their chunkInfo entries); the input is not changed. */
export function withoutLight(manifest) {
  const next = structuredClone(manifest);
  const dropped = [];
  for (const t of next.tiles ?? []) {
    if (t && typeof t === 'object' && t.motion) { if (typeof t.motion.n === 'string') dropped.push(t.motion.n); delete t.motion; }
  }
  if (next.chunkInfo && typeof next.chunkInfo === 'object') {
    for (const [file, info] of Object.entries(next.chunkInfo)) if (dropped.includes(file) || info?.kind === 'motion') { delete next.chunkInfo[file]; if (!dropped.includes(file)) dropped.push(file); }
  }
  return { manifest: next, dropped };
}

/**
 * @param {{ key: string, bytes: number, modified: Date }[]} objects the whole bucket listing
 * @param {unknown} manifest the model's parsed xkt/manifest.json
 * @returns plan: deletions, the manifest to write back first (null: unchanged), what is skipped, and the files the
 *   rewritten manifest uses (all must stay)
 */
export function planCleanup(objects, manifest, now = Date.now()) {
  const deletions = [], skipped = [];
  const old = o => now - o.modified.getTime() >= MIN_AGE_MS;
  const keys = new Set(objects.map(o => o.key));
  // 1. Plain tileset of the second viewer (not tiles3d-svf).
  for (const o of objects) {
    if (!o.key.startsWith(`${MODEL}/tiles3d/`)) continue;
    if (!old(o)) { skipped.push(`${o.key} changed within 6 h; kept`); continue; }
    deletions.push({ key: o.key, bytes: o.bytes, reason: '2차 화면 타일(tiles3d, 운영은 tiles3d-svf)' });
  }
  // 2–3. Light pairs out of the manifest, then every model .xkt the rewritten manifest does not name.
  let manifestAfter = null, inUse = new Set();
  const manifests = objects.filter(o => inPrefix(o.key, MODEL) && o.key.endsWith('/manifest.json'));
  if (!Array.isArray(manifest?.tiles) || !manifest.tiles.length) skipped.push('model: manifest has no tiles; no XKT removed');
  else if (manifests.length !== 1) skipped.push(`model: ${manifests.length} manifests; no XKT removed`);
  else {
    const before = referencedXkt(MODEL, manifest);
    const missing = [...before].filter(k => !keys.has(k));
    if (missing.length) skipped.push(`model: ${missing.length} files the manifest uses are missing; no XKT removed`);
    else {
      const { manifest: next, dropped } = withoutLight(manifest);
      inUse = referencedXkt(MODEL, next);
      if (dropped.length) manifestAfter = next;
      const lightKeys = new Set(dropped.map(n => `${MODEL}/xkt/${n}`));
      for (const o of objects) {
        if (!o.key.startsWith(`${MODEL}/xkt/`) || !o.key.endsWith('.xkt') || inUse.has(o.key)) continue;
        if (!old(o)) { skipped.push(`${o.key} changed within 6 h; kept`); continue; }
        deletions.push({ key: o.key, bytes: o.bytes, reason: lightKeys.has(o.key) ? '1차 화면 경량(light)' : '옛 세대 XKT(매니페스트에 없음)' });
      }
    }
  }
  // 4. Exact old caches of other models.
  for (const t of ORPHANS) {
    const group = objects.filter(o => inPrefix(o.key, t.prefix));
    const bytes = group.reduce((n, o) => n + o.bytes, 0);
    const guarded = group.some(o => /\/(alias|claim)\.json$|\/xkt\/manifest\.json$|\/current\.json$/.test(o.key));
    if (t.prefix === MODEL || t.prefix === 'files' || guarded || group.length !== t.objects || bytes !== t.bytes || !group.every(old)) {
      skipped.push(`${t.prefix}: ${group.length} objects / ${bytes} bytes (expected ${t.objects} / ${t.bytes}${guarded ? ', has alias/manifest' : ''}); kept`);
      continue;
    }
    for (const o of group) deletions.push({ key: o.key, bytes: o.bytes, reason: '다른 모델의 옛 캐시(매니페스트·별칭 없음)' });
  }
  return { deletions, skipped, manifestAfter, inUse };
}

/** Groups outside the model (first path segment), for choosing ORPHANS: what each holds and when it last changed. */
export function otherGroups(objects) {
  const groups = new Map();
  for (const o of objects) {
    const prefix = o.key.split('/')[0];
    if (prefix === MODEL) continue;
    const g = groups.get(prefix) ?? { prefix, objects: 0, bytes: 0, names: new Set(), newest: 0 };
    g.objects++; g.bytes += o.bytes; g.names.add(o.key.slice(prefix.length + 1).replace(/\d+/g, '#')); g.newest = Math.max(g.newest, o.modified.getTime());
    groups.set(prefix, g);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

async function main() {
  const env = process.env;
  const apply = /(?:^|,)\s*apply=1\b/.test(env.DIAG_OPTIONS || '');
  const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
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
  const manifestKey = `${MODEL}/xkt/manifest.json`;
  const readManifest = async () => {
    const r = await client.send(new GetObjectCommand({ Bucket, Key: manifestKey }));
    const b = Buffer.from(await r.Body.transformToByteArray());
    return { etag: r.ETag, gzip: b[0] === 0x1f && b[1] === 0x8b, contentType: r.ContentType, contentEncoding: r.ContentEncoding,
      value: JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString()) };
  };
  const GB = n => (n / 1e9).toFixed(3);
  const objects = await list();
  const total = objects.reduce((n, o) => n + o.bytes, 0);
  const source = await readManifest();
  const plan = planCleanup(objects, source.value);
  const sizeOf = new Map(objects.map(o => [o.key, o.bytes]));
  const field = name => source.value.tiles.reduce((n, t) => n + (sizeOf.get(`${MODEL}/xkt/${t?.[name]?.n ?? t?.[name] ?? ''}`) ?? 0), 0);
  console.log(`Bucket: ${objects.length} objects, ${GB(total)} GB. Model folder ${GB(objects.filter(o => inPrefix(o.key, MODEL)).reduce((n, o) => n + o.bytes, 0))} GB.`);
  console.log(`Manifest: fields ${Object.keys(source.value).join(', ')}; tile fields ${[...new Set(source.value.tiles.flatMap(t => Object.keys(t ?? {})))].join(', ')}`);
  console.log(`Manifest files: original ${GB(field('n'))} GB, far ${GB(field('far'))} GB, light ${GB(field('motion'))} GB; after cleanup it names ${plan.inUse.size} files`);
  for (const sub of ['tiles3d', 'tiles3d-svf', 'meta', 'xkt'])
    console.log(`  ${sub}/: ${GB(objects.filter(o => o.key.startsWith(`${MODEL}/${sub}/`)).reduce((n, o) => n + o.bytes, 0))} GB`);
  console.log('Other groups (for ORPHANS):');
  for (const g of otherGroups(objects))
    console.log(`  ${g.prefix} · ${g.objects} objects · ${g.bytes} bytes · newest ${new Date(g.newest).toISOString()} · ${[...g.names].slice(0, 6).join(' | ')}`);
  const byReason = new Map();
  for (const d of plan.deletions) { const r = byReason.get(d.reason) ?? { n: 0, bytes: 0 }; r.n++; r.bytes += d.bytes; byReason.set(d.reason, r); }
  for (const [reason, r] of byReason) console.log(`Plan: ${reason}: ${r.n} objects, ${GB(r.bytes)} GB`);
  for (const s of plan.skipped.slice(0, 30)) console.log(`Skipped: ${s}`);
  const planned = plan.deletions.reduce((n, d) => n + d.bytes, 0);
  console.log(`Planned removal ${GB(planned)} GB → ${GB(total - planned)} GB${apply ? '' : ' (dry run: nothing deleted; DIAG_OPTIONS=apply=1 to delete)'}`);
  if (!apply) return;
  // The manifest first (only if nobody replaced it since it was read), so no page asks for a removed light file.
  if (plan.manifestAfter) {
    const { gzipSync } = await import('node:zlib');
    const text = Buffer.from(JSON.stringify(plan.manifestAfter));
    // Stored the way it was (gzip bytes or not, the same content type and encoding headers).
    await client.send(new PutObjectCommand({ Bucket, Key: manifestKey, Body: source.gzip ? gzipSync(text) : text,
      ContentType: source.contentType ?? 'application/json', ...(source.contentEncoding ? { ContentEncoding: source.contentEncoding } : {}),
      IfMatch: source.etag }));
    const check = await readManifest();
    if (JSON.stringify(check.value) !== JSON.stringify(plan.manifestAfter)) throw new Error('Manifest did not read back as written; nothing deleted');
    console.log('Manifest rewritten without the light pairs.');
  }
  let removed = 0;
  for (const d of plan.deletions) { await client.send(new DeleteObjectCommand({ Bucket, Key: d.key })); removed++; }
  // Verify: everything the manifest uses is still there, and the site's tileset with it.
  const after = await list();
  const keys = new Set(after.map(o => o.key));
  const lost = [...referencedXkt(MODEL, (await readManifest()).value)].filter(k => !keys.has(k));
  const svf = keys.has(`${MODEL}/tiles3d-svf/current.json`);
  console.log(`Deleted ${removed} objects. Bucket now ${after.length} objects, ${GB(after.reduce((n, o) => n + o.bytes, 0))} GB. Files in use missing: ${lost.length}; site tileset present: ${svf}`);
  if (lost.length || !svf) throw new Error(`Files in use are missing: ${lost.slice(0, 5).join(', ')}${svf ? '' : ' tiles3d-svf/current.json'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
