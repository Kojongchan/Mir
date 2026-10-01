import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function compile(file, requireStub = () => { throw new Error('unexpected import'); }, env = {}, fetchStub) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', 'fetch', code)(exports, requireStub, { env }, fetchStub);
  return exports;
}
const { TileStream } = compile('src/viewer/TileStream.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('encoded budget and concurrency are enforced; moving does not hide loaded tiles', async () => {
  const jobs = new Map(), removed = [];
  let stats;
  const stream = new TileStream({ maxTiles: 3, maxEncodedBytes: 25, concurrency: 2,
    load: tile => new Promise(resolve => jobs.set(tile.id, resolve)),
    unload: tile => removed.push(tile.id), onChange: s => { stats = s; } });
  stream.select(['a', 'b', 'c'].map(id => ({ id, byteLength: 10 })));
  await flush();
  assert.deepEqual([...jobs.keys()], ['a', 'b']);
  assert.equal(stats.selected, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.encodedBytes, 20);
  jobs.get('a')(); jobs.get('b')(); await flush();
  stream.setPaused(true);
  assert.deepEqual(removed, []);
  assert.equal(stats.loaded, 2);
  stream.dispose();
});

test('LRU eviction runs before new loads and resident reservations stay within budget', async () => {
  const events = []; let stats;
  const stream = new TileStream({ maxTiles: 2, maxEncodedBytes: 20,
    load: async t => { events.push('load:' + t.id); },
    unload: t => events.push('unload:' + t.id), onChange: s => { stats = s; assert.ok(s.encodedBytes <= 20); } });
  stream.select([{ id: 'a', byteLength: 10 }, { id: 'b', byteLength: 10 }]);
  await flush();
  stream.select([{ id: 'b', byteLength: 10 }, { id: 'c', byteLength: 10 }]);
  await flush();
  assert.ok(events.indexOf('unload:a') < events.indexOf('load:c'));
  assert.equal(stats.loaded, 2);
  stream.dispose();
});

test('superseded download is aborted; late completion cannot update current scene', async () => {
  const jobs = new Map(), signals = new Map(); let stats;
  const stream = new TileStream({ maxTiles: 1, concurrency: 1,
    load: (t, signal) => new Promise(resolve => { jobs.set(t.id, resolve); signals.set(t.id, signal); }),
    unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'old' }]); await flush();
  stream.select([{ id: 'new' }]); await flush();
  assert.equal(signals.get('old').aborted, true);
  jobs.get('old')(); await flush();
  assert.equal(stats.loaded, 0);
  jobs.get('new')(); await flush();
  assert.equal(stats.loaded, 1);
  stream.dispose();
});

test('persistent errors stop after one delayed retry', async () => {
  let attempts = 0, stats;
  const stream = new TileStream({ retryMs: 5,
    load: async () => { attempts++; throw new Error('HTTP 403'); }, unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'expired' }]);
  await wait(35);
  assert.equal(attempts, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.loading, 0);
  stream.dispose();
});

test('dispose prevents a pending retry or load completion from updating UI', async () => {
  let calls = 0, changes = 0;
  const stream = new TileStream({ retryMs: 10, load: async () => { calls++; throw new Error('offline'); },
    unload: () => {}, onChange: () => { changes++; } });
  stream.select([{ id: 'a' }]); await flush();
  stream.dispose(); const before = changes;
  await wait(30);
  assert.equal(calls, 1);
  assert.equal(changes, before);
});

const env = { SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET: 'test' };
function api({ enabled = false, cache = false, withBranch = false } = {}) {
  const requests = [];
  const AwsClient = class {
    async fetch(url, options) {
      requests.push({ url, method: options?.method ?? 'GET' });
      if (cache && url.endsWith('/xkt/manifest.json')) return new Response(JSON.stringify({ xktFiles: ['c0.xkt'] }));
      return new Response('', { status: 404 });
    }
    async sign(url) { return { url }; }
  };
  const handler = compile('api/aps-convert.ts', name => {
    if (name === 'aws4fetch') return { AwsClient };
    if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'tester' } } }) } }) };
    throw new Error(name);
  }, { ...env, ENABLE_MODEL_CONVERSION: enabled ? 'true' : '', GH_REPO: 'test/repo', GH_TOKEN: 'test', GH_REF: withBranch ? 'test-branch' : '' },
  async () => { throw new Error('must not dispatch workflow'); }).default;
  return { handler, requests };
}
function request(body) {
  return new Request('https://example.test/api/aps-convert', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ urn: 'test-urn', ...body }) });
}
test('cost-disabled forced rebuild neither deletes cache nor dispatches work', async () => {
  const { handler, requests } = api();
  const r = await handler(request({ force: true, ackOverage: true }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'CONVERSION_DISABLED');
  assert.deepEqual(requests, []);
});

test('existing cached models remain readable when new conversion is disabled', async () => {
  const { handler, requests } = api({ cache: true });
  const r = await handler(request({}));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ready, true);
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('conversion with an unspecified branch fails before any storage mutation', async () => {
  const { handler, requests } = api({ enabled: true });
  const r = await handler(request({ force: true }));
  assert.equal(r.status, 503);
  assert.deepEqual(requests, []);
});

test('storage usage failure blocks conversion even with a legacy cost override', async () => {
  const { handler, requests } = api({ enabled: true, withBranch: true });
  const r = await handler(request({ force: true, ackOverage: true }));
  assert.equal(r.status, 503);
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('actual tile bytes cannot bypass the budget of a legacy manifest', async () => {
  const jobs = new Map(); let stats;
  const stream = new TileStream({ maxEncodedBytes: 30, fallbackBytes: 10,
    load: t => new Promise(resolve => jobs.set(t.id, resolve)), unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); await flush();
  assert.equal(stream.accountBytes('a', 21), false);
  assert.equal(stream.accountBytes('a', 20), true);
  jobs.get('a')(); jobs.get('b')(); await flush();
  assert.equal(jobs.has('c'), false);
  assert.equal(stats.encodedBytes, 30);
  stream.dispose();
});

// Exercise the actual existing-SVF gate without importing the heavyweight conversion pipeline.
function existingSvfGate(state) {
  const source = ts.createSourceFile('convert4d.mjs', fs.readFileSync('scripts/convert4d.mjs', 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['scanManifest', 'ensureSvf']);
  const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text)).map(n => n.getText(source)).join('\n');
  let calls = 0;
  const gate = new Function('ModelDerivativeClient', 'AuthenticationClient', 'Scopes', 'APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_REGION', 'fetch',
    functions + '\nreturn ensureSvf;')(
    class { async getManifest() { return state; } }, class { async getTwoLeggedToken() { return { access_token: 'test' }; } },
    { ViewablesRead: 'viewables:read' }, 'test', 'test', 'US', () => { calls++; throw new Error('unexpected external request'); });
  return { gate, calls: () => calls };
}

test('missing SVF fails without requesting a cloud conversion job', async () => {
  const { gate, calls } = existingSvfGate({ derivatives: [] });
  await assert.rejects(gate('test'), /기존 SVF/);
  assert.equal(calls(), 0);
});

test('existing SVF can be consumed without requesting a cloud conversion job', async () => {
  const { gate, calls } = existingSvfGate({ derivatives: [{ children: [{ role: 'graphics', mime: 'application/autodesk-svf' }] }] });
  await gate('test');
  assert.equal(calls(), 0);
});

test('a stalled network request releases its slot and eventually stops retrying', async () => {
  let attempts = 0, stats;
  const stream = new TileStream({ retryMs: 2, loadTimeoutMs: 5,
    load: () => { attempts++; return new Promise(() => {}); }, unload: () => {}, onChange: s => { stats = s; } });
  stream.select([{ id: 'stalled' }]);
  await wait(40);
  assert.equal(attempts, 2);
  assert.equal(stats.loading, 0);
  assert.equal(stats.failed, 1);
  stream.dispose();
});

const { NavigationQuality } = compile('src/viewer/NavigationQuality.ts');
test('quality never restores during a held drag, even across slow frames', async () => {
  let entered = 0, restored = 0;
  const q = new NavigationQuality({ enter: () => entered++, leave: () => restored++, delayMs: 10 });
  q.hold(true);
  await wait(30);
  q.moved();
  await wait(30);
  assert.equal(entered, 1);
  assert.equal(restored, 0);
  q.hold(false);
  await wait(30);
  assert.equal(restored, 1);
  q.dispose();
});
test('quality restore waits for inactivity and disposal cancels pending work', async () => {
  let restored = 0;
  const q = new NavigationQuality({ enter: () => {}, leave: () => restored++, delayMs: 30 });
  q.moved();
  await wait(20);
  q.moved();
  await wait(20);
  assert.equal(restored, 0);
  q.dispose();
  assert.equal(restored, 1);
  await wait(40);
  q.moved();
  assert.equal(restored, 1);
});

const { rankTileRegion } = compile('src/viewer/TileRegion.ts');
test('initial destination selects distant structures while an old camera position would select none', () => {
  const tiles = [{ id: 'bridge', cx: 5000, cy: 50, cz: 3600, r: 100 }];
  assert.equal(rankTileRegion(tiles, [0, 0, 0], 500).length, 0);
  assert.deepEqual(rankTileRegion(tiles, [5000, 50, 3600], 500, true), tiles);
});
test('empty initial focus falls back to a nearby structure cluster, manual empty regions stay empty', () => {
  const tiles = [{ id: 'near', cx: 5000, cy: 0, cz: 0, r: 50 }, { id: 'far', cx: 15000, cy: 0, cz: 0, r: 50 }];
  assert.deepEqual(rankTileRegion(tiles, [0, 0, 0], 500, true).map(t => t.id), ['near']);
  assert.deepEqual(rankTileRegion(tiles, [0, 0, 0], 500), []);
  assert.deepEqual(rankTileRegion([], [0, 0, 0], 500, true), []);
  assert.deepEqual(rankTileRegion(tiles, [NaN, 0, 0], 500, true), []);
  assert.equal(tiles.length, 2);
});

const { regionNeedsRefresh, safeDollyFactor } = compile('src/viewer/TileRegion.ts');
test('orbit keeps its region while a move to the reported camera location refreshes it', () => {
  const previous = { center: [4078, -55, 2600], distance: 500 };
  assert.equal(regionNeedsRefresh(previous, [...previous.center], 500), false);
  assert.equal(regionNeedsRefresh(previous, [4080, -55, 2602], 505), false);
  assert.equal(regionNeedsRefresh(previous, [5357, 64, 3880], 500), true);
  assert.equal(regionNeedsRefresh(previous, [...previous.center], 200), true);
});
test('repeated wheel zoom cannot move its target inside the clipping safety margin', () => {
  let distance = 500;
  for (let i = 0; i < 100; i++) distance *= safeDollyFactor(distance, 0.82, 0.5);
  assert.ok(distance >= 2 - 1e-9);
  assert.ok(0.225 * safeDollyFactor(0.225, 0.82, 0.5) >= 2 - 1e-9);
  assert.equal(safeDollyFactor(10, 1.18, 0.5), 1.18);
});

const { readBounded } = compile('src/viewer/readBounded.ts');
test('sample export bounds streamed bytes without relying on Content-Length', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readBounded(new Response(new Uint8Array(9)), 8, signal), /제한/);
  assert.deepEqual(await readBounded(new Response(new Uint8Array([1, 2, 3])), 8, signal), new Uint8Array([1, 2, 3]));
});
test('sample export rejects oversized headers and cancelled reads', async () => {
  await assert.rejects(readBounded(new Response('abc', { headers: { 'content-length': '100' } }), 8, new AbortController().signal), /제한/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBounded(new Response('abc'), 8, controller.signal), /취소/);
});

test('legacy size estimates are replanned after actual bytes arrive without another camera move', async () => {
  let stats; const loaded = [];
  const stream = new TileStream({ maxTiles: 4, maxEncodedBytes: 40, fallbackBytes: 16, concurrency: 1,
    load: async tile => { assert.equal(stream.accountBytes(tile.id, 8), true); loaded.push(tile.id); },
    unload: () => {}, onChange: s => { stats = s; assert.ok(s.encodedBytes <= 40); } });
  stream.select(['a', 'b', 'c', 'd'].map(id => ({ id })));
  await flush();
  assert.deepEqual(loaded, ['a', 'b', 'c', 'd']);
  assert.equal(stats.loaded, 4);
  stream.dispose();
});

test('long structure intersecting the focus outranks a closer centre outside it', () => {
  const bridge = { id: 'bridge', cx: 500, cy: 0, cz: 0, r: 501, worldAabb: [0,-1,-1,1000,1,1] };
  const detail = { id: 'detail', cx: 30, cy: 0, cz: 0, r: 1, worldAabb: [29,-1,-1,31,1,1] };
  const offAxis = { id: 'off-axis', cx: 500, cy: 0, cz: 200, r: 501, worldAabb: [0,-1,199,1000,1,201] };
  assert.deepEqual(rankTileRegion([detail, offAxis, bridge], [0,0,0], 50).map(t => t.id), ['bridge','detail']);
});

test('measured growth evicts stale cached tiles before rejecting a wanted tile', async () => {
  const removed = []; let stats;
  const stream = new TileStream({maxTiles: 3, maxEncodedBytes: 30, fallbackBytes: 10, concurrency: 1,
    load: async t => { if (t.id === 'new') assert.equal(stream.accountBytes(t.id, 25), true); },
    unload: t => removed.push(t.id), onChange: s => { stats = s; assert.ok(s.encodedBytes <= 30); }});
  stream.select([{id:'old',byteLength:10}]); await flush();
  stream.select([{id:'new'}]); await flush();
  assert.deepEqual(removed, ['old']); assert.equal(stats.loaded, 1); assert.equal(stats.failed, 0);
  stream.dispose();
});

test('small chunks are not cut off at 24 when byte budget permits', async () => {
  let stats;
  const stream = new TileStream({ maxTiles: Infinity, maxEncodedBytes: 100,
    load: async () => {}, unload: () => {}, onChange: s => stats = s });
  stream.select(Array.from({length: 40}, (_, i) => ({id: String(i), byteLength: 1})));
  for (let i = 0; i < 45; i++) await flush();
  assert.equal(stats.loaded, 40);
  assert.equal(stats.encodedBytes, 40);
  stream.dispose();
});

const { NavigationLoadGate } = compile('src/viewer/NavigationLoadGate.ts');
test('download completion waits for navigation to stop before model work', async () => {
  const gate = new NavigationLoadGate();
  gate.setPaused(true);
  let started = false;
  const work = gate.wait(new AbortController().signal).then(() => { started = true; });
  await flush(); assert.equal(started, false);
  gate.setPaused(false); await work; assert.equal(started, true);
  gate.dispose();
});
test('cancelled and disposed model work never resumes after navigation', async () => {
  const gate = new NavigationLoadGate(); gate.setPaused(true);
  const controller = new AbortController();
  const cancelled = assert.rejects(gate.wait(controller.signal), /cancelled/);
  controller.abort(); await cancelled;
  const disposed = assert.rejects(gate.wait(new AbortController().signal), /cancelled/);
  gate.dispose(); await disposed;
  gate.setPaused(false);
  await assert.rejects(gate.wait(new AbortController().signal), /cancelled/);
});

test('explicit complete region loads all 195 candidates past the old byte ceiling; returning releases excess', async () => {
  let stats;
  const live = new Set();
  const stream = new TileStream({ maxTiles: Infinity, maxEncodedBytes: 192, concurrency: 2,
    load: async t => { live.add(t.id); }, unload: t => live.delete(t.id), onChange: s => stats = s });
  stream.select(Array.from({length: 195}, (_, i) => ({id: `piece${i}`, byteLength: 8.3})));
  for (let i=0; i<200; i++) await flush();
  assert.equal(stats.loaded, 23);
  stream.setLimits({maxTiles: Infinity, maxEncodedBytes: Infinity, concurrency: 1});
  for (let i=0; i<210; i++) await flush();
  assert.equal(stats.loaded, 195);
  assert.equal(stats.failed, 0);
  assert.equal(live.size, 195);
  stream.setLimits({maxTiles: Infinity, maxEncodedBytes: 192, concurrency: 2});
  assert.equal(stats.loaded, 23);
  assert.ok(stats.encodedBytes <= 192);
  assert.equal(live.size, 23);
  stream.dispose();
});
test('stop cancels outstanding requests, retains loaded pieces and supports resume', async () => {
  const jobs = new Map(), live = new Set(); let stats;
  const stream = new TileStream({maxTiles: Infinity, maxEncodedBytes: Infinity, concurrency: 1,
    load: t => new Promise(resolve => jobs.set(t.id, () => {live.add(t.id); resolve();})),
    unload: t => live.delete(t.id), onChange: s => stats=s});
  stream.select([{id:'a',byteLength:1},{id:'b',byteLength:1}]);
  await flush(); jobs.get('a')(); await flush();
  stream.stopLoading();
  assert.equal(stats.loaded, 1); assert.equal(stats.loading, 0);
  assert.deepEqual([...live], ['a']);
  stream.setPaused(false); await flush(); jobs.get('b')(); await flush();
  assert.equal(stats.loaded, 2);
  stream.dispose();
});

test('held drag prevents parsing even if the camera stops emitting movement', async () => {
  const gate = new NavigationLoadGate();
  gate.hold(true); gate.setPaused(true);
  let admitted = false;
  const work = gate.wait(new AbortController().signal).then(() => admitted = true);
  gate.setPaused(false); await flush(); assert.equal(admitted, false);
  gate.setPaused(true); gate.hold(false); await flush(); assert.equal(admitted, false);
  gate.setPaused(false); await work; assert.equal(admitted, true);
  gate.dispose();
});
const { NavigationResolution } = compile('src/viewer/NavigationResolution.ts');
test('slow navigation lowers only resolution and restores full quality after motion', () => {
  const applied = [];
  const quality = new NavigationResolution(s => applied.push(s));
  quality.begin();
  for (let i=0; i<80; i++) quality.sample(157);
  assert.equal(applied[0], 0.5);
  assert.equal(applied.at(-1), 0.25);
  assert.ok(applied.every(n => n >= 0.25));
  quality.end(); assert.equal(applied.at(-1), 1);
  for (let i=0; i<16; i++) quality.sample(200);
  assert.equal(applied.at(-1), 1);
});
test('normal navigation avoids unnecessary resolution changes', () => {
  const applied = []; const quality = new NavigationResolution(s => applied.push(s));
  quality.begin(); for(let i=0;i<32;i++) quality.sample(16);
  assert.deepEqual(applied, [0.5]); quality.end();
  assert.deepEqual(applied, [0.5, 1]);
});

const { viewPlanes, inTileView, prioritizeTileView } = compile('src/viewer/TileView.ts');
const identity4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
test('view selection preserves crossing bridges, boundaries and invalid bounds', () => {
  const planes = viewPlanes(identity4, identity4);
  assert.equal(inTileView([-5,-.1,-1,5,.1,1], planes), true);
  assert.equal(inTileView([1.2,0,0,2,1,1], planes), true);
  assert.equal(inTileView([2,0,0,3,1,1], planes), false);
  assert.equal(inTileView([0,0,-1e8,1,1,1e8], planes), true);
  assert.equal(inTileView([NaN,0,0,1,1,1], planes), true);
  assert.equal(inTileView([2,0,0,1,1,1], planes), true);
  assert.equal(inTileView([2,0,0,3,1,1], viewPlanes([], identity4)), true);
});
test('large survey coordinates and rotated views agree with homogeneous corner clipping', () => {
  const projection = [1.3,0,0,0, 0,1.7,0,0, 0,0,-1.0001,-1, 0,0,-.2,0];
  for (let step = 0; step < 72; step++) {
    const a = step * Math.PI / 36, c = Math.cos(a), s = Math.sin(a);
    const x = 230000, y = 450000;
    const view = [c,s,0,0, -s,c,0,0, 0,0,1,0, -c*x+s*y,-s*x-c*y,-50,1];
    const planes = viewPlanes(view, projection, 0);
    for (let i = 0; i < 20; i++) {
      const box = [x+i*10-90,y-2,-5,x+i*10-82,y+2,5];
      const corners = [];
      for (const bx of [box[0],box[3]]) for (const by of [box[1],box[4]]) for (const bz of [box[2],box[5]]) {
        const input = [bx,by,bz,1];
        const v = [0,1,2,3].map(row => input.reduce((sum,n,col) => sum + view[col*4+row]*n, 0));
        corners.push([0,1,2,3].map(row => v.reduce((sum,n,col) => sum + projection[col*4+row]*n, 0)));
      }
      const expected = ![0,1].some(axis => [-1,1].some(sign => corners.every(v => v[3]+sign*v[axis] < -1e-6)));
      assert.equal(inTileView(box, planes), expected);
    }
  }
});
test('visible downloads outrank offscreen files without removing any region candidates', () => {
  const off = { id:'off', worldAabb:[3,0,0,4,1,1] };
  const near = { id:'near', worldAabb:[0,0,0,.1,.1,.1] };
  const far = { id:'far', worldAabb:[.5,0,0,.6,.1,.1] };
  const tiles = [off,far,near];
  assert.deepEqual(prioritizeTileView(tiles, viewPlanes(identity4,identity4), [0,0,0]).map(t=>t.id), ['near','far','off']);
  assert.deepEqual(tiles.map(t=>t.id), ['off','far','near']);
});
test('camera reprioritization retains residents and active download and eventually completes the region', async () => {
  const jobs = new Map(), started = [], removed = []; let stats;
  const stream = new TileStream({ maxTiles:Infinity, maxEncodedBytes:Infinity, concurrency:1,
    load:t => new Promise(resolve => { started.push(t.id); jobs.set(t.id,resolve); }),
    unload:t => removed.push(t.id), onChange:s => { stats=s; } });
  stream.select(['a','b','c','d'].map(id=>({id,byteLength:1})));
  await flush(); jobs.get('a')(); await flush();
  stream.prioritize(['d','c','b','a']);
  await flush(); assert.deepEqual(started,['a','b']);
  jobs.get('b')(); await flush(); assert.deepEqual(started,['a','b','d']);
  jobs.get('d')(); await flush(); jobs.get('c')(); await flush();
  assert.equal(stats.loaded,4); assert.equal(stats.total,4); assert.deepEqual(removed,[]);
  stream.dispose();
});

const { ModelLoadQueue } = compile('src/viewer/ModelLoadQueue.ts');
test('model queue serializes completed downloads and release is idempotent', async () => {
  const queue = new ModelLoadQueue(), signal = new AbortController().signal;
  const releaseA = await queue.acquire(signal);
  let admittedB = false, admittedC = false;
  const b = queue.acquire(signal).then(release => { admittedB = true; return release; });
  const c = queue.acquire(signal).then(release => { admittedC = true; return release; });
  await flush(); assert.equal(admittedB, false);
  releaseA(); const releaseB = await b;
  releaseA(); await flush(); assert.equal(admittedC, false);
  releaseB(); (await c)(); queue.dispose();
});
test('cancelled or disposed queued model work never enters the renderer', async () => {
  const queue = new ModelLoadQueue(), a = new AbortController(), b = new AbortController();
  const release = await queue.acquire(a.signal);
  const cancelled = assert.rejects(queue.acquire(b.signal), /cancelled/);
  b.abort(); await cancelled;
  const disposed = assert.rejects(queue.acquire(a.signal), /cancelled/);
  queue.dispose(); await disposed; release();
  await assert.rejects(queue.acquire(a.signal), /cancelled/);
});
test('two pipeline slots download ahead while one model loads, retaining complete coverage', async () => {
  const queue = new ModelLoadQueue(), downloads = new Map(), parsed = [], parseJobs = new Map();
  let stats;
  const stream = new TileStream({ concurrency:2, maxTiles:Infinity, maxEncodedBytes:Infinity,
    load:async (t, signal) => {
      await new Promise(resolve => downloads.set(t.id, resolve));
      const release = await queue.acquire(signal);
      try { parsed.push(t.id); await new Promise(resolve => parseJobs.set(t.id, resolve)); }
      finally { release(); }
    }, unload:()=>{}, onChange:s=>{stats=s;} });
  stream.select(['a','b','c'].map(id=>({id,byteLength:1})));
  await flush(); assert.deepEqual([...downloads.keys()], ['a','b']);
  downloads.get('a')(); await flush(); downloads.get('b')(); await flush();
  assert.deepEqual(parsed,['a']);
  parseJobs.get('a')(); await flush(); assert.deepEqual(parsed,['a','b']);
  assert.ok(downloads.has('c')); // c downloads while b is still constructing.
  downloads.get('c')(); await flush(); assert.deepEqual(parsed,['a','b']);
  parseJobs.get('b')(); await flush(); parseJobs.get('c')(); await flush();
  assert.equal(stats.loaded,3); queue.dispose(); stream.dispose();
});

const { prioritizeCameraView } = compile('src/viewer/TileView.ts');
test('dolly prioritizes screen center and eye distance without losing long crossing geometry', () => {
 const tiles = [
  {id:'edge',worldAabb:[.7,0,0,.8,.1,.1]},
  {id:'far-center',worldAabb:[0,0,8,.1,.1,9]},
  {id:'crossing',worldAabb:[-4,-.1,1,4,.1,2]},
  {id:'near-center',worldAabb:[0,0,.2,.1,.1,.3]},
  {id:'offscreen',worldAabb:[3,0,0,4,1,1]},
 ];
 const ordered=prioritizeCameraView(tiles,identity4,identity4,[0,0,0]);
 assert.deepEqual(ordered.map(t=>t.id),['near-center','crossing','far-center','edge','offscreen']);
 assert.equal(new Set(ordered).size,tiles.length);
 assert.equal(tiles[0].id,'edge');
});
test('zoom reprioritization during paused loading determines the next request', async () => {
 const started=[],jobs=new Map();
 const stream=new TileStream({maxTiles:Infinity,maxEncodedBytes:Infinity,concurrency:1,
 load:t=>new Promise(r=>{started.push(t.id);jobs.set(t.id,r)}),unload:()=>{},onChange:()=>{}});
 stream.select(['active','old-target','zoom-target'].map(id=>({id,byteLength:1})));
 await flush();stream.setPaused(true);stream.prioritize(['zoom-target','old-target','active']);
 jobs.get('active')();await flush();assert.deepEqual(started,['active']);
 stream.setPaused(false);await flush();assert.deepEqual(started,['active','zoom-target']);
 jobs.get('zoom-target')();await flush();jobs.get('old-target')();await flush();stream.dispose();
});
