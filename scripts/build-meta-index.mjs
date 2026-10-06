// Publish the model tree + property shards (scripts/meta-index.mjs) for one cached model:
//   <prefix>/meta/runs/<gen>/tree.json      parents, names, types (gzip)
//   <prefix>/meta/runs/<gen>/p/<k>.json     properties of dbIds [k*S, (k+1)*S) (gzip)
//   <prefix>/meta/current.json              { v, gen, shardSize, shardCount } — written last, read by api/aps-convert.ts
// Reads the existing SVF derivative's property database through APS (read-only, no new APS job).
// Older generations are deleted after the pointer moves. Geometry and the tile manifest are untouched.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildMetaIndex } from './meta-index.mjs';
import { checkStorageBudget } from './storage-budget.mjs';
import { cacheKey } from './cache-key.mjs';

const env = process.env;
const APS = 'https://developer.api.autodesk.com';
const region = env.APS_REGION && env.APS_REGION !== 'US' ? env.APS_REGION : '';
const shardSize = Math.min(Math.max(Number(env.META_SHARD || 1024), 64), 16384);
const maxBytes = Math.min(Math.max(Number(env.META_MAX_MB || 1024), 16), 4096) * 1048576;
// Cache id from the dispatch input, or (right after a conversion) derived from the URN like the converter.
let prefix = env.MODEL_CACHE_PREFIX || (env.URN ? cacheKey(env.URN) : '');
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix ?? '')) throw new Error('Invalid cache identifier');
const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
const getJson = async Key => {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket, Key }));
    return JSON.parse(Buffer.from(await r.Body.transformToByteArray()).toString());
  } catch (e) { if (missing(e)) return null; throw e; }
};

// Same cache-directory resolution as the LOD job (a per-URN key may alias a legacy directory).
let urn = env.URN || '';
try { await client.send(new HeadObjectCommand({ Bucket, Key: `${prefix}/xkt/manifest.json` })); }
catch (e) {
  if (!missing(e)) throw e;
  const alias = await getJson(`${prefix}/alias.json`);
  if (!/^[A-Za-z0-9]{1,40}$/.test(alias?.prefix ?? '')) throw new Error('No cached model under this identifier', { cause: e });
  console.log(`Alias ${prefix} -> ${alias.prefix}`);
  prefix = alias.prefix; urn ||= alias.urn ?? '';
}
urn ||= (await getJson(`${prefix}/claim.json`))?.urn ?? '';
if (!/^[A-Za-z0-9_-]+=*$/.test(urn)) throw new Error('Model URN unknown: pass the urn input');

async function token() {
  const basic = Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${APS}/authentication/v2/token`, { method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }) });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('APS token failed');
  return d.access_token;
}
const apsHeaders = t => ({ authorization: `Bearer ${t}`, ...(region ? { region } : {}) });
async function derivativeBytes(t, derivativeUrn, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${APS}/derivativeservice/v2/derivatives/${encodeURIComponent(derivativeUrn)}`, { headers: apsHeaders(t) });
      if (!r.ok) throw new Error(`derivative ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, i * 3000));
    }
  }
}

const t = await token();
const mr = await fetch(`${APS}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { headers: apsHeaders(t) });
if (!mr.ok) throw new Error(`manifest ${mr.status}`);
// The first SVF graphics resource, in the same walk order the converter used for the geometry.
let svf = null;
const walk = d => { if (!svf && d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') svf = d; d.children?.forEach(walk); };
(await mr.json()).derivatives?.forEach(d => d.children?.forEach(walk));
if (!svf?.urn) throw new Error('No SVF derivative');
const svfZip = new AdmZip(await derivativeBytes(t, svf.urn));
const assets = JSON.parse(svfZip.readAsText('manifest.json')).assets ?? [];
const base = svf.urn.slice(0, svf.urn.lastIndexOf('/') + 1);
const read = async type => {
  const asset = assets.find(a => a.type === `Autodesk.CloudPlatform.${type}`);
  if (!asset?.URI) throw new Error(`Property database asset missing: ${type}`);
  const bytes = await derivativeBytes(t, path.posix.normalize(path.posix.join(base, asset.URI)));
  console.log(`${type}: ${(bytes.length / 1048576).toFixed(1)} MB`);
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: 2048 * 1048576 }).toString());
};
const db = { ids: await read('PropertyIDs'), offs: await read('PropertyOffsets'), avs: await read('PropertyAVs'),
  attrs: await read('PropertyAttributes'), vals: await read('PropertyValues') };
const { tree, shards, stats } = buildMetaIndex(db, { shardSize });
console.log('Index', JSON.stringify(stats));

const gen = `runs/${randomUUID()}`;
const files = [[`${prefix}/meta/${gen}/tree.json`, gzipSync(JSON.stringify(tree), { level: 9 })]];
let shardCount = 0;
for (const [k, shard] of shards) {
  files.push([`${prefix}/meta/${gen}/p/${k}.json`, gzipSync(JSON.stringify(shard), { level: 9 })]);
  shardCount = Math.max(shardCount, k + 1);
}
const total = files.reduce((n, [, b]) => n + b.length, 0);
console.log(`Upload ${files.length} files, ${(total / 1048576).toFixed(1)} MB (tree ${(files[0][1].length / 1048576).toFixed(1)} MB)`);
if (total > maxBytes) throw new Error(`Index ${(total / 1048576).toFixed(0)} MB exceeds META_MAX_MB`);
await checkStorageBudget(tok => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) })), total);

const put = (Key, Body) => client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/json', ContentEncoding: 'gzip' }));
for (let i = 0; i < files.length; i += 16) await Promise.all(files.slice(i, i + 16).map(([k, b]) => put(k, b)));
await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/meta/current.json`, ContentType: 'application/json',
  Body: JSON.stringify({ v: 1, gen, shardSize, shardCount, objects: stats.objects, builtAt: new Date().toISOString() }) }));
console.log(`Published ${prefix}/meta/${gen}`);

// Remove superseded generations (the pointer no longer references them).
let removed = 0, tok;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/meta/runs/`, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) }));
  for (const o of page.Contents ?? []) if (!o.Key.startsWith(`${prefix}/meta/${gen}/`)) { await client.send(new DeleteObjectCommand({ Bucket, Key: o.Key })); removed++; }
  tok = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (tok);
console.log(`Done: ${stats.objects} objects, ${shardCount} shards, removed ${removed} old files`);
