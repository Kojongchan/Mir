// Publish a 3D Tiles 1.1 tileset for the second viewer engine (docs/3D뷰_2차_엔진.md, decision D23) from the
// model's existing R2 tiles. Read-only on those tiles.
//   structures : per tile, the original (detail) file reached through simplified copies of it (1 m → 0.3 m → 0.1 m),
//                so a finer view never jumps to the full original; the coarsest copy is the tile's leaf and the
//                coarser parents (HLOD, merged 8 at a time, 3 m and up) are built from it. A tile without an original
//                keeps its far (merged) file as the leaf
//   terrain    : the always-loaded base files (aerial photo per patch) → one textured leaf per photo (KTX2 kept as
//                is) and simplified parents carrying the same photos
//   region     : TILES3D_REGION="<manifest index>:<count>" or DIAG_OPTIONS="region=<index>:<count>" limits the detail
//                level to that many tiles around one (quick test builds); default: the whole site
//   reuse      : TILES3D_REUSE=1 or DIAG_OPTIONS="reuse=1" keeps the published run's leaves (far, detail, terrain,
//                objects.bin) and rebuilds only the coarser structure levels into that run (no second copy)
//   svf        : TILES3D_SVF=1 or DIAG_OPTIONS="svf=1" takes the original level's triangles from the model's SVF
//                (exact coordinates; the XKT grid is 2–20 cm, scripts/svf-precise.mjs) and publishes under
//                <prefix>/tiles3d-svf/ instead (the third viewer's trial; the second viewer's tileset is untouched).
//                Needs APS_CLIENT_ID / APS_CLIENT_SECRET (and URN, else the model's claim)
//   output     : <prefix>/tiles3d/runs/<id>/{tileset.json, objects.bin, c/*.glb}, then <prefix>/tiles3d/current.json
//   stages     : TILES3D_STAGE = all (default) | plan | leaves | finalize (decision D27). plan fixes the run, the SVF origin
//                and the parts (runs of neighbouring tiles dealt round to TILES3D_PARTS jobs, scripts/tiles3d-parts.mjs);
//                leaves (TILES3D_PART=k) builds and uploads one part's tiles; finalize audits the SVF matching over all
//                of them, builds the parents, terrain and tileset and publishes. They meet in TILES3D_WORK (plan.json,
//                part-<k>.json/.groups/.boxes; artifacts between the workflow's jobs). all: the three in one process,
//                one part in manifest order. A tile's result does not depend on the part it is built in.
// Object ids: numeric entity ids are dbIds; converter-renamed fragments (`entity-N`) use the model's fragment
// table (meta/alias), so every level carries the owning object's dbId per vertex. Terrain has no object ids.
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeXkt, xktEntityBoxes } from './tile-lod-merge.mjs';
import { packMeshes, meshColour, mergeGroups, simplifyGroup, encodeGlb, boxVolume, groupSpatially, triangles, packTerrain, simplifyTerrain,
  encodeTerrainGlb, weldGroup } from './tiles3d.mjs';
import { checkStorageBudget } from './storage-budget.mjs';
import { nearOther } from './clearance.mjs';
import { SKIN_REACH, applySkins, containedSkins } from './skins.mjs';
import { cacheKey } from './cache-key.mjs';
import { mergeBoxes, partition, readGroups, writeGroups } from './tiles3d-parts.mjs';

const env = process.env;
// Far v5 simplifies by 0.25 m but prunes parts < 1 m and drops thin pieces of large merged tiles; at 3 m the original
// replaces it from ≈200 m (field PC tier), where the first viewer also switches.
const FAR_ERROR = 3;            // metres: the finest parent level
// Copies of the original. Without them a finer screen error jumped from far (17 M triangles site-wide) to the
// originals (361 M): a 400 m view went from 11 M to 52 M triangles between 6 and 3 px (ui-check run 189). With 1 m and
// 0.3 m it drew 1.7 M (run 191); 0.3 m alone was 9.7 M site-wide, lighter than the far files, so they are not used
// where an original exists, and 0.1 m closes the gap to the original for near views.
const MID_ERRORS = [1, 0.3, 0.1]; // metres, coarse → fine
const MID_ENOUGH = 0.7;           // a copy is kept only if it has at most this share of the next finer level's triangles
const TERRAIN_ERROR = 2;        // metres: first simplified terrain level (photo patches are ≈ 9 m triangles)
const PARENT_FACTOR = 3;        // each coarser level allows 3× the error of its children
const MAX_PARENT_ERROR = 81;    // metres: a whole-site level simplified harder than this prunes everything away
let prefix = env.MODEL_CACHE_PREFIX || (env.URN ? cacheKey(env.URN) : '');
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix ?? '')) throw new Error('Invalid cache identifier');
// TILES3D_LOCAL_DIR: a folder laid out like the bucket (dry runs and tests without R2).
const localDir = env.TILES3D_LOCAL_DIR ? path.resolve(env.TILES3D_LOCAL_DIR) : '';
// Plain command objects locally; the SDK's classes against R2.
const local = name => class { constructor(input) { this.input = input; this.name = name; } };
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } = localDir
  ? { S3Client: null, GetObjectCommand: local('Get'), PutObjectCommand: local('Put'), DeleteObjectCommand: local('Delete'), DeleteObjectsCommand: local('DeleteMany'),
    ListObjectsV2Command: local('List'), HeadObjectCommand: local('Head') }
  : await import('@aws-sdk/client-s3');
const s3 = localDir ? null : new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const store = localDir ? { send: async command => localSend(command) } : s3;
// R2 network blips are retried with longer pauses than the SDK's own (run 212 stopped at tile 600 of 1,073 after three
// connect timeouts within 0.2 s; run 216 needed the fourth retry): 5, 10, 20, 40, 60 s. Answers from the store (missing
// key, refused request) are not retried.
const NETWORK = /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|ENOTFOUND|UND_ERR_\w+)$/;
const transient = e => !missing(e) && (NETWORK.test(e?.code ?? '') || e?.name === 'TimeoutError' || /socket hang up/i.test(e?.message ?? '')
  || (e?.$metadata?.httpStatusCode >= 500 && e.$metadata.httpStatusCode !== 501));
async function retrying(task) {
  for (let attempt = 1; ; attempt++) {
    try { return await task(); } catch (e) {
      if (localDir || attempt >= 6 || !transient(e)) throw e;
      const wait = Math.min(60, 5 * 2 ** (attempt - 1));
      console.log(`R2 ${e?.code ?? e?.name}; retry ${attempt}/5 in ${wait} s`);
      await new Promise(res => setTimeout(res, wait * 1000));
    }
  }
}
const client = { send: command => retrying(() => store.send(command)) };
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
  if (command instanceof DeleteObjectsCommand) { for (const o of command.input.Delete.Objects) fs.rmSync(path.join(localDir, o.Key), { force: true }); return {}; }
  if (command instanceof ListObjectsV2Command) {
    const walk = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]) : []);
    return { Contents: walk(localDir).map(f => ({ Key: path.relative(localDir, f).split(path.sep).join('/'), Size: fs.statSync(f).size }))
      .filter(o => !Prefix || o.Key.startsWith(Prefix)) };
  }
  throw new Error('Unsupported local command');
}
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
// The body is read inside the retry too (a connection can drop mid-download).
const getBytes = Key => retrying(async () => {
  try {
    const r = await store.send(new GetObjectCommand({ Bucket, Key }));
    const b = Buffer.from(await r.Body.transformToByteArray());
    return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b, { maxOutputLength: 1024 * 1048576 }) : b;
  } catch (e) { if (missing(e)) return null; throw e; }
});
const getJson = async Key => { const b = await getBytes(Key); return b ? JSON.parse(b.toString()) : null; };
const MB = n => Math.round(n / 1048576 * 10) / 10;

let urn = env.URN || '';
try { await client.send(new HeadObjectCommand({ Bucket, Key: `${prefix}/xkt/manifest.json` })); }
catch (e) {
  if (!missing(e)) throw e;
  const alias = await getJson(`${prefix}/alias.json`);
  if (!/^[A-Za-z0-9]{1,40}$/.test(alias?.prefix ?? '')) throw new Error('No cached model under this identifier', { cause: e });
  console.log(`Alias ${prefix} -> ${alias.prefix}`);
  prefix = alias.prefix; urn ||= alias.urn ?? '';
}
const svfMode = env.TILES3D_SVF === '1' || /(?:^|,)\s*svf=1\b/.test(env.DIAG_OPTIONS || '');
const OUT = svfMode ? 'tiles3d-svf' : 'tiles3d'; // published tileset folder under the model
const manifest = await getJson(`${prefix}/xkt/manifest.json`);
const tiles = manifest?.tiles, base = manifest?.base;
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
// Detail scope: the whole site, or a region for quick test builds.
const members = t => t.far?.members ?? t.motion?.members ?? 0;
const centreOf = b => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
// An empty input must not read as tile 0 (Number('') === 0).
const regionOption = env.TILES3D_REGION || /(?:^|,)\s*region=(\d+:\d+)/.exec(env.DIAG_OPTIONS || '')?.[1];
let region = null;
if (regionOption) {
  let [regionTile, regionCount] = regionOption.split(':').map(Number);
  if (!(regionTile >= 0 && regionTile < tiles.length)) { regionTile = 0; tiles.forEach((t, i) => { if (members(t) > members(tiles[regionTile])) regionTile = i; }); }
  if (!(regionCount > 0)) regionCount = 48;
  const c0 = centreOf(tiles[regionTile].aabb);
  region = new Set(tiles.map((t, i) => [i, Math.hypot(...centreOf(t.aabb).map((v, a) => v - c0[a]))])
    .sort((p, q) => p[1] - q[1]).slice(0, regionCount).map(([i]) => i));
  console.log(`Detail only for ${region.size} tiles around ${regionTile}`);
}

const STAGE = env.TILES3D_STAGE || 'all';
if (!['all', 'plan', 'leaves', 'finalize'].includes(STAGE)) throw new Error(`Unknown stage ${STAGE}`);
const WORK = path.resolve(env.TILES3D_WORK || path.join(env.RUNNER_TEMP || os.tmpdir(), `tiles3d-${prefix}`));
fs.mkdirSync(WORK, { recursive: true });
const planFile = path.join(WORK, 'plan.json'), partFile = (k, ext) => path.join(WORK, `part-${k}.${ext}`);
// Reuse: the published run's tileset gives each tile's leaf (box, error, finer levels) and the terrain branch as is.
const reuse = env.TILES3D_REUSE === '1' || /(?:^|,)\s*reuse=1\b/.test(env.DIAG_OPTIONS || '');
if (reuse && STAGE !== 'all') throw new Error('reuse=1 is built in one stage (TILES3D_STAGE=all)');

const freshStats = () => ({ far: { files: 0, triangles: 0, bytes: 0 }, detail: { files: 0, triangles: 0, bytes: 0, vertices: 0, weldedVertices: 0 },
  mid: Object.fromEntries(MID_ERRORS.map(e => [e, { files: 0, triangles: 0, bytes: 0, skipped: 0, lockedVertices: 0 }])),
  parents: [], terrain: { leaves: 0, triangles: 0, bytes: 0, textures: 0, textureBytes: 0, parents: [] },
  skins: { tiles: 0, pushed: 0, shared: 0, pairs: 0, partnerTriangles: 0, seconds: 0, partnerSeconds: 0 } });
const stats = freshStats();
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

// Each file goes to the run as soon as it is written, 16 at a time (the whole run kept in memory until the end was
// 1.9 GB); `written`: relative path → { bytes, hash (SHA-256) } of what this process uploaded (the parts' lists join in
// at finalize).
let run = null;
const written = new Map(), uploading = new Set();
let uploadError = null;
const contentType = rel => (rel.endsWith('.glb') ? 'model/gltf-binary' : rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');
async function upload(rel, body) {
  if (uploadError) throw uploadError;
  while (uploading.size >= 16) { await Promise.race(uploading); if (uploadError) throw uploadError; }
  const sent = client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/${OUT}/${run}/${rel}`, Body: body, ContentType: contentType(rel),
    ...(rel.endsWith('.glb') ? {} : { ContentEncoding: 'gzip' }) })).catch(e => { uploadError ??= e; }).finally(() => uploading.delete(sent));
  uploading.add(sent);
  written.set(rel, { bytes: body.length, hash: createHash('sha256').update(body).digest('hex') });
}
const writtenBytes = () => [...written.values()].reduce((n, w) => n + w.bytes, 0);
async function flushUploads() {
  await Promise.all(uploading);
  if (uploadError) throw uploadError;
}
/**
 * Delete keys 1,000 per request (one at a time took 27 minutes for a run's 2,751 files); if the store refuses batch
 * deletes, 16 single deletes at a time.
 */
let batchDeletes = true;
async function removeKeys(keys) {
  for (let k = 0; k < keys.length; k += 1000) {
    const chunk = keys.slice(k, k + 1000);
    if (batchDeletes) {
      try {
        const r = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true } }));
        if (r.Errors?.length) throw new Error(`Could not delete ${r.Errors.length} old files, e.g. ${r.Errors[0].Key}: ${r.Errors[0].Message}`);
        continue;
      } catch (e) {
        if (/Could not delete/.test(e.message)) throw e;
        console.log(`Batch delete refused (${e.name}: ${e.message}); deleting one by one`);
        batchDeletes = false;
      }
    }
    for (let j = 0; j < chunk.length; j += 16) await Promise.all(chunk.slice(j, j + 16).map(Key => client.send(new DeleteObjectCommand({ Bucket, Key }))));
  }
  return keys.length;
}

/**
 * Decode one XKT into packed groups (null if empty); `precise`: matched entities take the SVF's exact triangles (`fix`:
 * fragments to leave to other tiles and fragments to add, from the audit).
 */
async function load(i, key, precise = false, fix = null) {
  const xkt = await getBytes(`${prefix}/xkt/${key}`);
  if (!xkt) return null;
  const decoded = decodeXkt(xkt);
  if (!decoded?.meshes.length) return null;
  const dbIds = dbIdsFor(i, decoded.ids);
  const meshes = precise && svf ? await svf.refine(i, xkt, decoded.meshes, dbIds, fix) : decoded.meshes; // may correct and extend dbIds
  return packMeshes(meshes, e => dbIds[e]);
}
/** Write packed groups as c/<name>.glb (counted in `kind`, a stats key or entry); returns { bounds, triangles } or null. */
async function write(groups, name, kind) {
  const out = await encodeGlb(groups);
  if (!out) return null;
  await upload(`c/${name}.glb`, out.glb);
  const s = typeof kind === 'string' ? stats[kind] : kind;
  s.files++; s.triangles += out.triangles; s.bytes += out.glb.length;
  return { bounds: out.bounds, triangles: out.triangles };
}

let previous = null;
const reusedLeaves = new Map();
if (reuse) {
  const current = await getJson(`${prefix}/${OUT}/current.json`);
  const old = current && /^runs\/[a-zA-Z0-9-]+$/.test(current.run ?? '') && await getJson(`${prefix}/${OUT}/${current.run}/tileset.json`);
  if (!old) throw new Error('No published tileset to reuse');
  previous = { current, tileset: old };
  const fromBox = v => { const [cx, cy, cz, hx, , , , hy, , , , hz] = v.box; return [cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz]; };
  // The first per-tile file on the way down from the parents is the tile's leaf.
  const visit = n => {
    const m = /^c\/(?:f|d|m\d+-)(\d+)\.glb$/.exec(n.content?.uri ?? '');
    if (m) reusedLeaves.set(Number(m[1]), { bounds: fromBox(n.boundingVolume), error: n.geometricError, content: n.content.uri, children: n.children ?? [] });
    else for (const c of n.children ?? []) if (c.extras?.mir !== 'terrain') visit(c);
  };
  visit(old.root);
  console.log(`Reusing ${current.run}: ${reusedLeaves.size} leaves`);
}

/**
 * svf=1: the model's SVF for the original level — fragment boxes up front, mesh packs as tiles ask for them. Each tile
 * entity is matched to its source fragment and replaced by its exact triangles (scripts/svf-precise.mjs). `knownOrigin`:
 * the converter origin from the plan (estimated here when null: the plan's job). TILES3D_SVF_MODULE: a module with the
 * same exports in place of svf-precise.mjs (tests).
 */
async function openSvf(knownOrigin) {
  const { openSvfSource, fragmentMatcher, refineMeshes } = await import(env.TILES3D_SVF_MODULE ? pathToFileURL(path.resolve(env.TILES3D_SVF_MODULE)).href : './svf-precise.mjs');
  const { estimateOrigin } = await import('./entity-alias.mjs');
  urn ||= (await getJson(`${prefix}/claim.json`))?.urn ?? '';
  if (!/^[A-Za-z0-9_-]+=*$/.test(urn)) throw new Error('Model URN unknown: pass the urn input');
  let token = null;
  const getToken = async () => {
    if (token && token.until > Date.now()) return token.value;
    const basic = Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', { method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }) });
    const d = await r.json();
    if (!r.ok || !d.access_token) throw new Error('APS token failed');
    token = { value: d.access_token, until: Date.now() + (Math.min(d.expires_in ?? 3600, 3600) - 300) * 1000 };
    return token.value;
  };
  const started = Date.now();
  const source = await openSvfSource({ urn, getToken, region: env.APS_REGION || 'US', dir: path.join(env.RUNNER_TEMP || os.tmpdir(), `svf-${prefix}`),
    log: console.log });
  let origin = knownOrigin;
  if (!origin) {
    // Converter origin (tiles = SVF world − origin): objects with one fragment vote, from original tiles spread over
    // the scope until 50 have voted (the first 12 tiles of the site had 5; 12 tiles around 949 had 376).
    const scope = tiles.map((t, i) => i).filter(i => (!region || region.has(i)) && /^[\w.-]+\.xkt$/.test(tiles[i].n ?? ''));
    const sample = [], picks = Math.min(scope.length, 48);
    let est = null;
    for (let k = 0; k < picks && !(est?.samples >= 50); k++) {
      const xkt = await getBytes(`${prefix}/xkt/${tiles[scope[Math.floor((k + 0.5) * scope.length / picks)]].n}`);
      if (xkt) sample.push(xktEntityBoxes(xkt));
      est = estimateOrigin(sample, source.fragments);
    }
    // Rotated single fragments vote off (their source box is looser than the tile's): 193 of 213 agreed in 12 tiles, 39
    // of 50 over the site. A wrong origin is off by whole metres for every object, and the vertex check refuses it anyway.
    if (!est || est.samples < 10 || est.votes < est.samples * 0.6) throw new Error(`No consistent converter origin: ${JSON.stringify(est)}`);
    origin = est.origin;
    console.log(`SVF origin ${origin.join(',')} (${est.votes}/${est.samples} single-fragment objects agree); source ready in ${Math.round((Date.now() - started) / 1000)} s`);
  } else console.log(`SVF origin ${origin.join(',')} (from the plan); source ready in ${Math.round((Date.now() - started) / 1000)} s`);
  const candidatesOf = fragmentMatcher(source.fragments, origin);
  const fb = source.fragments.boxes, fragmentCount = source.fragments.db.length;
  const around = (f, b) => [0, 1, 2].every(a => { const c = (fb[f * 6 + a] + fb[f * 6 + a + 3]) / 2 - origin[a]; return c >= b[a] && c <= b[a + 3]; });
  // Per built tile: its statistics, the fragments its entities took (with the match score), its objects and its box.
  const perTile = new Map();
  const byTile = () => [...perTile].sort((p, q) => p[0] - q[0]); // the parts meet at finalize: tile order, not build order
  // Object → the colour of one of its meshes (for fragments added to a tile), from the lowest tile holding it.
  const colourOf = new Map(), colourTile = new Map();
  // Fragment boxes (tiles' frame) on a 20 m grid, for the skins' partners; fragments over 4,096 cells are checked always.
  const GRID = 20;
  const cellsOf = (b, pad) => {
    const lo = [0, 1, 2].map(a => Math.floor((b[a] - pad) / GRID)), hi = [0, 1, 2].map(a => Math.floor((b[a + 3] + pad) / GRID));
    const out = [];
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) out.push(`${x},${y},${z}`);
    return out;
  };
  let fragmentGrid = null;
  const gridOf = () => {
    const cells = new Map(), big = [];
    for (let f = 0; f < fragmentCount; f++) {
      const b = [0, 1, 2, 3, 4, 5].map(k => fb[f * 6 + k] - origin[k % 3]);
      if (!b.every(Number.isFinite)) continue;
      const span = [0, 1, 2].map(a => Math.floor(b[a + 3] / GRID) - Math.floor(b[a] / GRID) + 1);
      if (span[0] * span[1] * span[2] > 4096) { big.push(f); continue; }
      for (const k of cellsOf(b, 0)) { const l = cells.get(k); if (l) l.push(f); else cells.set(k, [f]); }
    }
    return { cells, big };
  };
  const bins = [1, 5, 10, 20, 50];
  return {
    origin,
    /**
     * Exact triangles for tile i's entities; `dbIds` (per entity) is corrected in place to each matched fragment's
     * object. `fix`: { exclude: fragments this tile must not take, extras: fragments it adds (lost in the conversion) }.
     */
    async refine(i, xkt, meshes, dbIds, fix = null) {
      const file = xktEntityBoxes(xkt);
      const allowed = list => (fix?.exclude.size ? list.filter(f => !fix.exclude.has(f)) : list);
      let candidates = candidatesOf(file, dbIds).map(allowed);
      const extras = fix?.extras ?? [];
      const pieces = await source.pieces([...new Set([...candidates.flat(), ...extras])], origin);
      let { meshes: out, owner, score, stats: s } = refineMeshes(meshes, candidates, file.steps, f => pieces.get(f));
      if (s.misses.length) {
        // A wider look for the entities left: the placed ones keep their fragment, the rest get more candidates.
        const owned = new Set([...owner].filter(f => f >= 0)), left = new Set(s.misses.map(m => m.entity));
        const wider = candidatesOf(file, dbIds, left).map(list => allowed(list).filter(f => !owned.has(f)));
        candidates = candidates.map((list, e) => (owner[e] >= 0 ? [owner[e]] : wider[e]));
        for (const [f, piece] of await source.pieces([...new Set(wider.flat())].filter(f => !pieces.has(f)), origin)) pieces.set(f, piece);
        ({ meshes: out, owner, score, stats: s } = refineMeshes(meshes, candidates, file.steps, f => pieces.get(f)));
      }
      const took = new Map();
      let relabelled = 0, added = 0;
      owner.forEach((f, e) => {
        if (f < 0) return;
        took.set(f, score[e]);
        if (source.fragments.db[f] !== dbIds[e]) { dbIds[e] = source.fragments.db[f]; relabelled++; }
      });
      for (const m of meshes) {
        const d = dbIds[m.entity];
        if (d > 0 && !(colourTile.get(d) <= i)) { colourOf.set(d, meshColour(m)); colourTile.set(d, i); }
      }
      // Fragments the conversion lost, as entities of their own.
      for (const f of extras) {
        const piece = pieces.get(f);
        if (!piece || took.has(f)) continue;
        const d = source.fragments.db[f];
        out.push({ entity: dbIds.length, world: piece.pos, tri: piece.idx, rgba: colourOf.get(d) ?? [200, 200, 200, 255], textured: false });
        dbIds.push(d);
        took.set(f, 0);
        added++;
      }
      const misses = s.misses.map(m => ({ tile: i, id: file.ids[m.entity], dbId: dbIds[m.entity], size: [0, 1, 2].map(a => +(file.boxes[m.entity * 6 + a + 3] - file.boxes[m.entity * 6 + a]).toFixed(2)),
        triangles: meshes.filter(x => x.entity === m.entity).reduce((n, x) => n + x.tri.length / 3, 0), candidates: m.candidates, bestFit: m.bestFit, fitTaken: m.fitTaken }));
      perTile.set(i, { s, relabelled, added, took, misses, objects: new Set(dbIds.filter(d => d > 0)), box: tiles[i].aabb });
      return out;
    },
    /** Totals over the built tiles (a rebuilt tile counts once). */
    totals() {
      const t = { origin, tiles: perTile.size, entities: 0, matched: 0, replaced: 0, rejected: 0, noCandidate: 0, noMesh: 0, relabelled: 0,
        added: 0, trianglesBefore: 0, trianglesAfter: 0, shiftMm: Object.fromEntries([...bins.map(b => [`<=${b}`, 0]), ['more', 0]]), maxShiftMm: 0,
        downloadedMB: source.downloadedMB + downloadedBefore };
      for (const [, r] of byTile()) {
        for (const k of ['entities', 'matched', 'replaced', 'rejected', 'noCandidate', 'noMesh', 'trianglesBefore', 'trianglesAfter']) t[k] += r.s[k];
        t.relabelled += r.relabelled; t.added += r.added;
        for (const mm of r.s.shiftMm) {
          const b = bins.find(x => mm <= x);
          t.shiftMm[b ? `<=${b}` : 'more']++;
          t.maxShiftMm = Math.max(t.maxShiftMm, mm);
        }
      }
      t.kept = byTile().flatMap(([, r]) => r.misses).slice(0, 60); // entities kept as decoded, for the log
      return t;
    },
    /**
     * Opaque objects of the whole model near a tile's group, as one group in the tiles' frame (the tile's own objects
     * left out): the skins its objects may lie on (scripts/skins.mjs). A fragment counts when its box comes within
     * `reach` of the box of one of the group's objects.
     */
    async partners(group, reach) {
      const own = new Map();
      for (let v = 0; v < group.ids.length; v++) {
        const id = group.ids[v];
        let b = own.get(id);
        if (!b) own.set(id, (b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]));
        for (let a = 0; a < 3; a++) { const x = group.pos[v * 3 + a]; if (x < b[a]) b[a] = x; if (x > b[a + 3]) b[a + 3] = x; }
      }
      fragmentGrid ??= gridOf();
      const picked = new Set();
      for (const b of own.values()) {
        for (const list of [fragmentGrid.big, ...cellsOf(b, reach).map(k => fragmentGrid.cells.get(k) ?? [])]) for (const f of list) {
          if (picked.has(f) || own.has(source.fragments.db[f]) || !source.visible(f) || source.transparent(f)) continue;
          if ([0, 1, 2].every(a => fb[f * 6 + a] - origin[a] <= b[a + 3] + reach && fb[f * 6 + a + 3] - origin[a] >= b[a] - reach)) picked.add(f);
        }
      }
      const pieces = [...(await source.pieces([...picked], origin))].filter(([, piece]) => piece);
      let nv = 0, ni = 0;
      for (const [, piece] of pieces) { nv += piece.pos.length / 3; ni += piece.idx.length; }
      const out = { pos: new Float64Array(nv * 3), ids: new Float32Array(nv), idx: new Uint32Array(ni) };
      let v0 = 0, i0 = 0;
      for (const [f, piece] of pieces) {
        const n = piece.pos.length / 3;
        out.pos.set(piece.pos, v0 * 3); out.ids.fill(source.fragments.db[f], v0, v0 + n);
        for (let k = 0; k < piece.idx.length; k++) out.idx[i0 + k] = piece.idx[k] + v0;
        v0 += n; i0 += piece.idx.length;
      }
      return out;
    },
    /**
     * Visible fragments no built tile took (lost in the conversion: holes) — of objects that have entities in the
     * original tiles (the terrain is in the base files), inside a built tile's box — and fragments two tiles took.
     */
    audit() {
      const takers = new Map(), seen = new Set(), boxes = [];
      for (const [i, r] of byTile()) {
        for (const [f, score] of r.took) { const l = takers.get(f); if (l) l.push({ tile: i, score }); else takers.set(f, [{ tile: i, score }]); }
        for (const d of r.objects) seen.add(d);
        boxes.push(r.box);
      }
      const missing = [], twice = new Map();
      for (let f = 0; f < fragmentCount; f++) {
        const t = takers.get(f);
        if (t?.length > 1) twice.set(f, t);
        else if (!t && source.visible(f) && seen.has(source.fragments.db[f]) && boxes.some(b => around(f, b))) missing.push(f);
      }
      return { missing, twice };
    },
    /** The built tile for a lost fragment: the smallest box around its centre, among tiles holding its object if any. */
    homeOf(f) {
      const d = source.fragments.db[f];
      let best = -1, bestVolume = Infinity, any = -1, anyVolume = Infinity;
      for (const [i, r] of byTile()) {
        if (!around(f, r.box)) continue;
        const b = r.box, volume = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
        if (r.objects.has(d) && volume < bestVolume) { best = i; bestVolume = volume; }
        if (volume < anyVolume) { any = i; anyVolume = volume; }
      }
      return best >= 0 ? best : any;
    },
    /** Fragments, triangles, area and the objects with the most area, for a list of fragments (lines and points skipped). */
    async measure(list) {
      const per = new Map();
      let fragments = 0, triangles = 0, area = 0;
      for (let k = 0; k < list.length; k += 20000) {
        for (const [f, piece] of await source.pieces(list.slice(k, k + 20000), origin)) {
          if (!piece) continue;
          let a = 0;
          for (let t = 0; t < piece.idx.length; t += 3) {
            const [i, j, l] = [piece.idx[t] * 3, piece.idx[t + 1] * 3, piece.idx[t + 2] * 3], p = piece.pos;
            const u = [p[j] - p[i], p[j + 1] - p[i + 1], p[j + 2] - p[i + 2]], w = [p[l] - p[i], p[l + 1] - p[i + 1], p[l + 2] - p[i + 2]];
            a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
          }
          fragments++; triangles += piece.idx.length / 3; area += a;
          const db = source.fragments.db[f];
          per.set(db, (per.get(db) ?? 0) + a);
        }
      }
      const top = [...per].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([db, a]) => [db, Math.round(a * 10) / 10]);
      return { fragments, triangles, areaM2: Math.round(area), objects: per.size, top };
    },
    /** What a part hands to finalize: the tiles' matching records and the object colours. */
    exportState() {
      return { perTile: byTile().map(([i, r]) => [i, { ...r, took: [...r.took], objects: [...r.objects] }]), colourOf: [...colourOf].map(([d, c]) => [d, c, colourTile.get(d)]),
        downloadedMB: source.downloadedMB };
    },
    /** The parts' records (a tile built twice keeps the later part's, as a rebuild does). */
    importState(states) {
      for (const state of states) {
        if (!state) continue;
        for (const [i, r] of state.perTile) perTile.set(i, { ...r, took: new Map(r.took), objects: new Set(r.objects) });
        for (const [d, c, i] of state.colourOf) if (!(colourTile.get(d) <= i)) { colourOf.set(d, c); colourTile.set(d, i); }
        downloadedBefore += state.downloadedMB ?? 0;
      }
    },
  };
}
let svf = null, downloadedBefore = 0; // MB the parts' sources downloaded (finalize)

/**
 * Tile i's original level under its simplified copies, as a leaf (null: no original). `fix` (SVF audit) rebuilds a
 * tile: its counts go to a scratch record, the first build's stay in the statistics.
 */
async function buildOriginal(i, fix = null) {
  const original = await load(i, tiles[i].n, true, fix);
  if (!original) return null;
  const sink = fix ? { detail: { files: 0, triangles: 0, bytes: 0, vertices: 0, weldedVertices: 0 },
    mid: Object.fromEntries(MID_ERRORS.map(e => [e, { files: 0, triangles: 0, bytes: 0, skipped: 0, lockedVertices: 0 }])) } : stats;
  // One vertex per position: the simplifier needs connected surfaces.
  const groups = { opaque: weldGroup(original.opaque), transparent: weldGroup(original.transparent) };
  sink.detail.vertices += (original.opaque?.ids.length ?? 0) + (original.transparent?.ids.length ?? 0);
  sink.detail.weldedVertices += (groups.opaque?.ids.length ?? 0) + (groups.transparent?.ids.length ?? 0);
  // Faces on the skin of an object holding them are drawn behind it (scripts/skins.mjs); faces on a skin shared with
  // another object (either side) stay in place in the copies, as near ones do below.
  let shared = null;
  if (svf && groups.opaque) {
    const started = Date.now(), partners = await svf.partners(groups.opaque, SKIN_REACH), judged = Date.now();
    const skins = await containedSkins(groups.opaque, partners);
    const applied = applySkins(groups.opaque, skins.partner, skins.shared);
    groups.opaque = applied.group; shared = applied.lock;
    if (!fix) {
      const st = stats.skins;
      st.tiles++; st.pairs += skins.pairs; st.partnerTriangles += partners.idx.length / 3;
      st.seconds += (Date.now() - started) / 1000; st.partnerSeconds += (judged - started) / 1000;
      for (const p of skins.partner) if (p > 0) st.pushed++;
      for (const x of skins.shared) if (x) st.shared++;
    }
  }
  growObjects(groups.opaque); growObjects(groups.transparent);
  const detail = await write(groups, `d${i}`, sink.detail);
  if (!detail) return null;
  let top = { bounds: detail.bounds, content: `c/d${i}.glb`, error: 0, children: [] }, topGroups = groups, topTriangles = detail.triangles;
  // Vertices nearer another object than a copy's error stay in place in that copy (scripts/clearance.mjs): layers a
  // few centimetres apart cut through each other once both are simplified (tunnel portal shotcrete over its lining).
  const [nearOpaque, nearTransparent] = await nearOther([groups.opaque, groups.transparent], MID_ERRORS);
  for (const [k, error] of [...MID_ERRORS.entries()].reverse()) {
    const s = sink.mid[error];
    // Borders locked and every triangle kept: objects are patches whose seams do not share vertices (tile 931: 85 %
    // of edges shared), and patches simplified on their own opened cracks along the seams that showed the layer
    // under them as white streaks (user screenshot, 0.1 m copy at 115 m: 42 hole pixels vs 21 in the original,
    // locked 20). Long thin triangles along locked borders are part of the surface, not slivers.
    const lockOf = (near, keep = null) => {
      if (!near) return null;
      const lock = new Uint8Array(near.length);
      for (let v = 0; v < near.length; v++) if (near[v] < error || keep?.[v]) { lock[v] = 1; s.lockedVertices++; }
      return lock;
    };
    const copyOf = (g, near, keep) => simplifyGroup(g, error, { minHeight: 0, lockBorder: true, lock: lockOf(near, keep) });
    const mid = { opaque: await copyOf(groups.opaque, nearOpaque, shared), transparent: await copyOf(groups.transparent, nearTransparent) };
    const n = triangles(mid.opaque) + triangles(mid.transparent);
    const out = n && n <= MID_ENOUGH * topTriangles ? await write(mid, `m${k}-${i}`, s) : null;
    if (!out) { s.skipped++; continue; }
    top = { bounds: union(out.bounds, top.bounds), content: `c/m${k}-${i}.glb`, error, children: [top] };
    topGroups = mid; topTriangles = out.triangles;
  }
  return { key: i, centre: centreOf(top.bounds), ...top, groups: topGroups };
}
const union = (a, b) => [0, 1, 2].map(k => Math.min(a[k], b[k])).concat([3, 4, 5].map(k => Math.max(a[k], b[k])));

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function planStage(parts) {
  run = previous ? previous.current.run : `runs/${randomUUID()}`;
  let origin = null;
  if (svfMode && !reuse) { svf = await openSvf(null); origin = svf.origin; }
  // The parts upload as they go: the room is checked up front, for a run the size of the published one (+10 %).
  if (!localDir) {
    const published = await getJson(`${prefix}/${OUT}/current.json`);
    const expected = reuse ? 100_000_000 : Math.round((published?.bytes ?? 2_500_000_000) * 1.1);
    const budget = await checkStorageBudget(tok => client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) })), expected);
    console.log(`Storage: ${(budget.bytes / 1e9).toFixed(2)} GB now, ${(budget.projectedBytes / 1e9).toFixed(2)} GB with a run like the published one (limit ${(budget.limit / 1e9).toFixed(1)} GB; the previous run is removed afterwards)`);
  }
  const items = tiles.map((t, i) => ({ key: i, centre: Array.isArray(t.aabb) ? centreOf(t.aabb) : [0, 0, 0] }));
  const plan = { v: 1, run, origin, parts: partition(items, parts, Number(env.TILES3D_CHUNK) || 16) };
  fs.writeFileSync(planFile, JSON.stringify(plan));
  if (STAGE === 'plan' && env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `parts=${JSON.stringify(plan.parts.map((_, k) => k))}\n`);
  console.log(`Plan: ${run}, ${plan.parts.length} part(s) of ${plan.parts.map(p => p.length).join('/')} tiles`);
  return plan;
}

// ── leaves ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Per tile, the original under its simplified copies (finest first, each kept when it saves enough); the coarsest is the
// leaf and carries its groups for the parents. No original (or outside a test region): the far file.
async function leavesStage(plan, part) {
  const list = plan.parts[part];
  const leaves = [], fd = fs.openSync(partFile(part, 'groups'), 'w');
  let next = 0, done = 0;
  const progress = () => {
    if (++done % 100 === 0) console.log(`Leaves ${done}/${list.length} · far ${MB(stats.far.bytes)} MB · ${MID_ERRORS.map(e => `${e} m ${MB(stats.mid[e].bytes)} MB`).join(' · ')} · detail ${MB(stats.detail.bytes)} MB${svf ? (t => ` · SVF ${t.replaced}/${t.entities} entities (${t.relabelled} owners corrected), ${t.downloadedMB} MB`)(svf.totals()) : ''}${svf ? ` · skins ${stats.skins.pushed} pushed, ${Math.round(stats.skins.seconds)} s (partners ${Math.round(stats.skins.partnerSeconds)} s)` : ''}`);
  };
  const keep = leaf => { writeGroups(fd, leaf.key, leaf.groups); delete leaf.groups; leaves.push(leaf); };
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let n = next++; n < list.length; n = next++) {
      const i = list[n], t = tiles[i];
      if (reuse) {
        // Parents are rebuilt from the far files (the copies are not decoded back).
        const kept = reusedLeaves.get(i);
        const groups = kept && validFar(t) ? await load(i, t.far.n) : null;
        if (kept) keep({ key: i, centre: centreOf(kept.bounds), bounds: kept.bounds, groups, content: kept.content, error: kept.error, childrenJson: kept.children });
        progress();
        continue;
      }
      const leaf = (!region || region.has(i)) && /^[\w.-]+\.xkt$/.test(t.n ?? '') ? await buildOriginal(i) : null;
      if (leaf) { keep(leaf); progress(); continue; }
      if (!validFar(t)) { progress(); continue; }
      const farGroups = await load(i, t.far.n);
      const far = farGroups && await write(farGroups, `f${i}`, 'far');
      if (far) {
        growObjects(farGroups.opaque); growObjects(farGroups.transparent);
        keep({ key: i, centre: centreOf(far.bounds), bounds: far.bounds, groups: farGroups, content: `c/f${i}.glb`, error: 0, children: [] });
      }
      progress();
    }
  }));
  fs.closeSync(fd);
  await flushUploads();
  fs.writeFileSync(partFile(part, 'boxes'), Buffer.from(objectBoxes.buffer, objectBoxes.byteOffset, objectBoxes.byteLength));
  fs.writeFileSync(partFile(part, 'json'), JSON.stringify({ v: 1, part, run, leaves, written: [...written],
    stats: { far: stats.far, detail: stats.detail, mid: stats.mid, skins: stats.skins }, svf: svf?.exportState() ?? null }));
  console.log(`Part ${part}: ${leaves.length} leaves, ${written.size} files, ${MB(writtenBytes())} MB`);
}

// ── finalize ──────────────────────────────────────────────────────────────────────────────────────────────────────
const add = (into, from) => { for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + v; else if (v && typeof v === 'object') add(into[k] ??= {}, v); };
async function finalizeStage(plan) {
  const parts = plan.parts.map((_, k) => JSON.parse(fs.readFileSync(partFile(k, 'json'), 'utf8')));
  const leaves = [];
  const fresh = freshStats();
  for (const [k, p] of parts.entries()) {
    if (p.run !== run) throw new Error(`Part ${k} belongs to ${p.run}, not ${run}`);
    for (const key of ['far', 'detail', 'mid', 'skins']) add(fresh[key], p.stats[key]);
    for (const [rel, w] of p.written) written.set(rel, w);
    const boxes = fs.readFileSync(partFile(k, 'boxes'));
    mergeBoxes(objectBoxes, new Float32Array(boxes.buffer.slice(boxes.byteOffset, boxes.byteOffset + boxes.byteLength)));
    const groups = readGroups(partFile(k, 'groups'));
    for (const leaf of p.leaves) leaves.push({ ...leaf, groups: groups.get(leaf.key) });
  }
  for (const key of ['far', 'detail', 'mid', 'skins']) stats[key] = fresh[key];
  if (svf) {
    if (STAGE !== 'all') svf.importState(parts.map(p => p.svf)); // (one process: its source has them already)
    // Second pass over the few tiles the audit points at, before the parents are built from the leaves. A rebuilt tile's
    // files that the rebuild does not write again (a copy it no longer keeps) are deleted.
    const rebuild = async (i, fix) => {
      const before = [...written.keys()].filter(k => k === `c/d${i}.glb` || new RegExp(`^c/m\\d+-${i}\\.glb$`).test(k));
      for (const k of before) written.delete(k);
      const leaf = await buildOriginal(i, fix), at = leaves.findIndex(l => l.key === i);
      if (leaf) { if (at >= 0) leaves[at] = leaf; else leaves.push(leaf); } else if (at >= 0) leaves.splice(at, 1);
      await flushUploads();
      const stale = before.filter(k => !written.has(k));
      if (stale.length) await removeKeys(stale.map(k => `${prefix}/${OUT}/${run}/${k}`));
    };
    let plan2 = svf.audit();
    const first = { missing: plan2.missing.length, twice: plan2.twice.size };
    // A fragment two tiles took stays with the better match; the others choose again without it.
    const exclude = new Map();
    for (const [f, takers] of plan2.twice) {
      takers.sort((a, b) => b.score - a.score);
      for (const { tile } of takers.slice(1)) { const set = exclude.get(tile); if (set) set.add(f); else exclude.set(tile, new Set([f])); }
    }
    for (const [i, set] of exclude) await rebuild(i, { exclude: set, extras: [] });
    // Fragments the conversion lost go to the tile holding their object around them. Whole site only: in a region build
    // the tiles around it (far files only) own fragments inside the region's overlapping boxes.
    plan2 = svf.audit();
    const extras = new Map();
    if (!region) for (const f of plan2.missing) { const home = svf.homeOf(f); if (home >= 0) { const l = extras.get(home); if (l) l.push(f); else extras.set(home, [f]); } }
    for (const [i, list] of extras) await rebuild(i, { exclude: exclude.get(i) ?? new Set(), extras: list });
    plan2 = svf.audit();
    stats.svf = { ...svf.totals(), firstPass: first, rebuiltTiles: new Set([...exclude.keys(), ...extras.keys()]).size,
      missing: await svf.measure(plan2.missing), twice: await svf.measure([...plan2.twice.keys()]) };
    console.log('SVF', JSON.stringify(stats.svf));
  }
  console.log('Leaves', JSON.stringify({ far: stats.far, mid: stats.mid, detail: stats.detail, skins: stats.skins }));

  // Coarser levels: merge each group of ≤8 children and simplify with a larger absolute error.
  let parentId = 0;
  async function build(node, depth) {
    if (node.content) return node; // a tile's leaf, possibly with finer levels under it
    const kids = [];
    for (const child of node.children) kids.push(await build(child, depth + 1));
    const childError = Math.max(...kids.map(k => k.error));
    let error = Math.min(Math.max(childError * PARENT_FACTOR, FAR_ERROR), MAX_PARENT_ERROR), opaque, transparent, out;
    const mergedOpaque = mergeGroups(kids.map(k => k.groups?.opaque)), mergedTransparent = mergeGroups(kids.map(k => k.groups?.transparent));
    // A level must show something: if the error prunes everything, retry finer (down to the children's own error).
    for (;;) {
      opaque = await simplifyGroup(mergedOpaque, error);
      transparent = await simplifyGroup(mergedTransparent, error);
      out = await encodeGlb({ opaque, transparent });
      if (out || error <= childError) break;
      error = Math.max(childError, error / PARENT_FACTOR);
    }
    for (const k of kids) delete k.groups; // merged into this level; children keep only their tileset entry
    const id = parentId++;
    const content = out ? `c/h${id}.glb` : null;
    if (out) await upload(content, out.glb);
    const level = (stats.parents[depth] ??= { nodes: 0, triangles: 0, bytes: 0, error });
    level.nodes++; level.triangles += out?.triangles ?? 0; level.bytes += out?.glb.length ?? 0;
    const bounds = [0, 1, 2].map(a => Math.min(...kids.map(k => k.bounds[a]))).concat([3, 4, 5].map(a => Math.max(...kids.map(k => k.bounds[a]))));
    return { bounds, content, error, groups: { opaque, transparent }, children: kids };
  }
  // Tile order (groupSpatially sorts any list over 8; up to 8 it keeps the order given, which was the build's).
  leaves.sort((a, b) => a.key - b.key);
  const structures = await build(groupSpatially(leaves, 8), 0);
  console.log('Parents', JSON.stringify(stats.parents));

  // Terrain: one leaf per aerial photo, then parents (same photos, simplified surface) up to one root.
  const terrainLeaves = [];
  const textures = []; // KTX2 bytes, indexed across all base files
  for (const [b, name] of (Array.isArray(base) && !reuse ? base : []).entries()) {
    if (!/^[\w.-]+\.xkt$/.test(name)) continue;
    const xkt = await getBytes(`${prefix}/xkt/${name}`);
    const decoded = xkt && decodeXkt(xkt, { textures: true });
    if (!decoded?.meshes.length) continue;
    const offset = textures.length;
    textures.push(...decoded.textures);
    for (const part of packTerrain(decoded.meshes).values()) {
      part.texture += offset;
      const out = await encodeTerrainGlb([part], textures);
      if (!out) continue;
      const k = terrainLeaves.length;
      await upload(`c/t${k}.glb`, out.glb);
      Object.assign(stats.terrain, { leaves: stats.terrain.leaves + 1, triangles: stats.terrain.triangles + out.triangles, bytes: stats.terrain.bytes + out.glb.length });
      terrainLeaves.push({ key: k, centre: centreOf(out.bounds), bounds: out.bounds, parts: [part], content: `c/t${k}.glb`, error: 0, children: [] });
    }
    console.log(`Terrain ${name} (base ${b}): ${decoded.meshes.length} patches, ${decoded.textures.filter(Boolean).length} photos`);
  }
  stats.terrain.textures = textures.filter(Boolean).length;
  stats.terrain.textureBytes = textures.reduce((n, t) => n + (t?.length ?? 0), 0);
  let terrainId = 0;
  async function buildTerrain(node, depth) {
    if (node.content) return node;
    const kids = [];
    for (const child of node.children) kids.push(await buildTerrain(child, depth + 1));
    const error = Math.max(...kids.map(k => k.error || TERRAIN_ERROR / PARENT_FACTOR)) * PARENT_FACTOR;
    const parts = [];
    for (const k of kids) for (const part of k.parts) parts.push(await simplifyTerrain(part, error));
    for (const k of kids) delete k.parts;
    const out = await encodeTerrainGlb(parts, textures);
    const content = out ? `c/g${terrainId++}.glb` : null;
    if (out) await upload(content, out.glb);
    const level = (stats.terrain.parents[depth] ??= { nodes: 0, triangles: 0, bytes: 0, error });
    level.nodes++; level.triangles += out?.triangles ?? 0; level.bytes += out?.glb.length ?? 0;
    const bounds = [0, 1, 2].map(a => Math.min(...kids.map(k => k.bounds[a]))).concat([3, 4, 5].map(a => Math.max(...kids.map(k => k.bounds[a]))));
    return { bounds, content, error, parts, children: kids };
  }
  const terrain = terrainLeaves.length ? await buildTerrain(groupSpatially(terrainLeaves, 8), 0) : null;
  if (terrain) delete terrain.parts;
  console.log('Terrain', JSON.stringify(stats.terrain));

  // One tileset: an empty root (always refined) over the structures and the terrain, each tagged for the viewer.
  const toJson = (node, part) => ({
    boundingVolume: boxVolume(node.bounds), geometricError: node.error, refine: 'REPLACE',
    ...(node.content ? { content: { uri: node.content } } : {}),
    ...(node.childrenJson?.length ? { children: node.childrenJson }
      : node.children?.length ? { children: node.children.map(c => toJson(c, part)) } : {}),
    ...(part ? { extras: { mir: part } } : {}),
  });
  const terrainJson = terrain ? toJson(terrain, 'terrain') : previous?.tileset.root.children?.find(c => c.extras?.mir === 'terrain') ?? null;
  const fromBox = v => { const [cx, cy, cz, hx, , , , hy, , , , hz] = v.box; return [cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz]; };
  const top = [structures.bounds, terrainJson && fromBox(terrainJson.boundingVolume)].filter(Boolean);
  const rootBounds = [0, 1, 2].map(a => Math.min(...top.map(b => b[a]))).concat([3, 4, 5].map(a => Math.max(...top.map(b => b[a]))));
  const tileset = { asset: { version: '1.1', generator: 'MIR build-tiles3d' }, geometricError: 1e6,
    root: { boundingVolume: boxVolume(rootBounds), geometricError: 1e6, refine: 'REPLACE',
      children: [toJson(structures, 'structure'), ...(terrainJson ? [terrainJson] : [])] },
    extras: { mir: { objects: objectCount, detail: region ? { region: region.size } : 'all', terrain: !!terrainJson,
      ...(stats.svf ? { precise: 'svf' } : {}) } } };
  await upload('tileset.json', gzipSync(JSON.stringify(tileset)));
  if (!reuse) {
    for (let k = 0; k < objectCount * 6; k++) if (!Number.isFinite(objectBoxes[k])) objectBoxes[k] = NaN;
    await upload('objects.bin', gzipSync(Buffer.from(objectBoxes.buffer)));
  }
  await flushUploads();
  const total = writtenBytes();
  console.log(`Tileset: ${written.size} files, ${MB(total)} MB; structure root ${triangles(structures.groups?.opaque) + triangles(structures.groups?.transparent)} triangles`);
  delete structures.groups;

  // compare=1: every file of the published run against this one's (SHA-256), before this one replaces it; compare=strict:
  // and nothing is published unless they are all the same (a restructured build checked against the last one).
  const compare = /(?:^|,)\s*compare=(1|strict)\b/.exec(env.DIAG_OPTIONS || '')?.[1];
  if (compare) {
    const result = await compareWithPublished();
    if (compare === 'strict' && result && (result.differ || result.gone || result.added))
      throw new Error('compare=strict: this run differs from the published one; not published (its files stay under its run until the next build)');
  }

  // Reuse: the run keeps its leaves; old coarser levels this build no longer has are dropped from the list (and below).
  const kept = previous ? previous.current.files.filter(f => !/^c\/h\d+\.glb$/.test(f) && !written.has(f)) : [];
  const published = [...kept, ...written.keys()];
  const publishedStats = previous ? { ...previous.current.stats, parents: stats.parents } : stats;
  const bytes = previous ? previous.current.bytes + total : total; // after a reuse: an upper bound (old parents counted)
  await client.send(new PutObjectCommand({ Bucket, Key: `${prefix}/${OUT}/current.json`, ContentType: 'application/json',
    Body: JSON.stringify({ v: 1, run, files: published, bytes, builtAt: new Date().toISOString(), stats: publishedStats }) }));
  console.log(`Published ${prefix}/${OUT}/${run}${previous ? ' (coarser levels rebuilt in place)' : ''}`);
  if (previous) {
    const keep = new Set(published);
    await removeKeys(previous.current.files.filter(f => !keep.has(f)).map(f => `${prefix}/${OUT}/${run}/${f}`));
  }
  const old = [];
  let tok;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/${OUT}/runs/`, MaxKeys: 1000, ...(tok ? { ContinuationToken: tok } : {}) }));
    for (const o of page.Contents ?? []) if (!o.Key.startsWith(`${prefix}/${OUT}/${run}/`)) old.push(o.Key);
    tok = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (tok);
  console.log(`Done, removed ${await removeKeys(old)} old files`);
}

/** Files of the published run: the same, different, gone or new in this run (the stats left aside). */
async function compareWithPublished() {
  const current = await getJson(`${prefix}/${OUT}/current.json`);
  if (!current?.run || current.run === run) { console.log('Compare: no other published run'); return null; }
  const same = [], differ = [], gone = [];
  const names = current.files.filter(f => f !== 'current.json');
  for (let k = 0; k < names.length; k += 16) await Promise.all(names.slice(k, k + 16).map(async rel => {
    const mine = written.get(rel);
    if (!mine) { gone.push(rel); return; }
    // The store's body, as uploaded (gzip kept: getBytes would unpack tileset.json and objects.bin).
    const r = await retrying(() => store.send(new GetObjectCommand({ Bucket, Key: `${prefix}/${OUT}/${current.run}/${rel}` })));
    const hash = createHash('sha256').update(Buffer.from(await r.Body.transformToByteArray())).digest('hex');
    (hash === mine.hash ? same : differ).push(rel);
  }));
  const added = [...written.keys()].filter(rel => !current.files.includes(rel));
  const result = { same: same.length, differ: differ.length, gone: gone.length, added: added.length };
  console.log(`Compare with ${current.run}: ${same.length} same, ${differ.length} different, ${gone.length} gone, ${added.length} new`
    + (differ.length ? ` · different: ${differ.sort().slice(0, 30).join(' ')}` : '') + (gone.length ? ` · gone: ${gone.sort().slice(0, 30).join(' ')}` : '')
    + (added.length ? ` · new: ${added.sort().slice(0, 30).join(' ')}` : ''));
  return result;
}

const readPlan = () => {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (plan.v !== 1 || !/^runs\/[a-zA-Z0-9-]+$/.test(plan.run ?? '') || !Array.isArray(plan.parts)) throw new Error('Invalid build plan');
  run = plan.run;
  return plan;
};
if (STAGE === 'all') {
  const plan = await planStage(1);
  await leavesStage(plan, 0);
  await finalizeStage(plan);
} else if (STAGE === 'plan') {
  // parts=<n> in the diagnostic options, else TILES3D_PARTS (the workflow's default), at most 20 (concurrent jobs).
  const parts = Number(/(?:^|,)\s*parts=(\d+)/.exec(env.DIAG_OPTIONS || '')?.[1] || env.TILES3D_PARTS) || 1;
  await planStage(Math.max(1, Math.min(20, parts)));
} else if (STAGE === 'leaves') {
  const plan = readPlan(), part = Number(env.TILES3D_PART);
  if (!(part >= 0 && part < plan.parts.length)) throw new Error(`No part ${env.TILES3D_PART} in the plan`);
  if (svfMode) svf = await openSvf(plan.origin);
  await leavesStage(plan, part);
} else {
  const plan = readPlan();
  if (svfMode) svf = await openSvf(plan.origin);
  await finalizeStage(plan);
}
