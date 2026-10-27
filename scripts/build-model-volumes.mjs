// Per-object volumes of one converted model, from its SVF geometry (4D/5D 물량 대사 — 산출서 수량 ↔ BIM). The model's own
// '체적' property is missing where it matters (연제교 RVT: 기초·교각·코핑 144 objects) and is checked against this where it is
// there. The volume comes from the triangles: the divergence theorem per closed fragment (|Σ a·(b×c)| / 6),
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

// Own volume per dbId (model units³): the object's fragments placed together at its first fragment's corner, signed
// volumes summed (a mirrored fragment's triangles wind the other way: its sign is turned), then the absolute value.
// Only a closed surface has a volume — every edge of the object's triangles (vertices welded by position, 0.1 mm)
// shared by an even number of them. An object with open geometry gets no volume (null upstream): an open surface's sum
// depends on where the origin is (10-27 연제교 IFC: girders 10× their 체적 when summed fragment by fragment).
const own = new Float64Array(tree.n);
const openObject = new Uint8Array(tree.n);
const { byDb, boxes } = source.fragments;
let closed = 0, opened = 0, fragments = 0;
const objects = [...byDb.keys()];
await source.prefetch([...byDb.values()].flat(), 16);
for (let k = 0; k < objects.length; k++) {
  const dbId = objects[k], list = byDb.get(dbId).filter(f => source.visible(f));
  if (!list.length || dbId <= 0 || dbId >= tree.n) continue;
  const origin = [boxes[list[0] * 6], boxes[list[0] * 6 + 1], boxes[list[0] * 6 + 2]];
  const meshes = await source.pieces(list, origin);
  const weld = new Map(), edges = new Map();
  let v = 0;
  for (const f of list) {
    const m = meshes.get(f);
    if (!m || !m.idx.length) continue;
    const { pos, idx } = m;
    const w = new Uint32Array(pos.length / 3);
    for (let i = 0; i < w.length; i++) {
      const key = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
      let id = weld.get(key);
      if (id === undefined) weld.set(key, (id = weld.size));
      w[i] = id;
    }
    let s = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      s += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
        - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
        + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
      for (const [p, q] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
        const x = w[p], y = w[q];
        if (x === y) continue;
        const e = x < y ? x * 4294967296 + y : y * 4294967296 + x;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    v += m.mirrored ? -s : s;
    fragments++;
  }
  let odd = edges.size === 0;
  for (const n of edges.values()) if (n % 2) { odd = true; break; }
  if (odd) { openObject[dbId] = 1; opened++; } else { own[dbId] = Math.abs(v) / 6; closed++; }
  if (k % 500 === 0) console.log(`${k}/${objects.length} objects`);
}
console.log(`Objects with geometry: ${closed} closed, ${opened} open (no volume) — ${fragments} fragments`);
// Up the tree: an element's volume includes its children's geometry.
const total = Float64Array.from(own);
const openBelow = Uint8Array.from(openObject);
for (let id = 1; id < tree.n; id++) {
  if (!own[id] && !openObject[id]) continue;
  for (let p = tree.parent[id], guard = 0; p > 0 && guard < 64; p = tree.parent[p], guard++) { total[p] += own[id]; if (openObject[id]) openBelow[p] = 1; }
}
// Keys: the external IDs api/aps-props.ts joins on — those of the Model Derivative properties of the first 3D view.
// They are not always the property database's own: an IFC translation stores path IDs there ('0/0/0/3/7') while the
// properties give the element's IfcGUID. Object → dbId: the same external ID in the database (Revit — the properties'
// objectid is not the dbId there), else the element whose IfcGUID property is that ID (IFC). Names are not used: many
// objects share one (184 bearings named '받침').
const byExt = new Map();
for (let id = 1; id < tree.n; id++) if (db.ids[id]) byExt.set(String(db.ids[id]), id);
const byGuid = new Map();
const guidAttrs = new Set(db.attrs.map((a, i) => (Array.isArray(a) && /^(IfcGUID|GlobalId)$/i.test(String(a[5] || a[0])) ? i : -1)).filter(i => i >= 0));
if (guidAttrs.size) {
  for (let id = 1; id < tree.n; id++) {
    const end = id === tree.n - 1 ? db.avs.length : 2 * db.offs[id + 1];
    for (let i = 2 * db.offs[id]; i < end; i += 2) if (guidAttrs.has(db.avs[i])) { byGuid.set(String(db.vals[db.avs[i + 1]]), id); break; }
  }
}
const volumes = {};
let named = 0;
const how = { ext: 0, guid: 0, none: 0 };
const meta = await (await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata`, { headers: await apsHeaders() })).json();
const views = (meta.data?.metadata ?? []).filter(v => v.role === '3d');
const view = views.find(v => v.name === '{3D}') ?? views[0];
const props = view && await (await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, { headers: await apsHeaders() })).json();
const collection = props?.data?.collection ?? [];
if (!collection.length) throw new Error('Model Derivative properties not ready — run again in a few minutes');
for (const o of collection) {
  if (!o.externalId) continue;
  let id = byExt.get(String(o.externalId));
  if (id) how.ext++;
  else if ((id = byGuid.get(String(o.externalId)))) how.guid++;
  else { how.none++; continue; }
  if (!total[id] || openBelow[id]) continue;
  volumes[String(o.externalId)] = Math.round(total[id] * scale ** 3 * 1e4) / 1e4;
  named++;
}
console.log(`Join: ${collection.length} property objects — by external ID ${how.ext}, by IfcGUID ${how.guid}, unmatched ${how.none}; ${named} with a volume`);
const body = JSON.stringify({ v: 1, urn, unit, scale, builtAt: new Date().toISOString(), objects: named, fragments, volumes });
console.log(`Volumes: ${named} objects, unit ${unit}, ${(body.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s`);
const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: `${prefix}/volumes/current.json`, Body: body, ContentType: 'application/json' }));
console.log(`Published ${prefix}/volumes/current.json`);

