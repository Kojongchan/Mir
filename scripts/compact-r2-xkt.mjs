import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { encodeXktTransfer } from './xkt-transfer.mjs';

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const md5 = body => createHash('md5').update(body).digest('base64');

export function manifestKeys(prefix, manifest) {
  if (!Array.isArray(manifest.xktFiles) || !manifest.xktFiles.length) throw new Error('Invalid active manifest');
  const names = [];
  for (const field of ['xktFiles', 'navFiles', 'base', 'inst']) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error('Invalid active file list');
    names.push(...value);
  }
  if (manifest.lod1 != null) names.push(manifest.lod1);
  if (manifest.tiles !== undefined) {
    if (!Array.isArray(manifest.tiles)) throw new Error('Invalid active tiles');
    names.push(...manifest.tiles.map(t => t?.n));
    names.push(...manifest.tiles.filter(t => t?.motion).map(t => t.motion.n));
  }
  for (const name of names) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_./-]+\.xkt$/.test(name) || name.startsWith('/') ||
      name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe active file path');
  }
  return [...new Set(names)].map(name => `${prefix}/xkt/${name}`);
}

/** store.get returns RAW wire bytes (not HTTP auto-decompressed bytes).
 * Conditional writes stop when another writer changes a file. No model keys are deleted.
 */
export async function compactObject(store, key, { apply = false } = {}) {
  const head = await store.head(key);
  if (head.encoding === 'gzip') return { state: 'already-compressed', savedBytes: 0 };
  if (head.encoding && head.encoding !== 'identity') throw new Error('Unsupported content encoding');
  if (!head.etag || !Number.isSafeInteger(head.bytes) || head.bytes <= 0) throw new Error('Invalid object headers');
  if (head.bytes > MAX_OBJECT_BYTES) return { state: 'too-large', savedBytes: 0 };
  if (head.storageClass && head.storageClass !== 'STANDARD') throw new Error('Only Standard storage is supported');
  const source = await store.get(key, head.etag);
  if (source.body.length !== head.bytes || source.etag !== head.etag) throw new Error('Object changed while reading');
  if (source.body[0] === 0x1f && source.body[1] === 0x8b) throw new Error('Gzip object has missing encoding header');
  const packed = encodeXktTransfer(source.body);
  if (!packed.contentEncoding) return { state: 'no-gain', savedBytes: 0 };
  const savedBytes = source.body.length - packed.body.length;
  if (!apply) return { state: 'planned', savedBytes };
  // Matching ETag prevents replacing a concurrent conversion. MD5 guards transport corruption.
  const uploaded = await store.put(key, packed.body, { ...source.metadata, encoding: 'gzip' }, head.etag, md5(packed.body));
  if (!uploaded.etag) throw new Error('Upload response omitted ETag; stop for inspection');
  try {
    const check = await store.get(key, uploaded.etag);
    if (check.metadata.encoding !== 'gzip' || !check.body.equals(packed.body) ||
      !gunzipSync(check.body).equals(source.body)) throw new Error('Stored content verification failed');
    // Verify through the same HTTP decompression behavior used by the web viewer.
    const browserBytes = await store.browserGet(key);
    if (!browserBytes.equals(source.body)) throw new Error('HTTP decompression verification failed');
  } catch {
    // Roll back only our upload; never overwrite an unrelated concurrent update.
    await store.put(key, source.body, source.metadata, uploaded.etag, md5(source.body));
    throw new Error('Verification failed; original bytes restored');
  }
  return { state: 'compressed', savedBytes };
}

export async function compactBucket(store, { apply = false, progress = () => {} } = {}) {
  const before = await store.list();
  const keys = new Set(before.map(o => o.key));
  const manifests = before.filter(o => /^[^/]+\/xkt\/manifest\.json$/.test(o.key));
  if (!manifests.length) throw new Error('No active XKT manifests');
  const snapshots = [], candidates = new Set();
  // Validate every active reference BEFORE writing any object.
  for (const item of manifests) {
    const data = await store.get(item.key);
    const manifest = JSON.parse(data.body.toString('utf8'));
    const refs = manifestKeys(item.key.split('/')[0], manifest);
    if (refs.some(key => !keys.has(key))) throw new Error('Active manifest references missing objects');
    for (const key of refs) candidates.add(key);
    snapshots.push({ key: item.key, etag: data.etag });
  }
  const result = { apply, beforeBytes: before.reduce((n, o) => n + o.bytes, 0), afterBytes: null,
    plannedSavings: 0, savedBytes: 0, checked: 0, compressed: 0, skipped: 0, total: candidates.size, targetMet: false };
  for (const key of candidates) {
    if (result.checked % 20 === 0) {
      for (const item of snapshots) if ((await store.head(item.key)).etag !== item.etag) throw new Error('Active manifest changed; stopped safely');
    }
    const item = await compactObject(store, key, { apply });
    result.checked++;
    if (item.state === 'compressed') { result.compressed++; result.savedBytes += item.savedBytes; }
    else if (item.state === 'planned') result.plannedSavings += item.savedBytes;
    else result.skipped++;
    if (result.checked === 1 || result.checked % 10 === 0 || result.checked === result.total) progress({ ...result });
  }
  const after = await store.list();
  result.afterBytes = after.reduce((n, o) => n + o.bytes, 0);
  result.targetMet = result.afterBytes < 9_800_000_000;
  return result;
}

async function main() {
  // SDK is installed only in the maintenance runner, never bundled in the web viewer.
  const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const env = process.env;
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!env[key]) throw new Error('Missing R2 runner settings');
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const Bucket = env.R2_BUCKET;
  const metadata = r => ({ encoding: r.ContentEncoding, contentType: r.ContentType, cacheControl: r.CacheControl,
    disposition: r.ContentDisposition, language: r.ContentLanguage, expires: r.Expires, custom: r.Metadata, storageClass: r.StorageClass });
  const store = {
    async list() {
      const all = []; let token;
      for (let page = 0; page < 100; page++) {
        const r = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of r.Contents ?? []) {
          if (!o.Key || !Number.isSafeInteger(o.Size) || o.Size < 0) throw new Error('Invalid inventory entry');
          all.push({ key: o.Key, bytes: o.Size });
        }
        if (!r.IsTruncated) return all;
        if (!r.NextContinuationToken || r.NextContinuationToken === token) throw new Error('Incomplete inventory');
        token = r.NextContinuationToken;
      }
      throw new Error('Inventory too large');
    },
    async head(Key) {
      const r = await client.send(new HeadObjectCommand({ Bucket, Key }));
      return { etag: r.ETag, bytes: r.ContentLength, encoding: r.ContentEncoding, storageClass: r.StorageClass };
    },
    async get(Key, etag) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key, IfMatch: etag }));
      if (r.ContentLength > MAX_OBJECT_BYTES) { r.Body?.destroy(); throw new Error('Object exceeds maintenance memory limit'); }
      return { body: Buffer.from(await r.Body.transformToByteArray()), etag: r.ETag, metadata: metadata(r) };
    },
    async put(Key, Body, m, IfMatch, ContentMD5) {
      const r = await client.send(new PutObjectCommand({ Bucket, Key, Body, IfMatch, ContentMD5,
        ContentType: m.contentType ?? 'application/octet-stream', ContentEncoding: m.encoding,
        CacheControl: m.cacheControl, ContentDisposition: m.disposition, ContentLanguage: m.language,
        Expires: m.expires, Metadata: m.custom, StorageClass: m.storageClass ?? 'STANDARD' }));
      return { etag: r.ETag };
    },
    async browserGet(Key) {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 120 });
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP verification failed');
      return Buffer.from(await r.arrayBuffer());
    },
  };
  const apply = process.argv.includes('--apply');
  const result = await compactBucket(store, { apply, progress: r => console.log(JSON.stringify(r)) });
  console.log(JSON.stringify(result));
  if (apply && !result.targetMet) throw new Error('Compaction finished but storage still exceeds 9.8GB; review usage report');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('R2 compaction stopped. Check the last verified counts; no model keys were deleted.'); process.exitCode = 1; });
}
