// Generate merged LOD files (scripts/tile-lod-merge.mjs) for one cached model and publish them in its
// manifest. LOD_PROFILE=light → tile.motion (replaces older motion pairs, whose files are then deleted),
// LOD_PROFILE=far → tile.far (every tile, always-resident whole-site level).
// Originals (tile.n, base, focus) are never modified or deleted. The manifest is replaced with
// If-Match so a concurrent writer is never overwritten; progress is published in batches.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { buildMergedLod, LOD_PROFILES } from './tile-lod-merge.mjs';
import { encodeXktTransfer } from './xkt-transfer.mjs';
import { checkStorageBudget } from './storage-budget.mjs';

const env = process.env, profileName = env.LOD_PROFILE || 'light', profile = LOD_PROFILES[profileName];
if (!profile) throw Error(`Unknown LOD_PROFILE ${profileName}`);
let prefix = env.MODEL_CACHE_PREFIX;
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix ?? '')) throw Error('Invalid cache identifier');
const maxAdd = Math.min(Math.max(Number(env.LOD_ADD_MB || 1024), 16), 4096) * 1048576;
const deadline = Date.now() + Math.min(Math.max(Number(env.LOD_MINUTES || 100), 5), 110) * 60000;
const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

// A per-URN key without its own manifest may alias a claimed legacy directory (api/aps-convert.ts).
try { await client.send(new HeadObjectCommand({ Bucket, Key: `${prefix}/xkt/manifest.json` })); }
catch (e) {
  if (!missing(e)) throw e;
  const r = await client.send(new GetObjectCommand({ Bucket, Key: `${prefix}/alias.json` }));
  const alias = JSON.parse(Buffer.from(await r.Body.transformToByteArray()).toString());
  if (!/^[A-Za-z0-9]{1,40}$/.test(alias?.prefix ?? '')) throw Error('Invalid alias');
  console.log(`Alias ${prefix} -> ${alias.prefix}`); prefix = alias.prefix;
}
const key = `${prefix}/xkt/manifest.json`;
const get = async Key => {
  const r = await client.send(new GetObjectCommand({ Bucket, Key }));
  if (r.ContentLength > 160 * 1048576) throw Error('Oversized source');
  const bytes = Buffer.from(await r.Body.transformToByteArray());
  return { bytes: bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, { maxOutputLength: 512 * 1048576 }) : bytes, etag: r.ETag };
};
const source = await get(key);
const manifest = JSON.parse(source.bytes);
let etag = source.etag;
if (!Array.isArray(manifest.tiles) || !manifest.tiles.length || manifest.inst?.length) throw Error('Unsupported manifest');
manifest.chunkInfo ??= {};
const generation = `runs/${randomUUID()}`;
const field = profileName === 'far' ? 'far' : 'motion';
const done = t => t[field]?.policy === profile.policy || t.lodTried?.[profileName] === profile.policy;

// Storage check lists the bucket; re-list every 40 uploads and track additions in between.
let listed = null, sinceList = 0;
const budget = async bytes => {
  if (!listed || sinceList >= 40) {
    listed = await checkStorageBudget(token => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) })), bytes);
    sinceList = 0; listed.extra = 0;
  }
  if (listed.bytes + listed.extra + bytes > listed.limit) throw Error('Storage budget reached');
  listed.extra += bytes; sinceList++;
};

let generated = 0, unchanged = 0, failed = 0, added = 0, pendingDeletes = [];
const publish = async () => {
  const body = Buffer.from(JSON.stringify(manifest));
  await budget(body.length);
  // Never overwrite a concurrently replaced manifest.
  const r = await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: 'application/json', IfMatch: etag }));
  etag = r.ETag;
  // Superseded light files are derived data; delete only after the manifest no longer references them.
  for (const k of pendingDeletes) await client.send(new DeleteObjectCommand({ Bucket, Key: `${prefix}/xkt/${k}` })).catch(() => {});
  if (pendingDeletes.length) console.log(`Deleted ${pendingDeletes.length} superseded files`);
  pendingDeletes = [];
};

let sinceBatch = 0;
for (let i = 0; i < manifest.tiles.length; i++) {
  const tile = manifest.tiles[i];
  if (done(tile)) continue;
  if (Date.now() > deadline || added >= maxAdd) { console.log(`Stopping at tile ${i} (time or size limit)`); break; }
  if (typeof tile.n !== 'string' || !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.xkt$/.test(tile.n)) throw Error('Unsafe cache path');
  let result;
  const original = await get(`${prefix}/xkt/${tile.n}`);
  try { result = await buildMergedLod(original.bytes, profileName); }
  catch (e) { failed++; console.log(`tile ${i}: ${e.message}`); }
  // Failed and not-useful tiles are marked so later runs do not rescan them; the viewer keeps detail there.
  // Light must be clearly smaller than detail to be worth a second download; far always publishes
  // (it is the whole-site level and also merges draw layers).
  const useful = result && (profileName === 'far' || result.bytes.length < original.bytes.length * 0.75);
  if (!useful) { tile.lodTried = { ...(tile.lodTried ?? {}), [profileName]: profile.policy }; unchanged++; continue; }
  const packed = encodeXktTransfer(result.bytes);
  await budget(packed.body.length);
  const n = `${generation}/${profileName}${i}.xkt`;
  await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/xkt/${n}`, Body: packed.body, ContentType: 'application/octet-stream',
    ...(packed.contentEncoding ? { ContentEncoding: packed.contentEncoding } : {}) }));
  const verify = await get(`${prefix}/xkt/${n}`);
  if (!verify.bytes.equals(result.bytes)) throw Error('Stored LOD bytes differ');
  const old = tile[field];
  if (old?.n && old.n !== tile.n && /^runs\//.test(old.n)) pendingDeletes.push(old.n);
  tile[field] = { n, byteLength: result.bytes.length, policy: result.policy, members: result.members,
    detailTriangles: result.detailTriangles, triangles: result.triangles, sourceTiles: result.sourceTiles,
    sourceSha256: createHash('sha256').update(original.bytes).digest('hex') };
  manifest.chunkInfo[n] = { byteLength: result.bytes.length, transferByteLength: packed.body.length, kind: profileName };
  if (old?.n) delete manifest.chunkInfo[old.n];
  generated++; added += packed.body.length; sinceBatch++;
  console.log(`${profileName} ${generated}; tile ${i + 1}/${manifest.tiles.length}; ${result.sourceTiles} internal tiles → 1; ` +
    `${result.triangles}/${result.detailTriangles} tri; +${Math.round(added / 1048576)}MiB`);
  if (sinceBatch >= 100) { await publish(); sinceBatch = 0; console.log('Progress published'); }
}
if (sinceBatch || unchanged || pendingDeletes.length) await publish();
const remaining = manifest.tiles.filter(t => !done(t)).length;
console.log(`Done ${profileName}: generated ${generated}, unchanged ${unchanged}, failed ${failed}, added ${Math.round(added / 1048576)}MiB, remaining ${remaining}/${manifest.tiles.length}`);
