// Publish the renamed-fragment table (scripts/entity-alias.mjs) for one cached tiled model:
//   <prefix>/meta/alias/<id>.json   { v, tiles: { <manifest index>: { n: entity count, a: [N, dbId, …] } } } (gzip)
//   <prefix>/meta/current.json      gains { alias: 'alias/<id>.json' }; the viewer folds `entity-N` into its object.
// Reads the SVF FragmentList through APS (read-only) and every original tile from R2; tiles are not changed.
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { xktEntityBoxes } from './tile-lod-merge.mjs';
import { indexFragments, estimateOrigin, matchFile } from './entity-alias.mjs';
import { checkStorageBudget } from './storage-budget.mjs';
import { cacheKey } from './cache-key.mjs';

const require = createRequire(import.meta.url);
const { parseFragments } = require('svf-utils/lib/svf/fragments');
const env = process.env;
const APS = 'https://developer.api.autodesk.com';
const region = env.APS_REGION && env.APS_REGION !== 'US' ? env.APS_REGION : '';
let prefix = env.MODEL_CACHE_PREFIX || (env.URN ? cacheKey(env.URN) : '');
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix ?? '')) throw new Error('Invalid cache identifier');
const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
const getBytes = async Key => {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket, Key }));
    const b = Buffer.from(await r.Body.transformToByteArray());
    return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b, { maxOutputLength: 1024 * 1048576 }) : b;
  } catch (e) { if (missing(e)) return null; throw e; }
};
const getJson = async Key => { const b = await getBytes(Key); return b ? JSON.parse(b.toString()) : null; };

// Same cache-directory resolution as the other R2 jobs (a per-URN key may alias a legacy directory).
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
const pointer = await getJson(`${prefix}/meta/current.json`);
if (pointer?.v !== 1) throw new Error('No model index (run diag_only=meta-index first)');
const tiles = (await getJson(`${prefix}/xkt/manifest.json`))?.tiles;
if (!Array.isArray(tiles) || !tiles.length) throw new Error('Not a tiled model');

// Source fragments (dbId + world box) from the SVF the tiles were converted from.
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
let svf = null; // the first SVF graphics resource, as the converter and the index job pick it
const walk = d => { if (!svf && d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') svf = d; d.children?.forEach(walk); };
(await mr.json()).derivatives?.forEach(d => d.children?.forEach(walk));
if (!svf?.urn) throw new Error('No SVF derivative');
const svfZip = new AdmZip(await derivativeBytes(t, svf.urn));
const asset = (JSON.parse(svfZip.readAsText('manifest.json')).assets ?? []).find(a => a.type === 'Autodesk.CloudPlatform.FragmentList');
if (!asset?.URI) throw new Error('FragmentList asset missing');
const base = svf.urn.slice(0, svf.urn.lastIndexOf('/') + 1);
const fragmentBytes = svfZip.getEntry(asset.URI)?.getData() ?? await derivativeBytes(t, path.posix.normalize(path.posix.join(base, asset.URI)));
const fragments = indexFragments([...parseFragments(fragmentBytes)].map(f => ({ dbId: f.dbID, bbox: f.bbox })));
console.log(`Fragments: ${fragments.db.length.toLocaleString()} (${fragments.byDb.size.toLocaleString()} objects)`);

// Every original tile: entity boxes in file order.
const files = new Array(tiles.length);
let next = 0, done = 0, bytes = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let i = next++; i < tiles.length; i = next++) {
    const name = tiles[i]?.n;
    if (typeof name !== 'string' || !/^[\w./-]+\.xkt$/.test(name)) continue;
    const xkt = await getBytes(`${prefix}/xkt/${name}`);
    if (!xkt) { console.log(`Missing tile ${name}`); continue; }
    bytes += xkt.length;
    files[i] = xktEntityBoxes(xkt);
    if (++done % 100 === 0) console.log(`Tiles ${done}/${tiles.length} (${(bytes / 1073741824).toFixed(2)} GiB)`);
  }
}));
const est = estimateOrigin(files.filter(Boolean), fragments);
if (!est || est.votes < est.samples * 0.9) throw new Error(`No consistent converter origin: ${JSON.stringify(est)}`);
console.log(`Origin ${est.origin.join(',')} (${est.votes}/${est.samples} single-fragment objects agree)`);

const out = { v: 1, tiles: {} }, total = { entities: 0, named: 0, namedMatched: 0, generated: 0, matched: 0, ambiguous: 0 };
files.forEach((file, i) => {
  if (!file) return;
  const { pairs, stats } = matchFile(file, fragments, est.origin);
  for (const k of Object.keys(total)) total[k] += stats[k];
  if (pairs.length) out.tiles[i] = { n: file.ids.length, a: pairs };
});
console.log('Match', JSON.stringify(total));
// Named entities must find their own fragment, or the geometry and the fragment list do not belong together.
if (total.namedMatched < total.named * 0.95) throw new Error('Tiles do not match the SVF fragments; nothing published');

const id = randomUUID();
const body = gzipSync(JSON.stringify(out), { level: 9 });
console.log(`Alias table ${(body.length / 1048576).toFixed(2)} MB for ${Object.keys(out.tiles).length} tiles`);
await checkStorageBudget(tok => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) })), body.length);
await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/meta/alias/${id}.json`, Body: body, ContentType: 'application/json', ContentEncoding: 'gzip' }));
// Re-read the pointer right before writing so an index rebuilt meanwhile keeps its generation.
const latest = await getJson(`${prefix}/meta/current.json`);
await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/meta/current.json`, ContentType: 'application/json',
  Body: JSON.stringify({ ...latest, alias: `alias/${id}.json`, aliasBuiltAt: new Date().toISOString() }) }));
let removed = 0, tok;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/meta/alias/`, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) }));
  for (const o of page.Contents ?? []) if (o.Key !== `${prefix}/meta/alias/${id}.json`) { await client.send(new DeleteObjectCommand({ Bucket, Key: o.Key })); removed++; }
  tok = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (tok);
console.log(`Published ${prefix}/meta/alias/${id}.json, removed ${removed} old table(s)`);
