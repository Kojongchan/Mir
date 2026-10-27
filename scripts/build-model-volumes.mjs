// Per-object volumes of one converted model, from its SVF geometry (4D/5D 물량 대사 — 산출서 수량 ↔ BIM). The model's own
// '체적' property is missing where it matters (연제교 RVT: 기초·교각·코핑 144 objects; the IFC export: every object), so the
// volume comes from the triangles: the divergence theorem per fragment (|Σ a·(b×c)| / 6, fragments are closed solids),
// placed at the object's own origin for precision, summed up the object tree (an element's geometry may sit on child
// nodes), scaled by the model's distance unit. Tested 10-23 on the 연제교 RVT: median 0.008 % from Revit's 체적, 92 %
// within ±1 % (docs/IPS_4D5D.md section 9). Read-only on APS; writes <prefix>/volumes/current.json (prefix = cacheKey(URN),
// the same key api/aps-props.ts reads): { v, urn, unit, scale, builtAt, objects, fragments, volumes: { externalId: m³ } }.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { openSvfSource } from './svf-precise.mjs';
import { buildMetaIndex } from './meta-index.mjs';
import { cacheKey } from './cache-key.mjs';

const env = process.env;
const APS = 'https://developer.api.autodesk.com';
const urn = env.URN || '';
if (!/^[A-Za-z0-9_-]+=*$/.test(urn)) throw new Error('URN input required (the model version URN, base64)');
const region = env.APS_REGION && env.APS_REGION !== 'US' ? env.APS_REGION : '';
const dir = env.VOLUMES_WORK || path.join(process.cwd(), 'volumes-work');
const prefix = cacheKey(urn);

let cached = null;
async function token() {
  if (cached && cached.until > Date.now()) return cached.value;
  const basic = Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${APS}/authentication/v2/token`, { method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }) });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('APS token failed');
  cached = { value: d.access_token, until: Date.now() + (d.expires_in - 120) * 1000 };
  return cached.value;
}
const apsHeaders = async () => ({ authorization: `Bearer ${await token()}`, ...(region ? { region } : {}) });

/** Metres per model unit (SVF metadata 'distance unit'). */
const UNIT = { m: 1, meter: 1, meters: 1, mm: 0.001, millimeter: 0.001, cm: 0.01, centimeter: 0.01, ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254 };

const t0 = Date.now();
const source = await openSvfSource({ urn, getToken: token, region: region || 'US', dir, log: m => console.log(m) });
// The SVF package (first file downloaded into dir) holds metadata.json with the distance unit.
const svfFile = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => /\.svf$/i.test(f));
let unit = 'm';
try { unit = String(JSON.parse(new AdmZip(svfFile).readAsText('metadata.json'))?.metadata?.['distance unit']?.value ?? 'm'); }
catch (e) { console.log(`metadata unreadable (${e.message}) — metres assumed`); }
const scale = UNIT[unit.toLowerCase()];
if (!scale) throw new Error(`Unknown distance unit ${unit}`);

// Property database: externalId per dbId and the object tree (parents).
const manifest = await (await fetch(`${APS}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { headers: await apsHeaders() })).json();
let svf = null;
const walk = d => { if (!svf && d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') svf = d; d.children?.forEach(walk); };
manifest.derivatives?.forEach(d => d.children?.forEach(walk));
const assets = JSON.parse(new AdmZip(svfFile).readAsText('manifest.json')).assets ?? [];
const base = svf.urn.slice(0, svf.urn.lastIndexOf('/') + 1);
const read = async type => {
  const asset = assets.find(a => a.type === `Autodesk.CloudPlatform.${type}`);
  if (!asset?.URI) throw new Error(`Property database asset missing: ${type}`);
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${APS}/derivativeservice/v2/derivatives/${encodeURIComponent(path.posix.normalize(path.posix.join(base, asset.URI)))}`, { headers: await apsHeaders() });
      if (!r.ok) throw new Error(`${type} ${r.status}`);
      return JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer()), { maxOutputLength: 2048 * 1048576 }).toString());
    } catch (e) { if (i >= 5) throw e; await new Promise(res => setTimeout(res, i * 3000)); }
  }
};
const db = { ids: await read('PropertyIDs'), offs: await read('PropertyOffsets'), avs: await read('PropertyAVs'),
  attrs: await read('PropertyAttributes'), vals: await read('PropertyValues') };
const { tree } = buildMetaIndex(db, { shardSize: 1 << 30 });

// Own volume per dbId (model units³), each object's fragments placed at its first fragment's corner.
const own = new Float64Array(tree.n);
const { byDb, boxes } = source.fragments;
let fragments = 0, open = 0;
const objects = [...byDb.keys()];
await source.prefetch([...byDb.values()].flat(), 16);
for (let k = 0; k < objects.length; k++) {
  const dbId = objects[k], list = byDb.get(dbId).filter(f => source.visible(f));
  if (!list.length || dbId <= 0 || dbId >= tree.n) continue;
  const origin = [boxes[list[0] * 6], boxes[list[0] * 6 + 1], boxes[list[0] * 6 + 2]];
  const meshes = await source.pieces(list, origin);
  for (const f of list) {
    const m = meshes.get(f);
    if (!m) continue;
    const { pos, idx } = m;
    let v = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    if (!idx.length) open++;
    own[dbId] += Math.abs(v) / 6;
    fragments++;
  }
  if (k % 500 === 0) console.log(`${k}/${objects.length} objects`);
}
// Up the tree: an element's volume includes its children's geometry.
const total = Float64Array.from(own);
for (let id = 1; id < tree.n; id++) {
  if (!own[id]) continue;
  for (let p = tree.parent[id], guard = 0; p > 0 && guard < 64; p = tree.parent[p], guard++) total[p] += own[id];
}
const volumes = {};
let named = 0;
for (let id = 1; id < tree.n; id++) {
  const ext = db.ids[id];
  if (!ext || !total[id]) continue;
  volumes[String(ext)] = Math.round(total[id] * scale ** 3 * 1e4) / 1e4;
  named++;
}
const body = JSON.stringify({ v: 1, urn, unit, scale, builtAt: new Date().toISOString(), objects: named, fragments, volumes });
console.log(`Volumes: ${named} objects, ${fragments} fragments (${open} without triangles), unit ${unit}, ${(body.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s`);
const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: `${prefix}/volumes/current.json`, Body: body, ContentType: 'application/json' }));
console.log(`Published ${prefix}/volumes/current.json`);

// Check: the keys api/aps-props.ts joins on — external IDs of the first 3D view's properties (Model Derivative).
try {
  const meta = await (await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata`, { headers: await apsHeaders() })).json();
  const views = (meta.data?.metadata ?? []).filter(v => v.role === '3d');
  const view = views.find(v => v.name === '{3D}') ?? views[0];
  const props = await (await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, { headers: await apsHeaders() })).json();
  const coll = props.data?.collection ?? [];
  const ext = coll.map(o => o.externalId).filter(Boolean);
  const hit = ext.filter(e => volumes[e] != null).length;
  console.log(`Join check: ${hit}/${ext.length} property objects have a volume`);
  console.log(`  ids: ${db.ids.length} entries, offsets ${db.offs.length}; first ${JSON.stringify(db.ids.slice(0, 4))}`);
  console.log(`  property sample ${JSON.stringify(coll.slice(0, 3).map(o => [o.objectid, o.externalId, db.ids[o.objectid]]))}`);
  console.log(`  volume keys sample ${JSON.stringify(Object.keys(volumes).filter(k => !/^\d+$/.test(k)).slice(0, 3))}`);
} catch (e) { console.log(`Join check skipped: ${e.message}`); }
