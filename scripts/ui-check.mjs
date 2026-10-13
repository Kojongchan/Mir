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
// UI_OPTIONS "page=2,cpu=4,mobile=1,tiles=all" (one workflow input) → UI_PAGE / UI_CPU / UI_MOBILE / UI_TILES.
for (const part of (env.UI_OPTIONS || '').split(',')) {
  const [k, v] = part.split('=').map(x => x?.trim());
  if (k && v && /^[a-z]+$/.test(k) && /^[\w.]+$/.test(v)) env[`UI_${k.toUpperCase()}`] = v;
}
const PAGE = env.UI_PAGE === '2' ? 2 : 1;
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
fs.writeFileSync(path.join(hdir, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ui-check</title></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
fs.writeFileSync(path.join(hdir, 'entry.tsx'), `import '../src/index.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ${PAGE === 2 ? 'ThreeDTest2 as Page' : 'ThreeDTest as Page'} } from '../src/pages/${PAGE === 2 ? 'ThreeDTest2' : 'ThreeDTest'}';
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/project/p1/page']}><Routes><Route path="/project/:projectId/page" element={<Page />} /></Routes></MemoryRouter>);
`);
fs.writeFileSync(path.join(hdir, 'stubRole.ts'), 'export function useProjectRole() { return { role: \'admin\', isSystemAdmin: true, canView: true, canEdit: true, canManage: true, loading: false }; }\n');
{
  await import('./copy-wasm.mjs'); // public/basis (KTX2 terrain photos) is not committed
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  process.env.VITE_SUPABASE_URL = 'http://x.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'k';
  await build({
    root: hdir, configFile: false, logLevel: 'warn', publicDir: path.join(root, 'public'),
    plugins: [{
      name: 'ui-check-viewer-handle', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/pages/ThreeDTest.tsx') && !id.endsWith('/pages/ThreeDTest2.tsx')) return null;
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
  .sort((a, b) => a[1] - b[1]).slice(0, env.UI_TILES === 'all' ? allTiles.length : Math.max(1, Number(env.UI_TILES) || 16)).map(([i]) => i);
const r2Path = n => `/r2/${prefix}/xkt/${n}`;
const failedOnce = new Set();
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
      if (key.includes('/tiles3d/') && !u.searchParams.has('X-Amz-Signature')) { results.unsigned = (results.unsigned ?? 0) + 1; res.writeHead(403); res.end(); return; }
      // UI_FAILFIRST=1: the first request of every 3D Tiles content file fails (a dropped request on a poor network).
      if (env.UI_FAILFIRST && /\/tiles3d\/.*\.glb$/.test(key) && !failedOnce.has(key)) {
        failedOnce.add(key); results.failedFirst = (results.failedFirst ?? 0) + 1;
        res.writeHead(503); res.end(); return;
      }
      const o = await r2Get(key);
      if (!o) { res.writeHead(404); res.end(); return; }
      r2Bytes += o.body.length;
      res.writeHead(200, { 'content-type': o.type || 'application/octet-stream', 'content-length': o.body.length,
        ...(o.encoding ? { 'content-encoding': o.encoding } : {}) });
      res.end(o.body);
      return;
    }
    if (u.pathname === '/ui-alias.json' && aliasTable) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(aliasTable));
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
// The renamed-fragment table is keyed by manifest index: re-key it to this subset's positions.
let aliasTable = null;
if (typeof pointer.alias === 'string') {
  const full = parse((await r2Get(`${prefix}/meta/${pointer.alias}`)).body);
  aliasTable = { v: full.v, tiles: Object.fromEntries(chosen.map((i, pos) => [pos, full.tiles[i]]).filter(([, t]) => t)) };
  results.alias = { tiles: Object.keys(full.tiles).length, subsetTiles: Object.keys(aliasTable.tiles).length,
    subsetPairs: Object.values(aliasTable.tiles).reduce((n, t) => n + t.a.length / 2, 0) };
}
const state = { ready: true, xkt: true, urls: [r2Path('unused.xkt')], tiles,
  meta: { tree: `/r2/${metaBase}/tree.json`, shardSize: pointer.shardSize, shardCount: pointer.shardCount, objects: pointer.objects ?? 0,
    ...(aliasTable ? { alias: '/ui-alias.json' } : {}) } };

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-precise-memory-info'] });
const mobile = env.UI_MOBILE === '1';
const page = await browser.newPage(mobile
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
  : { viewport: { width: 1600, height: 900 } });
// Main-thread stalls (long tasks) for the whole session.
await page.addInitScript(() => {
  window.__lt = { n: 0, ms: 0, max: 0 };
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) { window.__lt.n++; window.__lt.ms += e.duration; window.__lt.max = Math.max(window.__lt.max, e.duration); } })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* not supported */ }
});
const cdp = await page.context().newCDPSession(page);
if (Number(env.UI_CPU) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(env.UI_CPU) });
results.conditions = { page: PAGE, cpu: Number(env.UI_CPU) || 1, mobile, tiles: env.UI_TILES || 16 };
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
    if (u.searchParams.get('tiles3d') === '1') return (async () => {
      const current = await r2Get(`${prefix}/tiles3d/current.json`);
      if (!current) return r.fulfill({ status: 404, json: { error: '이 모델은 2차 화면용 타일이 아직 없습니다.', missing: true } });
      const c = parse(current.body);
      results.tiles3d = { run: c.run, files: c.files.length, MB: MB(c.bytes), builtAt: c.builtAt, stats: c.stats };
      // Like R2 presigned URLs: each file's URL carries its own query, and the file server refuses one without it.
      return r.fulfill({ json: { run: c.run, builtAt: c.builtAt, expiresIn: 14400,
        urls: Object.fromEntries(c.files.map(f => [f, `${base}/r2/${prefix}/tiles3d/${c.run}/${f}?X-Amz-Signature=ui-check`])) } });
    })();
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
/** Seconds since the start of the check (both pages count from the same point: before the page loads). */
const since = at => Math.round((at - t0) / 100) / 10;
/** Wait until no tile is downloading and the status line stops changing (or the deadline); `ready` = its last change. */
const ready = {};
async function settle(label, maxMs) {
  const until = Date.now() + maxMs;
  let last = '', same = 0, changed = Date.now();
  while (Date.now() < until) {
    await sleep(2000);
    const s = await statusLine();
    results.timeline.push({ s: Math.round((Date.now() - t0) / 1000), label, status: s.replace(/ · 파일 크기.*/, '') });
    if (s === last) same++; else { same = 0; changed = Date.now(); }
    last = s;
    if (/다운로드 중 0/.test(s) && same >= 3) { ready[label] = since(changed); return true; }
  }
  return false;
}
const canvasBox = async () => (await page.locator('canvas').first().boundingBox());

const sample = async label => {
  const m = await page.evaluate(() => ({ lt: window.__lt, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    v: window.__viewer?.stats ? window.__viewer.stats()
      : window.__viewer?.scene ? { loadedTriangles: Object.values(window.__viewer.scene.models).reduce((n, m) => n + (m.numTriangles || 0), 0),
        objects: window.__viewer.scene.numObjects, models: Object.keys(window.__viewer.scene.models).length } : null })).catch(() => null);
  return { label, s: Math.round((Date.now() - t0) / 1000), r2MB: MB(r2Bytes), heapMB: m?.heap ?? null,
    longTasks: m?.lt ? { n: m.lt.n, ms: Math.round(m.lt.ms), max: Math.round(m.lt.max) } : null, viewer: m?.v ?? null };
};
/** Orbit: drag 40% of the view to the right and back (≈6 s); frames drawn (`frames` reads a counter) and stalls. */
async function orbit(frames) {
  const box = await canvasBox();
  const read = () => page.evaluate(frames).catch(() => null);
  const lt = () => page.evaluate(() => window.__lt?.ms ?? 0).catch(() => 0);
  const f0 = await read(), lt0 = await lt(), t = Date.now();
  // A phone gets a one-finger touch drag (mouse events do not orbit there), a desktop a mouse drag.
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: box.y + box.height * 0.5 }] });
  const at = u => box.x + box.width * (0.3 + 0.4 * u);
  if (mobile) await touch('touchStart', at(0));
  else { await page.mouse.move(at(0), box.y + box.height * 0.5); await page.mouse.down(); }
  for (let k = 1; k <= 120; k++) {
    const u = k <= 60 ? k / 60 : (120 - k) / 60;
    if (mobile) await touch('touchMove', at(u)); else await page.mouse.move(at(u), box.y + box.height * 0.5);
    await sleep(50);
  }
  if (mobile) await touch('touchEnd'); else await page.mouse.up();
  const ms = Date.now() - t, f1 = await read(), lt1 = await lt();
  return { label: 'orbit', ms, fps: f0 !== null && f1 !== null ? Math.round((f1 - f0) * 1000 / ms) : null, longTaskMs: Math.round(lt1 - lt0) };
}
if (PAGE === 2) {
  results.v2 = [];
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'ACC에서 열기' }).click();
    await page.locator('.acc-picker-row', { hasText: modelName }).first().click();
    await page.waitForSelector('.threed-test2__stats', { timeout: 180000 });
    // A model without tiles: record the message the page shows and stop.
    await sleep(3000);
    const missing = await page.locator('.threed-test__empty').innerText().catch(() => '');
    if (missing) { results.v2missing = missing; await shot('10-v2-missing.png'); throw new Error('no 3D Tiles for this model'); }
    /** Until the viewer reports a settled frame and no downloads/parses for two samples (or the deadline). */
    const settle2 = async (label, maxMs) => {
      const until = Date.now() + maxMs;
      let quiet = 0, last = '', changed = Date.now();
      while (Date.now() < until) {
        await sleep(2000);
        const st = await page.evaluate(() => window.__viewer?.stats()).catch(() => null);
        results.timeline.push({ s: Math.round((Date.now() - t0) / 1000), label, st });
        const key = st ? `${st.tilesLoaded}/${st.tilesVisible}/${st.triangles}/${st.downloading}/${st.parsing}` : '';
        if (key !== last) { last = key; changed = Date.now(); }
        quiet = st && st.downloading === 0 && st.parsing === 0 && st.settledMs !== null ? quiet + 1 : 0;
        if (quiet >= 2) { ready[label] = since(changed); return true; }
      }
      return false;
    };
    results.v2.push({ ...(await sample('open')), settled: await settle2('open', 300000) });
    results.v2.push(await sample('overview'));
    await shot('11-v2-overview.png');
    save();
    // UI_CAPTURE=1: the high-quality still of the overview (download), its size and how long it took.
    if (env.UI_CAPTURE) {
      const t = Date.now();
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.getByRole('button', { name: '고화질 캡처' }).click()]);
      const file = path.join(out, '14-v2-capture.png');
      await download.saveAs(file);
      const png = fs.readFileSync(file);
      results.capture = { seconds: Math.round((Date.now() - t) / 1000), bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        status: await page.locator('.threed-test2__status').innerText().catch(() => '') };
      log('capture', results.capture);
    }
    const box = await canvasBox();
    results.v2.push(await orbit(() => window.__viewer.stats().frames));
    await settle2('after-orbit', 120000);
    // Search "Structural Framing" (the reported case): highlight all, zoom to them. Narrow screens start with the
    // panels closed.
    if (!await page.locator('.prop-panel').count()) await page.getByRole('button', { name: '속성', exact: true }).click();
    const search = page.locator('.prop-panel input[type=search]');
    if (await search.count()) {
      await search.fill(env.UI_SEARCH || 'Structural Framing');
      await page.waitForFunction(q => document.querySelector('.prop-panel__search-bar')?.dataset.term === q, env.UI_SEARCH || 'Structural Framing', { timeout: 60000 }).catch(() => {});
      results.v2search = await page.evaluate(() => document.querySelector('.prop-panel__search-bar .muted')?.textContent ?? null);
      const hl = page.locator('.prop-panel__search-bar button', { hasText: '모두 강조' });
      if (await hl.count() && await hl.isEnabled()) {
        await hl.click();
        await page.locator('.prop-panel__search-bar button', { hasText: '확대' }).click();
        await sleep(1500); await settle2('search-zoom', 240000);
        await shot('13-v2-search.png');
        results.v2.push(await sample('search-zoom'));
      }
    }
    // In that closer view: click an object near the centre (first hit on a widening grid), zoom to the selection
    // (per-object boxes) and let the finer levels load.
    const at = await page.evaluate(() => {
      const v = window.__viewer, c = v.renderer.domElement, W = c.clientWidth, H = c.clientHeight;
      for (let ring = 0; ring <= 14; ring++) for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const x = W / 2 + i * W / 32, y = H / 2 + j * H / 32, r = c.getBoundingClientRect();
        // Only where the canvas is on top (a phone's bottom sheet covers the lower half).
        if (document.elementFromPoint(r.left + x, r.top + y) === c && v.pick(x, y)?.dbId) return { x, y };
      }
      return { x: W / 2, y: H / 2 };
    }).catch(() => ({ x: box.width / 2, y: box.height / 2 }));
    await page.mouse.click(box.x + at.x, box.y + at.y);
    await sleep(1500);
    results.v2pick = await page.evaluate(() => document.querySelector('.prop-panel__title')?.innerText ?? null);
    const zoom = page.getByRole('button', { name: '선택 확대' });
    if (await zoom.isEnabled()) { await zoom.click(); await sleep(1500); await settle2('zoom', 240000); }
    results.v2.push(await sample('zoomed'));
    await shot('12-v2-zoomed.png');
    // UI_CAMERA=1: the "camera flies" cases. A: a stale target 10× deeper than the surface on screen, one wheel notch.
    // B: a new drag started while the previous rotation still eases (pointer pressed, not moved). C: after rotating
    // about an off-centre object, one wheel notch elsewhere — how far the point under the cursor drifts on screen
    // (zoom toward the cursor keeps it in place).
    if (env.UI_CAMERA) {
      const cam = () => page.evaluate(() => window.__viewer.camera.position.toArray());
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // Points with a surface on a grid (canvas px).
      const spots = await page.evaluate(() => {
        const v = window.__viewer, c = v.renderer.domElement, W = c.clientWidth, H = c.clientHeight, out = [];
        for (let j = 2; j < 8; j++) for (let i = 2; i < 14; i++) {
          const h = v.pick(W * i / 16, H * j / 10);
          if (h?.dbId) out.push({ x: W * i / 16, y: H * j / 10, depth: h.point.distanceTo(v.camera.position) });
        }
        return out;
      });
      if (spots.length >= 2) {
        const s0 = spots[Math.floor(spots.length / 2)], s1 = spots[0];
        // A
        await page.evaluate(([x, y]) => {
          const v = window.__viewer, h = v.pick(x, y);
          const far = v.camera.position.clone().addScaledVector(v.camera.getWorldDirection(h.point.clone()), h.point.distanceTo(v.camera.position) * 10);
          v.controls.setOrbitPoint(far.x, far.y, far.z);
        }, [s0.x, s0.y]);
        await sleep(300);
        await page.mouse.move(box.x + s0.x, box.y + s0.y);
        const a0 = await cam();
        await page.mouse.wheel(0, -100);
        await sleep(1200);
        const wheelMove = dist(a0, await cam());
        // B
        await page.mouse.move(box.x + s1.x, box.y + s1.y); await page.mouse.down();
        for (let k = 1; k <= 6; k++) { await page.mouse.move(box.x + s1.x + k * 30, box.y + s1.y); await sleep(16); }
        await page.mouse.up();
        await page.mouse.move(box.x + s0.x, box.y + s0.y); await page.mouse.down();
        const b0 = await cam();
        await sleep(600);
        const easeMove = dist(b0, await cam());
        await page.mouse.up();
        await sleep(800);
        // C: rotate about s1 (off centre), then wheel at s0.
        await page.mouse.move(box.x + s1.x, box.y + s1.y); await page.mouse.down();
        for (let k = 1; k <= 4; k++) { await page.mouse.move(box.x + s1.x + k * 10, box.y + s1.y); await sleep(30); }
        await page.mouse.up();
        await sleep(800);
        const target = await page.evaluate(([x, y]) => { const h = window.__viewer.pick(x, y); return h && h.point.toArray(); }, [s0.x, s0.y]);
        await page.mouse.move(box.x + s0.x, box.y + s0.y);
        await page.mouse.wheel(0, -100);
        await sleep(1200);
        const drift = target && await page.evaluate(([p, x, y]) => {
          const v = window.__viewer, c = v.renderer.domElement;
          const q = v.camera.position.clone().set(p[0], p[1], p[2]).project(v.camera);
          return Math.hypot((q.x + 1) / 2 * c.clientWidth - x, (1 - q.y) / 2 * c.clientHeight - y);
        }, [target, s0.x, s0.y]);
        results.camera = { surfaceM: Math.round(s0.depth * 10) / 10, wheelMoveM: Math.round(wheelMove * 10) / 10,
          easeMoveM: Math.round(easeMove * 100) / 100, cursorDriftPx: drift === null ? null : Math.round(drift) };
      } else results.camera = { error: 'no surface to test on' };
      log('camera', results.camera);
    }
  } catch (e) {
    results.error = e.stack?.slice(0, 1500) ?? String(e);
    log('page check failed', e);
    await shot('99-error.png');
  } finally {
    results.ready = ready;
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
  log('done', JSON.stringify({ error: results.error ?? null, v2: results.v2 }));
  process.exit(0);
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: 'ACC에서 열기' }).click();
  await page.locator('.acc-picker-row', { hasText: modelName }).first().click();
  await page.waitForSelector('.threed-test__panel--left', { timeout: 180000 });
  results.treeShownSec = Math.round((Date.now() - t0) / 1000);
  results.firstSettled = await settle('open', 420000);
  results.v1 = [await sample('open')];
  await shot('01-overview.png');
  save();
  await page.evaluate(() => { window.__frames = 0; window.__viewer.scene.on('rendered', () => { window.__frames++; }); });
  results.v1.push(await orbit(() => window.__frames));
  await settle('after-orbit', 120000);

  // An object near the middle of the view, then fly close so the light/original tiles load around it.
  const box = await canvasBox();
  const hits = await page.evaluate(() => {
    const v = window.__viewer, c = v.scene.canvas.canvas, W = c.clientWidth, H = c.clientHeight, list = [];
    for (let gx = 1; gx < 24; gx++) for (let gy = 1; gy < 14; gy++) {
      const pos = [W * gx / 24, H * gy / 14];
      const h = v.scene.pick({ canvasPos: pos, pickSurface: true });
      const id = h?.entity?.isObject ? String(h.entity.id) : '';
      if (!/^tile\d+(?:-far|-detail)?#/.test(id)) continue;
      const a = Array.from(h.entity.aabb);
      list.push({ id, aabb: a, diag: Math.hypot(a[3] - a[0], a[4] - a[1], a[5] - a[2]), off: Math.hypot(pos[0] - W / 2, pos[1] - H / 2),
        textured: !!h.entity.meshes?.some(m => m.textureSet) });
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
    // The nearest few hundred (a whole site has ≈240k objects: too many to spread into push).
    return list.sort((p, q) => p.off - q.off).slice(0, 500);
  }));
  const dbOf = h => { const m = /#(\d+)$/.exec(h.id); return m ? Number(m[1]) : 0; };
  const designed = h => dbOf(h) > 0 && dbOf(h) < tree.n && tree.path(dbOf(h)).some(id => id !== dbOf(h) && richFlag[id]);
  const sized = h => h.diag > 2 && h.diag < 60;
  // Objects with several fragments in their tile (renamed ones in the table) show whether selection covers all.
  const multi = new Set(Object.entries(aliasTable?.tiles ?? {}).flatMap(([pos, t]) => t.a.filter((_, i) => i % 2).map(d => `tile${pos}#${d}`)));
  const isMulti = h => multi.has(h.id.replace(/-(?:far|detail)#/, '#'));
  // Textured objects (soil, rock) multiply the selection colour with a dark image: judge on plain ones.
  const rank = h => (designed(h) ? 0 : dbOf(h) ? 2 : 4) * 1e6 - (isMulti(h) ? 1e6 : 0) + (h.textured ? 3e6 : 0) + (sized(h) ? 0 : 1e5) + h.off;
  const pick = hits.sort((a, b) => rank(a) - rank(b))[0];
  results.pickCandidates = hits.length;
  results.pickKinds = { designed: hits.filter(designed).length, multi: hits.filter(isMulti).length, textured: hits.filter(h => h.textured).length,
    numeric: hits.filter(h => dbOf(h) > 0).length, generated: hits.filter(h => !dbOf(h)).length };
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
      const h = v.scene.pick({ canvasPos: pos, pickSurface: true });
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
      // The SDK getter keeps returning the last colour after colorize = null; the mesh flag is the drawn state.
      const c = o.meshes?.some(m => m._colorizing) ? o.colorize : null;
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
    return { blue: blue.slice(0, 12), blueCount: blue.length, blueGenerated: blue.filter(k => /#entity-\d+$/.test(k)).length,
      emphasised: emphasised.length, reps,
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
    results.highlighted = await page.evaluate(() => {
      const amber = Object.entries(window.__viewer.scene.objects).filter(([, o]) => o.meshes?.some(m => m._colorizing) && o.colorize[0] > 0.9 && o.colorize[2] < 0.2);
      return { entities: amber.length, generated: amber.filter(([k]) => /#entity-\d+$/.test(k)).length };
    });
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
  results.ready = ready;
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
