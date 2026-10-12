// Publish a 3D Tiles 1.1 tileset for the second viewer engine (docs/3D뷰_2차_엔진.md, decision D23) from the
// model's existing R2 tiles. Read-only on those tiles.
//   whole site : every tile's far (merged) file → leaf content, then coarser parents (HLOD) up to one root
//   region     : TILES3D_REGION="<manifest index>:<count>" or DIAG_OPTIONS="region=<index>:<count>"
//                (default: the tile with most objects, 48 tiles)
//                gets light → original children under its far leaf
//   output     : <prefix>/tiles3d/runs/<id>/{tileset.json, objects.bin, c/*.glb}, then <prefix>/tiles3d/current.json
// Object ids: numeric entity ids are dbIds; converter-renamed fragments (`entity-N`) use the model's fragment
// table (meta/alias), so every level carries the owning object's dbId per vertex.
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeXkt } from './tile-lod-merge.mjs';
import { packMeshes, mergeGroups, simplifyGroup, encodeGlb, boxVolume, groupSpatially, triangles } from './tiles3d.mjs';
import { checkStorageBudget } from './storage-budget.mjs';
import { cacheKey } from './cache-key.mjs';

const env = process.env;
const FAR_ERROR = 1;      // metres: far v5 (0.25 m simplification, parts < 1 m pruned)
const LIGHT_ERROR = 0.05; // metres: light v2 (0.1 % relative per island)
const PARENT_FACTOR = 3;  // each coarser level allows 3× the error of its children
let prefix = env.MODEL_CACHE_PREFIX || (env.URN ? cacheKey(env.URN) : '');
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix ?? '')) throw new Error('Invalid cache identifier');
// TILES3D_LOCAL_DIR: a folder laid out like the bucket (dry runs and tests without R2).
const localDir = env.TILES3D_LOCAL_DIR ? path.resolve(env.TILES3D_LOCAL_DIR) : '';
// Plain command objects locally; the SDK's classes against R2.
const local = name => class { constructor(input) { this.input = input; this.name = name; } };
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = localDir
  ? { S3Client: null, GetObjectCommand: local('Get'), PutObjectCommand: local('Put'), DeleteObjectCommand: local('Delete'), ListObjectsV2Command: local('List'), HeadObjectCommand: local('Head') }
  : await import('@aws-sdk/client-s3');
const s3 = localDir ? null : new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const client = localDir ? { send: async command => localSend(command) } : s3;
/** The few S3 commands this job uses, on a local folder. */
async function localSend(command) {
  const { Key, Body, Prefix } = command.input;
  const file = Key && path.join(localDir, Key);
  if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
    if (!fs.existsSync(file)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const bytes = fs.readFileSync(file);
    return { Body: { transformToByteArray: async () => bytes } };
  }
  if (command instanceof PutObjectCommand) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Body); return {}; }
  if (command instanceof DeleteObjectCommand) { fs.rmSync(file, { force: true }); return {}; }
  if (command instanceof ListObjectsV2Command) {
    const walk = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]) : []);
    return { Contents: walk(localDir).map(f => ({ Key: path.relative(localDir, f).split(path.sep).join('/'), Size: fs.statSync(f).size }))
      .filter(o => !Prefix || o.Key.startsWith(Prefix)) };
  }
  throw new Error('Unsupported local command');
}
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
const getBytes = async Key => {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket, Key }));
    const b = Buffer.from(await r.Body.transformToByteArray());
    return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b, { maxOutputLength: 1024 * 1048576 }) : b;
  } catch (e) { if (missing(e)) return null; throw e; }
};
const getJson = async Key => { const b = await getBytes(Key); return b ? JSON.parse(b.toString()) : null; };
const MB = n => Math.round(n / 1048576 * 10) / 10;

try { await client.send(new HeadObjectCommand({ Bucket, Key: `${prefix}/xkt/manifest.json` })); }
catch (e) {
  if (!missing(e)) throw e;
  const alias = await getJson(`${prefix}/alias.json`);
  if (!/^[A-Za-z0-9]{1,40}$/.test(alias?.prefix ?? '')) throw new Error('No cached model under this identifier', { cause: e });
  console.log(`Alias ${prefix} -> ${alias.prefix}`);
  prefix = alias.prefix;
}
const tiles = (await getJson(`${prefix}/xkt/manifest.json`))?.tiles;
if (!Array.isArray(tiles) || !tiles.length) throw new Error('Not a tiled model');
const pointer = await getJson(`${prefix}/meta/current.json`);
const objectCount = (pointer?.objects ?? 0) + 1;
// Renamed fragments → owning dbId, per manifest index.
const aliasOf = new Map();
if (typeof pointer?.alias === 'string') {
  const table = await getJson(`${prefix}/meta/${pointer.alias}`);
  for (const [i, t] of Object.entries(table?.tiles ?? {})) {
    const m = new Map();
    for (let k = 0; k + 1 < t.a.length; k += 2) m.set(t.a[k], t.a[k + 1]);
    aliasOf.set(Number(i), m);
  }
}
console.log(`Model ${prefix}: ${tiles.length} tiles, ${objectCount - 1} objects, fragment table for ${aliasOf.size} tiles`);
const dbIdsFor = (i, ids) => {
  const table = aliasOf.get(i);
  return ids.map(id => (/^\d+$/.test(id) ? Number(id) : Number(table?.get(Number(/^entity-(\d+)$/.exec(id)?.[1])) ?? 0)));
};
const validFar = t => /^merged-far-v[45]$/.test(t.far?.policy ?? '') && /^runs\/[a-zA-Z0-9-]+\/far\d+\.xkt$/.test(t.far?.n ?? '');
const validLight = t => (t.motion?.policy === 'merged-light-v2' || t.motion?.policy === 'component-border-v1') && /^runs\/[a-zA-Z0-9-]+\/(?:motion|light)?\d+\.xkt$/.test(t.motion?.n ?? '');

// Region with full detail (prototype scope; the whole site gets far + coarser levels).
const members = t => t.far?.members ?? t.motion?.members ?? 0;
const centreOf = b => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
// An empty input must not read as tile 0 (Number('') === 0).
const regionOption = env.TILES3D_REGION || /(?:^|,)\s*region=(\d+:\d+)/.exec(env.DIAG_OPTIONS || '')?.[1];
let [regionTile, regionCount] = regionOption ? regionOption.split(':').map(Number) : [NaN, NaN];
if (!(regionTile >= 0 && regionTile < tiles.length)) { regionTile = 0; tiles.forEach((t, i) => { if (members(t) > members(tiles[regionTile])) regionTile = i; }); }
if (!(regionCount > 0)) regionCount = 48;
const c0 = centreOf(tiles[regionTile].aabb);
const region = new Set(tiles.map((t, i) => [i, Math.hypot(...centreOf(t.aabb).map((v, a) => v - c0[a]))])
  .sort((a, b) => a[1] - b[1]).slice(0, regionCount).map(([i]) => i));
console.log(`Region: ${region.size} tiles around ${regionTile}`);

const files = new Map(); // relative path → Buffer
const stats = { far: { files: 0, triangles: 0, bytes: 0 }, light: { files: 0, triangles: 0, bytes: 0 },
  detail: { files: 0, triangles: 0, bytes: 0 }, parents: [] };
const objectBoxes = new Float32Array(objectCount * 6);
for (let k = 0; k < objectCount; k++) objectBoxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], k * 6);
const growObjects = group => {
  if (!group) return;
  for (let v = 0; v < group.ids.length; v++) {
    const id = group.ids[v];
    if (!(id > 0 && id < objectCount)) continue;
    for (let a = 0; a < 3; a++) {
      const p = group.pos[v * 3 + a];
      if (p < objectBoxes[id * 6 + a]) objectBoxes[id * 6 + a] = p;
      if (p > objectBoxes[id * 6 + 3 + a]) objectBoxes[id * 6 + 3 + a] = p;
    }
  }
};
/** Decode one XKT, write its glb; returns { groups, bounds } or null. */
async function convert(i, key, name, kind) {
  const xkt = await getBytes(`${prefix}/xkt/${key}`);
  if (!xkt) return null;
  const decoded = decodeXkt(xkt);
  if (!decoded?.meshes.length) return null;
  const dbIds = dbIdsFor(i, decoded.ids);
  const groups = packMeshes(decoded.meshes, e => dbIds[e]);
  const out = await encodeGlb(groups);
  if (!out) return null;
  files.set(`c/${name}.glb`, out.glb);
  stats[kind].files++; stats[kind].triangles += out.triangles; stats[kind].bytes += out.glb.length;
  return { groups, bounds: out.bounds };
}

// Leaves: far content for every tile, light/detail children in the region.
const leaves = [];
let next = 0, done = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let i = next++; i < tiles.length; i = next++) {
    const t = tiles[i];
    if (!validFar(t)) continue;
    const far = await convert(i, t.far.n, `f${i}`, 'far');
    if (!far) continue;
    growObjects(far.groups.opaque); growObjects(far.groups.transparent);
    const node = { key: i, centre: centreOf(far.bounds), bounds: far.bounds, groups: far.groups, content: `c/f${i}.glb`, error: 0, children: [] };
    if (region.has(i)) {
      const light = validLight(t) ? await convert(i, t.motion.n, `l${i}`, 'light') : null;
      const detail = /^[\w.-]+\.xkt$/.test(t.n ?? '') ? await convert(i, t.n, `d${i}`, 'detail') : null;
      const detailNode = detail && { bounds: detail.bounds, content: `c/d${i}.glb`, error: 0, children: [] };
      const lightNode = light && { bounds: light.bounds, content: `c/l${i}.glb`, error: detailNode ? LIGHT_ERROR : 0, children: detailNode ? [detailNode] : [] };
      const child = lightNode ?? detailNode;
      if (child) { node.children = [child]; node.error = FAR_ERROR; }
      // Far pruned small parts: the finer levels can reach beyond its box, and culling uses the node's box.
      for (const b of [light?.bounds, detail?.bounds]) if (b) for (let a = 0; a < 3; a++) {
        node.bounds[a] = Math.min(node.bounds[a], b[a]); node.bounds[a + 3] = Math.max(node.bounds[a + 3], b[a + 3]);
      }
    }
    leaves.push(node);
    if (++done % 100 === 0) console.log(`Leaves ${done}/${tiles.length} · far ${MB(stats.far.bytes)} MB`);
  }
}));
console.log('Leaves', JSON.stringify(stats));

// Coarser levels: merge each group of ≤8 children and simplify with a larger absolute error.
let parentId = 0;
async function build(node, depth) {
  if (node.content) return node; // a leaf (far) node, possibly with light/detail children
  const kids = [];
  for (const child of node.children) kids.push(await build(child, depth + 1));
  const error = Math.max(...kids.map(k => k.error || FAR_ERROR)) * PARENT_FACTOR;
  const opaque = await simplifyGroup(mergeGroups(kids.map(k => k.groups?.opaque)), error);
  const transparent = await simplifyGroup(mergeGroups(kids.map(k => k.groups?.transparent)), error);
  for (const k of kids) delete k.groups; // merged into this level; children keep only their tileset entry
  const out = await encodeGlb({ opaque, transparent });
  const id = parentId++;
  const content = out ? `c/h${id}.glb` : null;
  if (out) files.set(content, out.glb);
  const level = (stats.parents[depth] ??= { nodes: 0, triangles: 0, bytes: 0, error });
  level.nodes++; level.triangles += out?.triangles ?? 0; level.bytes += out?.glb.length ?? 0;
  const bounds = [0, 1, 2].map(a => Math.min(...kids.map(k => k.bounds[a]))).concat([3, 4, 5].map(a => Math.max(...kids.map(k => k.bounds[a]))));
  return { bounds, content, error, groups: { opaque, transparent }, children: kids };
}
const root = await build(groupSpatially(leaves, 8), 0);
console.log('Parents', JSON.stringify(stats.parents));

const toJson = node => ({
  boundingVolume: boxVolume(node.bounds), geometricError: node.error, refine: 'REPLACE',
  ...(node.content ? { content: { uri: node.content } } : {}),
  ...(node.children?.length ? { children: node.children.map(toJson) } : {}),
});
const tileset = { asset: { version: '1.1', generator: 'MIR build-tiles3d' }, geometricError: root.error * 2, root: toJson(root),
  extras: { mir: { objects: objectCount, region: { tile: regionTile, count: region.size } } } };
for (let k = 0; k < objectCount * 6; k++) if (!Number.isFinite(objectBoxes[k])) objectBoxes[k] = NaN;
files.set('tileset.json', gzipSync(JSON.stringify(tileset)));
files.set('objects.bin', gzipSync(Buffer.from(objectBoxes.buffer)));

const total = [...files.values()].reduce((s, b) => s + b.length, 0);
console.log(`Tileset: ${files.size} files, ${MB(total)} MB; root ${triangles(root.groups?.opaque) + triangles(root.groups?.transparent)} triangles`);
delete root.groups;
if (!localDir) await checkStorageBudget(tok => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) })), total);
const run = `runs/${randomUUID()}`;
const entries = [...files.entries()];
for (let k = 0; k < entries.length; k += 16) await Promise.all(entries.slice(k, k + 16).map(([path, body]) => client.send(new PutObjectCommand({
  Bucket, Key: `${prefix}/tiles3d/${run}/${path}`, Body: body,
  ContentType: path.endsWith('.glb') ? 'model/gltf-binary' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  ...(path.endsWith('.glb') ? {} : { ContentEncoding: 'gzip' }) }))));
await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/tiles3d/current.json`, ContentType: 'application/json',
  Body: JSON.stringify({ v: 1, run, files: [...files.keys()], bytes: total, builtAt: new Date().toISOString(), stats }) }));
console.log(`Published ${prefix}/tiles3d/${run}`);
let removed = 0, tok;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/tiles3d/runs/`, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) }));
  for (const o of page.Contents ?? []) if (!o.Key.startsWith(`${prefix}/tiles3d/${run}/`)) { await client.send(new DeleteObjectCommand({ Bucket, Key: o.Key })); removed++; }
  tok = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (tok);
console.log(`Done, removed ${removed} old files`);
