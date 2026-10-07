// Real-data check of the 3D page (Actions: diag_only=ui-check, item=cache id). Read-only on R2.
//  1. Model index in Node: shard sizes, memory/time of the property-value search index, and what the
//     property panel shows for sampled leaf objects (their own Item data + parents carrying design data).
//  2. The real ThreeDTest page (vite build; login, ACC and the API answered locally) in headless Chromium
//     (SwiftShader) with this model's tiles and index streamed from R2 through a local proxy: click-select,
//     selection colour vs the old emphasis pass, property panel, value search timing, search highlight/zoom.
// Screenshots + results.json go to UI_OUT; the workflow publishes them to refs/diag/ui-check.
/* global window, document */ // page.evaluate callbacks run in the browser
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(env.UI_OUT || 'ui-check-out');
fs.mkdirSync(out, { recursive: true });
const results = { started: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
const log = (...a) => console.log('[ui-check]', ...a);
const MB = b => Math.round(b / 1048576 * 10) / 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let prefix = env.MODEL_CACHE_PREFIX || '';
if (!/^[A-Za-z0-9]{1,40}$/.test(prefix)) throw new Error('Invalid cache identifier');
// UI_R2_DIR: a local folder laid out like the bucket (dry runs of this script without R2).
const localDir = env.UI_R2_DIR ? path.resolve(env.UI_R2_DIR) : '';
const s3 = localDir ? null : await import('@aws-sdk/client-s3');
const client = s3 && new s3.S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } }), Bucket = env.R2_BUCKET;
const missing = e => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
async function r2Get(Key) {
  if (localDir) {
    const f = path.join(localDir, Key);
    if (!f.startsWith(localDir) || !fs.existsSync(f)) return null;
    const body = fs.readFileSync(f);
    const gz = body[0] === 0x1f && body[1] === 0x8b;
    return { body, type: Key.endsWith('.json') ? 'application/json' : 'application/octet-stream', encoding: gz ? 'gzip' : undefined };
  }
  try {
    const r = await client.send(new s3.GetObjectCommand({ Bucket, Key }));
    return { body: Buffer.from(await r.Body.transformToByteArray()), type: r.ContentType, encoding: r.ContentEncoding };
  } catch (e) { if (missing(e)) return null; throw e; }
}
const unzip = buf => (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf);
const parse = buf => JSON.parse(unzip(buf).toString());

function loadTs(file) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = {};
  new Function('exports', code)(mod);
  return mod;
}
const { ModelTree } = loadTs('src/viewer/ModelTree.ts');
const { PropSearchIndex } = loadTs('src/viewer/PropSearchIndex.ts');

// Cache directory (a per-URN key may alias a legacy directory, as in the other R2 jobs).
let manifestObj = await r2Get(`${prefix}/xkt/manifest.json`);
if (!manifestObj) {
  const alias = await r2Get(`${prefix}/alias.json`);
  const target = alias && parse(alias.body).prefix;
  if (!/^[A-Za-z0-9]{1,40}$/.test(target ?? '')) throw new Error('No cached model under this identifier');
  prefix = target;
  manifestObj = await r2Get(`${prefix}/xkt/manifest.json`);
}
const manifest = parse(manifestObj.body);
const pointerObj = await r2Get(`${prefix}/meta/current.json`);
if (!pointerObj) throw new Error('No model index (run diag_only=meta-index first)');
const pointer = parse(pointerObj.body);
const metaBase = `${prefix}/meta/${pointer.gen}`;
log('model', prefix, 'index', pointer.gen, pointer.shardCount, 'shards');

// ── 1. Index analysis ───────────────────────────────────────────────────────────────────────────
const treeData = parse((await r2Get(`${metaBase}/tree.json`)).body);
const tree = new ModelTree(treeData);
const shardRaw = new Array(pointer.shardCount).fill(null);
{
  const t0 = performance.now();
  let gz = 0, raw = 0, max = 0, next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let k = next++; k < pointer.shardCount; k = next++) {
      const o = await r2Get(`${metaBase}/p/${k}.json`);
      if (!o) continue;
      const r = unzip(o.body);
      gz += o.body.length; raw += r.length; max = Math.max(max, r.length);
      shardRaw[k] = r;
    }
  }));
  results.index = { objects: tree.n - 1, shards: pointer.shardCount, gzMB: MB(gz), rawMB: MB(raw), maxShardRawMB: MB(max),
    downloadMs: Math.round(performance.now() - t0) };
  log('index', results.index);
}

const ITEM = new Set(['Item', '항목']);
const categoryObjects = new Map(); // category → objects having it
const labelCount = new Map();
const richFlag = new Uint8Array(tree.n);
{
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const index = new PropSearchIndex();
  const t0 = performance.now();
  let parseMs = 0;
  for (const raw of shardRaw) {
    if (!raw) continue;
    const tp = performance.now();
    const shard = JSON.parse(raw.toString());
    parseMs += performance.now() - tp;
    index.addShard(shard);
    for (const [key, obj] of Object.entries(shard)) {
      const cats = new Set();
      for (const [c, label] of obj.p) {
        cats.add(c);
        labelCount.set(`${c} › ${label}`, (labelCount.get(`${c} › ${label}`) ?? 0) + 1);
      }
      for (const c of cats) categoryObjects.set(c, (categoryObjects.get(c) ?? 0) + 1);
      if ([...cats].some(c => !ITEM.has(c))) richFlag[Number(key)] = 1;
    }
  }
  const buildMs = performance.now() - t0;
  global.gc?.();
  const heapBuildMB = MB(process.memoryUsage().heapUsed - h0);
  const ab0 = process.memoryUsage().arrayBuffers;
  index.seal();
  global.gc?.();
  const heapMB = MB(process.memoryUsage().heapUsed - h0);
  const packedMB = MB(process.memoryUsage().arrayBuffers - ab0); // typed arrays live outside the JS heap
  const vocab = index.vocab ?? [];
  const vocabChars = vocab.reduce((s, v) => s + v.length, 0);
  results.valueIndex = { objects: index.size, vocab: vocab.length, vocabMChars: Math.round(vocabChars / 1e5) / 10,
    entries: index.entries?.length, buildMs: Math.round(buildMs), parseMs: Math.round(parseMs), heapBuildMB, heapMB, packedMB };
  // Searches: values taken from the data (one and two terms) plus fixed words.
  const rand = mulberry(7);
  const queries = ['concrete', '콘크리트', 'sm490', '철근', 'level 1'];
  for (let i = 0; i < 6 && vocab.length; i++) {
    const text = vocab[Math.floor(rand() * vocab.length)];
    const words = text.split(' ').filter(w => w.length >= 3);
    if (words.length) queries.push(words.slice(-2).join(' '));
  }
  results.valueSearch = queries.map(q => {
    const t = performance.now();
    const hits = index.search(q).length;
    return { q, hits, ms: Math.round(performance.now() - t) };
  });
  log('value index', results.valueIndex, results.valueSearch);
}
results.categories = [...categoryObjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
results.labels = [...labelCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
save();

// What the property panel shows for a picked leaf: itself, then parents with more than the Item basics.
{
  const parsed = new Map();
  const propsOf = id => {
    const k = Math.floor(id / pointer.shardSize);
    if (!shardRaw[k]) return null;
    if (!parsed.has(k)) { if (parsed.size > 48) parsed.clear(); parsed.set(k, JSON.parse(shardRaw[k].toString())); }
    return parsed.get(k)[id] ?? null;
  };
  const leaves = [];
  for (let id = 1; id < tree.n; id++) if (tree.childCount(id) === 0) leaves.push(id);
  const rand = mulberry(11);
  const sample = Array.from({ length: Math.min(400, leaves.length) }, () => leaves[Math.floor(rand() * leaves.length)]);
  const dist = { leafRich: 0, noRichAnywhere: 0, richParents: {}, firstRichDepth: {}, depth: {} };
  const examples = [];
  for (const leaf of sample) {
    const chain = tree.path(leaf).reverse();
    dist.depth[chain.length] = (dist.depth[chain.length] ?? 0) + 1;
    if (richFlag[leaf]) dist.leafRich++;
    const rich = chain.slice(1).filter(id => richFlag[id]);
    dist.richParents[rich.length] = (dist.richParents[rich.length] ?? 0) + 1;
    if (!richFlag[leaf] && !rich.length) dist.noRichAnywhere++;
    const first = chain.findIndex((id, i) => i > 0 && richFlag[id]);
    if (first > 0) dist.firstRichDepth[first] = (dist.firstRichDepth[first] ?? 0) + 1;
    if (examples.length < 8) {
      examples.push(chain.filter((id, i) => i === 0 || richFlag[id]).map(id => {
        const p = propsOf(id)?.p ?? [];
        const cats = {};
        for (const [c] of p) cats[c] = (cats[c] ?? 0) + 1;
        const firstRich = p.filter(([c]) => !ITEM.has(c)).slice(0, 4).map(([c, l, v, u]) => `${c} › ${l} = ${v}${u ? ` ${u}` : ''}`);
        return { id, name: tree.name(id), type: tree.type(id), cats, sample: firstRich };
      }));
    }
  }
  results.leafPanels = { sampled: sample.length, leaves: leaves.length, ...dist, examples };
  log('leaf panels', JSON.stringify(dist));
  save();
}

// ── 2. The page in Chromium ─────────────────────────────────────────────────────────────────────
const hdir = path.join(root, '.ui-check');
fs.rmSync(hdir, { recursive: true, force: true });
fs.mkdirSync(hdir, { recursive: true });
fs.writeFileSync(path.join(hdir, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>ui-check</title></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
fs.writeFileSync(path.join(hdir, 'entry.tsx'), `import '../src/index.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThreeDTest } from '../src/pages/ThreeDTest';
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/project/p1/model-test']}><Routes><Route path="/project/:projectId/model-test" element={<ThreeDTest />} /></Routes></MemoryRouter>);
`);
fs.writeFileSync(path.join(hdir, 'stubRole.ts'), 'export function useProjectRole() { return { role: \'admin\', isSystemAdmin: true, canView: true, canEdit: true, canManage: true, loading: false }; }\n');
{
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  process.env.VITE_SUPABASE_URL = 'http://x.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'k';
  await build({
    root: hdir, configFile: false, logLevel: 'warn', publicDir: path.join(root, 'public'),
    plugins: [{
      name: 'ui-check-viewer-handle', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/pages/ThreeDTest.tsx')) return null;
        if (!code.includes('viewerRef.current = viewer;')) throw new Error('viewer hook not found');
        const out = code.replace('viewerRef.current = viewer;', 'viewerRef.current = viewer; (window as unknown as { __viewer: unknown }).__viewer = viewer;');
        // UI_NO_DTX=1: plain VBO layers instead of data textures (for GL implementations without DTX support).
        return env.UI_NO_DTX === '1' ? out.replaceAll('dtxEnabled: true', 'dtxEnabled: false') : out;
      },
    }, react()],
    resolve: { alias: [{ find: /^(\.\.\/)+auth\/useProjectRole$/, replacement: path.join(hdir, 'stubRole.ts') }] },
    optimizeDeps: { exclude: ['web-ifc'] },
    build: { outDir: path.join(hdir, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 100000 },
  });
}

// Tiles around one dense spot (software rendering cannot draw the whole site in reasonable time).
const allTiles = manifest.tiles ?? [];
const centre = a => [(a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2];
// Default: the tile with the most objects (dense structure), not the largest file (big civil solids).
const members = t => t.far?.members ?? t.motion?.members ?? 0;
let target = Number(env.UI_TILE);
if (!(target >= 0 && target < allTiles.length)) {
  target = 0;
  allTiles.forEach((t, i) => { if (members(t) > members(allTiles[target])) target = i; });
}
results.tileTop = allTiles.map((t, i) => ({ i, members: members(t), MB: MB(t.byteLength ?? 0), centre: centre(t.aabb).map(Math.round) }))
  .sort((a, b) => b.members - a.members).slice(0, 8);
const c0 = centre(allTiles[target].aabb);
const chosen = allTiles.map((t, i) => [i, Math.hypot(...centre(t.aabb).map((v, j) => v - c0[j]))])
  .sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, Number(env.UI_TILES) || 16)).map(([i]) => i);
const r2Path = n => `/r2/${prefix}/xkt/${n}`;
const tiles = chosen.map(i => {
  const t = allTiles[i];
  return { url: r2Path(t.n), aabb: t.aabb, byteLength: t.byteLength,
    ...((t.motion?.policy === 'component-border-v1' || t.motion?.policy === 'merged-light-v2') && /^runs\/[a-zA-Z0-9-]+\/(?:motion|light)?\d+\.xkt$/.test(t.motion.n) && t.motion.byteLength > 0
      ? { motion: { url: r2Path(t.motion.n), byteLength: t.motion.byteLength, policy: t.motion.policy, members: t.motion.members } } : {}),
    ...(/^merged-far-v[45]$/.test(t.far?.policy ?? '') && /^runs\/[a-zA-Z0-9-]+\/far\d+\.xkt$/.test(t.far.n) && t.far.byteLength > 0
      ? { far: { url: r2Path(t.far.n), byteLength: t.far.byteLength, policy: t.far.policy, members: t.far.members } } : {}) };
});
results.scene = { tiles: allTiles.length, used: chosen.length, target, centre: c0.map(Math.round),
  bytesMB: MB(chosen.reduce((s, i) => s + (allTiles[i].byteLength ?? 0), 0)), base: (manifest.base ?? []).length, inst: (manifest.inst ?? []).length };
log('scene', results.scene);

const dist = path.join(hdir, 'dist');
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let r2Bytes = 0;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname.startsWith('/r2/')) {
      const key = decodeURIComponent(u.pathname.slice(4));
      if (!key.startsWith(`${prefix}/`)) { res.writeHead(403); res.end(); return; }
      const o = await r2Get(key);
      if (!o) { res.writeHead(404); res.end(); return; }
      r2Bytes += o.body.length;
      res.writeHead(200, { 'content-type': o.type || 'application/octet-stream', 'content-length': o.body.length,
        ...(o.encoding ? { 'content-encoding': o.encoding } : {}) });
      res.end(o.body);
      return;
    }
    let f = path.join(dist, path.normalize(decodeURIComponent(u.pathname)));
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const shardUrl = k => `${base}/r2/${metaBase}/p/${k}.json`;
const state = { ready: true, xkt: true, urls: [r2Path('unused.xkt')], tiles,
  meta: { tree: `/r2/${metaBase}/tree.json`, shardSize: pointer.shardSize, shardCount: pointer.shardCount, objects: pointer.objects ?? 0 } };

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleLines = [], pageErrors = [], failed = [], apiCalls = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on('pageerror', e => pageErrors.push(e.message.slice(0, 300)));
page.on('requestfailed', r => failed.push(`${r.url().slice(0, 140)} ${r.failure()?.errorText}`));
const modelName = env.UI_MODEL_NAME || '평택-오송 5공구_통합모델.nwd';
await page.route('http://x.test/**', r => {
  const single = (r.request().headers().accept || '').includes('vnd.pgrst.object+json');
  if (r.request().url().includes('/rest/v1/projects') && single)
    return r.fulfill({ json: { acc_hub_id: 'b.h', acc_project_id: 'b.p', acc_root_folder_id: 'F', acc_root_folder_name: '루트' } });
  return r.fulfill({ json: single ? {} : [] });
});
await page.route('**/api/**', r => {
  const u = new URL(r.request().url());
  apiCalls.push(`${r.request().method()} ${u.pathname}${u.search.replace(/urn=[^&]+/, 'urn=…')}`);
  if (u.pathname === '/api/aps-acc') return r.fulfill({ json: { folders: [], items: [{ id: 'I1', name: modelName, urn: 'urnUICHECK' }] } });
  if (u.pathname === '/api/aps-convert') {
    if (u.searchParams.get('metaShards') === 'all') return r.fulfill({ json: { urls: Array.from({ length: pointer.shardCount }, (_, k) => shardUrl(k)) } });
    if (u.searchParams.has('metaShard')) return r.fulfill({ json: { url: shardUrl(Number(u.searchParams.get('metaShard'))) } });
    return r.fulfill({ json: state });
  }
  return r.fulfill({ status: 404, json: {} });
});

const shot = async (name, clip) => {
  try { await page.screenshot({ path: path.join(out, name), ...(clip ? { clip } : {}), timeout: 120000 }); }
  catch (e) { log('screenshot failed', name, e.message); }
};
const statusLine = () => page.evaluate(() => document.body.innerText.match(/원경 \d+\/\d+[^\n]*/)?.[0] ?? '').catch(() => '');
results.timeline = [];
const t0 = Date.now();
/** Wait until no tile is downloading and the status line stops changing (or the deadline). */
async function settle(label, maxMs) {
  const until = Date.now() + maxMs;
  let last = '', same = 0;
  while (Date.now() < until) {
    await sleep(5000);
    const s = await statusLine();
    results.timeline.push({ s: Math.round((Date.now() - t0) / 1000), label, status: s.replace(/ · 파일 크기.*/, '') });
    same = s === last ? same + 1 : 0;
    last = s;
    if (/다운로드 중 0/.test(s) && same >= 2) return true;
  }
  return false;
}
const canvasBox = async () => (await page.locator('canvas').first().boundingBox());

try {
  await page.goto(base);
  await page.getByRole('button', { name: 'ACC에서 열기' }).click();
  await page.locator('.acc-picker-row', { hasText: modelName }).first().click();
  await page.waitForSelector('.threed-test__panel--left', { timeout: 180000 });
  results.treeShownSec = Math.round((Date.now() - t0) / 1000);
  results.firstSettled = await settle('open', 420000);
  await shot('01-overview.png');
  save();

  // An object near the middle of the view, then fly close so the light/original tiles load around it.
  const box = await canvasBox();
  const hits = await page.evaluate(() => {
    const v = window.__viewer, c = v.scene.canvas.canvas, W = c.clientWidth, H = c.clientHeight, list = [];
    for (let gx = 1; gx < 24; gx++) for (let gy = 1; gy < 14; gy++) {
      const pos = [W * gx / 24, H * gy / 14];
      const h = v.scene.pick({ canvasPos: pos });
      const id = h?.entity?.isObject ? String(h.entity.id) : '';
      if (!/^tile\d+(?:-far|-detail)?#/.test(id)) continue;
      const a = Array.from(h.entity.aabb);
      list.push({ id, aabb: a, diag: Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2]), off: Math.hypot(pos[0] - W / 2, pos[1] - H / 2) });
    }
    return list;
  });
  // Nothing under the sample points (objects only a few pixels wide): take one from the scene near the view centre.
  if (!hits.length) hits.push(...await page.evaluate(() => {
    const v = window.__viewer, look = v.camera.look, list = [];
    for (const [id, o] of Object.entries(v.scene.objects)) {
      if (!o.visible || !/^tile\d+(?:-far|-detail)?#/.test(id)) continue;
      const a = Array.from(o.aabb);
      list.push({ id, aabb: a, diag: Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2]),
        off: Math.hypot((a[0] + a[3]) / 2 - look[0], (a[1] + a[4]) / 2 - look[1], (a[2] + a[5]) / 2 - look[2]) });
    }
    return list;
  }));
  const dbOf = h => { const m = /#(\d+)$/.exec(h.id); return m ? Number(m[1]) : 0; };
  const designed = h => dbOf(h) > 0 && dbOf(h) < tree.n && tree.path(dbOf(h)).some(id => id !== dbOf(h) && richFlag[id]);
  const sized = h => h.diag > 2 && h.diag < 60;
  const rank = h => (designed(h) ? 0 : dbOf(h) ? 1 : 2) * 1e6 + (sized(h) ? 0 : 1e5) + h.off;
  const pick = hits.sort((a, b) => rank(a) - rank(b))[0];
  results.pickCandidates = hits.length;
  results.pickKinds = { designed: hits.filter(designed).length, numeric: hits.filter(h => dbOf(h) > 0).length, generated: hits.filter(h => !dbOf(h)).length };
  results.sceneInfo = await page.evaluate(() => {
    const v = window.__viewer, objs = Object.values(v.scene.objects);
    const ids = Object.keys(v.scene.objects);
    return { models: Object.keys(v.scene.models).length, objects: objs.length, visible: objs.filter(o => o.visible).length,
      numericIds: ids.filter(k => /^tile\d+(?:-far|-detail)?#\d+$/.test(k)).length, generatedIds: ids.filter(k => /#entity-\d+$/.test(k)).length,
      culled: objs.filter(o => o.culled).length, aabb: Array.from(v.scene.aabb).map(Math.round),
      eye: Array.from(v.camera.eye).map(Math.round), look: Array.from(v.camera.look).map(Math.round),
      gl: (() => { const gl = v.scene.canvas.gl, ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() };
  });
  log('scene info', results.sceneInfo);
  if (!pick) throw new Error('nothing pickable on screen');
  const db = pick.id.split('#')[1];
  results.target = { entity: pick.id, db, diag: Math.round(pick.diag * 10) / 10, name: tree.name(Number(db)), type: tree.type(Number(db)) };
  const a = pick.aabb, pad = Math.max(pick.diag, 10);
  await page.evaluate(aabb => window.__viewer.cameraFlight.jumpTo({ aabb }), [a[0] - pad, a[1] - pad, a[2] - pad, a[3] + pad, a[4] + pad, a[5] + pad]);
  results.closeSettled = await settle('close', 420000);
  const centreClip = { x: box.x + box.width / 2 - 400, y: box.y + box.height / 2 - 250, width: 800, height: 500 };
  await shot('02-before-select.png', centreClip);

  // Click the object where it is actually drawn (spiral from the centre).
  const at = await page.evaluate(want => {
    const v = window.__viewer, c = v.scene.canvas.canvas, W = c.clientWidth, H = c.clientHeight;
    for (let r = 0; r < 300; r += 6) for (let k = 0; k < 16; k++) {
      const pos = [W / 2 + r * Math.cos(k * Math.PI / 8), H / 2 + r * Math.sin(k * Math.PI / 8)];
      const h = v.scene.pick({ canvasPos: pos });
      if (h?.entity && String(h.entity.id).endsWith(`#${want}`)) return { pos, id: String(h.entity.id) };
    }
    return null;
  }, db);
  results.clickAt = at;
  const cx = box.x + (at ? at.pos[0] : box.width / 2), cy = box.y + (at ? at.pos[1] : box.height / 2);
  await page.mouse.click(cx, cy);
  await sleep(4000);
  const selection = await page.evaluate(() => {
    const objs = window.__viewer.scene.objects, blue = [], emphasised = [];
    for (const [k, o] of Object.entries(objs)) {
      const c = o.colorize;
      if (c && Math.abs(c[0] - 0.15) < 0.02 && Math.abs(c[2] - 1) < 0.02) blue.push(k);
      if (o.selected || o.highlighted) emphasised.push(k);
    }
    // Every representation of the picked object: two drawn at once in the same place would z-fight.
    const db = (blue[0] ?? '').split('#')[1];
    // (The entity flags are authoritative: an entity created inside a culled model reports culled=false.)
    const drawn = o => (o._flags & 1) !== 0 && (o._flags & 4) === 0;
    const reps = db ? Object.entries(objs).filter(([k]) => k.endsWith(`#${db}`)).map(([k, o]) => ({ id: k, drawn: drawn(o) })) : [];
    // Scene-wide: one object drawn by two representations of the same tile (far+main or light+detail).
    const byTile = new Map();
    for (const [k, o] of Object.entries(objs)) {
      const m = /^(tile\d+)(-far|-detail)?#(.+)$/.exec(k);
      if (!m || !drawn(o)) continue;
      const key = `${m[1]}#${m[3]}`;
      byTile.set(key, (byTile.get(key) ?? 0) + 1);
    }
    const overlaps = [...byTile.entries()].filter(([, n]) => n > 1);
    return { blue: blue.slice(0, 12), blueCount: blue.length, emphasised: emphasised.length, reps,
      drawnObjects: byTile.size, sameTileOverlaps: overlaps.length, overlapSample: overlaps.slice(0, 8).map(([k]) => k),
      title: document.querySelector('.prop-panel__title')?.innerText ?? null, selectedRow: document.querySelector('.model-tree__row.is-selected')?.innerText ?? null };
  });
  results.selection = selection;
  await shot('03-selected.png', centreClip);
  await shot('03-selected-full.png');

  // The old way (xeokit emphasis pass, as in the previous attempt) on the same object, for comparison.
  const selDb = (selection.blue[0] ?? pick.id).split('#')[1];
  await page.evaluate(want => {
    const v = window.__viewer, m = v.scene.selectedMaterial;
    m.fillColor = [0.15, 0.5, 1]; m.fillAlpha = 1; m.edges = false; m.glowThrough = false;
    for (const [k, o] of Object.entries(v.scene.objects)) if (k.endsWith(`#${want}`)) { o.colorize = null; o.selected = true; }
  }, selDb);
  await sleep(4000);
  await shot('04-old-emphasis.png', centreClip);
  await page.evaluate(want => {
    for (const [k, o] of Object.entries(window.__viewer.scene.objects)) if (k.endsWith(`#${want}`)) { o.selected = false; o.colorize = [0.15, 0.5, 1]; }
  }, selDb);

  // Property panel.
  await page.waitForFunction(() => !document.querySelector('.prop-panel__body')?.innerText.includes('불러오는 중'), null, { timeout: 120000 }).catch(() => {});
  results.panel = await page.evaluate(() => ({
    text: (document.querySelector('.prop-panel__body')?.innerText ?? '').slice(0, 5000),
    sections: [...document.querySelectorAll('.prop-panel__section')].map(s => ({
      parent: s.querySelector('.prop-panel__parent')?.innerText ?? null,
      groups: [...s.querySelectorAll('.prop-panel__group summary')].map(x => x.innerText.replace(/\s+/g, ' ')) })),
  }));
  const right = page.locator('.threed-test__panel--right');
  try { await right.screenshot({ path: path.join(out, '05-property-panel.png') }); } catch (e) { log('panel shot', e.message); }
  save();

  // Property-value search: a value from the panel (design data of a parent when there is one).
  const queries = await page.evaluate(() => {
    const picked = [];
    const sections = [...document.querySelectorAll('.prop-panel__section')];
    for (const itemToo of [false, true]) {
      for (const s of [...sections.slice(1), ...sections.slice(0, 1)]) {
        for (const g of s.querySelectorAll('.prop-panel__group')) {
          const cat = g.querySelector('summary')?.innerText ?? '';
          if (!itemToo && /^(Item|항목)\b/.test(cat)) continue;
          for (const r of g.querySelectorAll('.prop-panel__row')) {
            const v = r.querySelector('dd')?.innerText.trim() ?? '';
            if (/[A-Za-z가-힣]/.test(v) && v.length >= 2 && v.length <= 24 && !picked.includes(v)) picked.push(v);
          }
        }
      }
    }
    return picked.slice(0, 2);
  });
  if (!queries.length) queries.push('concrete');
  await page.check('.prop-panel__mode input');
  results.panelSearch = [];
  for (const q of queries) {
    const ts0 = Date.now(), notes = new Set();
    await page.fill('.prop-panel input[type=search]', q);
    let count = null;
    while (Date.now() - ts0 < 300000) {
      await sleep(300);
      const s = await page.evaluate(want => {
        const bar = document.querySelector('.prop-panel__search-bar');
        return { notes: [...document.querySelectorAll('.prop-panel__search > .muted')].map(e => e.textContent),
          ready: !!bar && bar.dataset.term === want.trim() && !bar.dataset.pending,
          count: bar?.querySelector('.muted')?.textContent ?? null };
      }, q);
      s.notes.forEach(n => notes.add(n.replace(/\d+\/(\d+)/, 'n/$1')));
      if (s.ready) { count = s.count; break; }
    }
    results.panelSearch.push({ q, ms: Date.now() - ts0, count, notes: [...notes] });
    log('panel search', results.panelSearch.at(-1));
  }
  results.mainHeapMB = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  const hl = page.locator('.prop-panel__search-bar button', { hasText: '모두 강조' });
  if (await hl.count() && await hl.isEnabled()) {
    await hl.click();
    await sleep(4000);
    results.highlighted = await page.evaluate(() => Object.values(window.__viewer.scene.objects).filter(o => o.colorize && o.colorize[0] > 0.9 && o.colorize[2] < 0.2).length);
    await shot('06-search-highlight.png');
    await page.locator('.prop-panel__search-bar button', { hasText: '확대' }).click();
    await settle('search-zoom', 180000);
    await shot('07-search-zoom.png');
  }
} catch (e) {
  results.error = e.stack?.slice(0, 1500) ?? String(e);
  log('page check failed', e);
  await shot('99-error.png');
} finally {
  results.console = consoleLines.slice(0, 80);
  results.pageErrors = pageErrors;
  results.failedRequests = failed.slice(0, 40);
  results.apiCalls = apiCalls.slice(0, 60);
  results.r2MB = MB(r2Bytes);
  results.finished = new Date().toISOString();
  save();
  await browser.close();
  server.close();
}
log('done', JSON.stringify({ error: results.error ?? null, selection: results.selection, panelSearch: results.panelSearch }));

function mulberry(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
