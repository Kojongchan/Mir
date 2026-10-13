// Phone / tablet layout check of the whole app (local, no secrets): the real build with Supabase and the APIs answered
// locally (sample rows, signed-in admin), every project screen at several viewports. Per screen: horizontal page
// overflow, elements that run past the screen edge (outside any scrolling box), touch targets smaller than 32 px, and
// screenshots. The 3D page 2 opens the small test model (RC_TILES_DIR, laid out like the bucket, e.g. the ui-check
// fixture) when given.
//   node scripts/responsive-check.mjs [outDir]   RC_ONLY="phone,tablet" RC_PAGES="model-test-2,issues"
/* global window, document, getComputedStyle, innerWidth, innerHeight */ // page.evaluate callbacks run in the browser
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || 'responsive-out');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log('[responsive]', ...a);

// ── Build the app against a stand-in Supabase origin ────────────────────────────────────────────
const dist = path.join(root, '.responsive-check');
{
  await import('./copy-wasm.mjs');
  const { build } = await import('vite');
  process.env.VITE_SUPABASE_URL = 'http://x.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'k';
  await build({ root, logLevel: 'warn', build: { outDir: dist, emptyOutDir: true, chunkSizeWarningLimit: 100000 } });
}

// ── Sample data ─────────────────────────────────────────────────────────────────────────────────
const U = '00000000-0000-4000-8000-0000000000a1', P = '784ab8b8-2a64-47ec-81cf-6490b4d4d3ed';
const now = Date.now(), day = 86400000, iso = d => new Date(now + d * day).toISOString();
const rows = {
  profiles: [{ id: U, username: 'admin', full_name: '관리자', is_admin: true }],
  projects: [{ id: P, name: '평택-오송 2복선화 제5공구 건설공사', code: 'PO05', client: '국가철도공단', category: '토목/철도',
    acc_hub_id: 'b.h', acc_project_id: 'b.p', acc_root_folder_id: 'F', acc_root_folder_name: '루트' }],
  project_members: [{ project_id: P, user_id: U, role: 'admin', created_at: iso(-90), profiles: { username: 'admin', full_name: '관리자' } }],
  project_info: [{ project_id: P, start_date: iso(-400).slice(0, 10), end_date: iso(800).slice(0, 10), progress_pct: 31.2,
    summary: '평택-오송 2복선화 제5공구 노반·교량·터널', updated_at: iso(-1) }],
  // The last milestone sits close to 준공 (labels must not overlap: the deployed 터널 완료 / 준공 pair).
  project_milestones: [0, 1, 2, 3].map(k => ({ id: `m${k}`, project_id: P, name: ['노반 완료', '교량 상부 완료', '궤도 착수', 'OO 터널 완료'][k], target_date: iso([-30, 90, 210, 690][k]).slice(0, 10), sort_order: k })),
  issues: ['교각 P3 철근 간섭', '터널 갱문 배수 확인 요청(RFI)', '방음벽 기초 위치 오류', '안전난간 누락', '사면 녹화 구간 재검토'].map((title, k) => ({
    id: `i${k}`, project_id: P, type: ['general', 'rfi', 'punch', 'safety', 'quality'][k], meta: {}, category_id: null, title,
    description: '현장 확인 결과 도면과 모델이 다릅니다. 담당자 확인 바랍니다.', status: ['open', 'in_progress', 'resolved', 'open', 'closed'][k],
    priority: ['high', 'medium', 'low', 'high', 'medium'][k], assignee_id: U, assignee_name: '관리자', due_date: iso(k * 3).slice(0, 10),
    model_id: null, express_id: null, global_id: null, global_id_b: null, viewpoint_id: null, created_by: U, created_by_name: '관리자',
    created_at: iso(-k - 1), updated_at: iso(-k) })),
  daily_logs: [0, 1, 2].map(k => ({ id: `l${k}`, project_id: P, log_date: iso(-k).slice(0, 10), weather: '맑음', content: '교각 P3 거푸집 설치, 터널 굴착 12m',
    manpower: 42 - k, equipment: 7 + k, created_by: U, created_at: iso(-k) })),
  posts: [0, 1, 2].map(k => ({ id: `p${k}`, project_id: P, title: ['주간 공정회의 결과', '안전교육 일정 안내', '자재 반입 일정'][k], body: '내용',
    author_id: U, author_name: '관리자', created_at: iso(-k), pinned: k === 0 })),
  notifications: [{ id: 'n1', user_id: U, project_id: P, title: '이슈가 배정되었습니다', body: '교각 P3 철근 간섭', is_read: false, created_at: iso(0), link: null }],
  schedules: [{ id: 's1', project_id: P, name: '전체 공정표', created_at: iso(-30) }],
  schedule_tasks: [0, 1, 2, 3, 4].map(k => ({ id: `t${k}`, schedule_id: 's1', project_id: P, name: ['토공', '교량 하부', '교량 상부', '터널 굴착', '궤도'][k],
    start_date: iso(k * 30 - 60).slice(0, 10), end_date: iso(k * 30 + 20).slice(0, 10), progress: [100, 70, 20, 45, 0][k], sort_order: k })),
  billing_items: [], subcontracts: [], monthly_records: ['2025-06', '2025-12', '2026-03', '2026-06'].map((ym, k) => ({ id: `r${k}`, project_id: P, ym, planned_pct: [20, 40, 52, 65][k], actual_pct: [15, 35, 50, 60][k],
    billing_amount: [890000000, 98880000, 2470000000, 12740000000][k] })), folders: [], files: [], drawings: [], models: [],
};

// ── Local server: the build (SPA fallback) and the test model's files under /r2/ ──────────────────
const tilesDir = env.RC_TILES_DIR ? path.resolve(env.RC_TILES_DIR) : '';
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname.startsWith('/r2/') && tilesDir) {
    const f = path.join(tilesDir, decodeURIComponent(u.pathname.slice(4)));
    if (!f.startsWith(tilesDir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(f);
    res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      ...(body[0] === 0x1f && body[1] === 0x8b ? { 'content-encoding': 'gzip' } : {}) });
    res.end(body);
    return;
  }
  let f = path.join(dist, path.normalize(decodeURIComponent(u.pathname)));
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The test model for page 2: its tileset run and model index, as the API would answer.
let model = null;
if (tilesDir) {
  const prefix = fs.readdirSync(tilesDir).find(d => fs.existsSync(path.join(tilesDir, d, 'tiles3d/current.json')));
  if (prefix) {
    const read = p => { const b = fs.readFileSync(path.join(tilesDir, prefix, p)); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString()); };
    const current = read('tiles3d/current.json'), pointer = read('meta/current.json');
    model = { prefix, current, pointer };
  }
}

// ── Viewports ───────────────────────────────────────────────────────────────────────────────────
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE },
  'small-phone': { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: ANDROID },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD },
  'tablet-landscape': { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD },
  desktop: { viewport: { width: 1440, height: 900 } },
};
const PAGES = ['', 'schedule', 'logs', 'issues', 'billing', 'subcontracts', 'board', 'model', 'viewer', 'clash', 'model-test', 'model-test-2',
  'quantities', 'drawings', 'docs', 'members'];
const only = (env.RC_ONLY || 'phone,small-phone,tablet,tablet-landscape').split(',');
const pages = env.RC_PAGES ? env.RC_PAGES.split(',') : PAGES;

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: U, exp: Math.floor(now / 1000) + 86400, role: 'authenticated' })}.sig`;
const user = { id: U, aud: 'authenticated', role: 'authenticated', email: 'admin@mir.local', user_metadata: { username: 'admin' }, app_metadata: {} };
const session = { access_token: jwt, refresh_token: 'r', expires_in: 86400, expires_at: Math.floor(now / 1000) + 86400, token_type: 'bearer', user };

async function routeSupabase(r) {
  const u = new URL(r.request().url());
  if (u.pathname.startsWith('/auth/v1/user')) return r.fulfill({ json: user });
  if (u.pathname.startsWith('/auth/v1/')) return r.fulfill({ json: session });
  const m = /^\/rest\/v1\/([a-z_]+)/.exec(u.pathname);
  if (m) {
    const data = rows[m[1]] ?? [];
    const single = (r.request().headers().accept || '').includes('vnd.pgrst.object+json');
    if (r.request().method() !== 'GET') return r.fulfill({ status: 201, json: single ? data[0] ?? {} : data });
    return r.fulfill({ json: single ? data[0] ?? null : data, headers: { 'content-range': `0-${Math.max(0, data.length - 1)}/${data.length}` } });
  }
  return r.fulfill({ status: 404, json: {} });
}
async function routeApi(r) {
  const u = new URL(r.request().url());
  if (u.pathname === '/api/aps-acc') return r.fulfill({ json: { folders: [], items: [{ id: 'I1', name: '평택-오송 5공구_통합모델.nwd', urn: 'urnRC' }] } });
  if (u.pathname === '/api/aps-convert' && model) {
    const meta = `/r2/${model.prefix}/meta/${model.pointer.gen}`;
    if (u.searchParams.get('metaShards') === 'all') return r.fulfill({ json: { urls: Array.from({ length: model.pointer.shardCount }, (_, k) => `${base}${meta}/p/${k}.json`) } });
    if (u.searchParams.has('metaShard')) return r.fulfill({ json: { url: `${base}${meta}/p/${u.searchParams.get('metaShard')}.json` } });
    if (u.searchParams.get('tiles3d') === '1') {
      return r.fulfill({ json: { run: model.current.run, builtAt: model.current.builtAt, expiresIn: 14400,
        urls: Object.fromEntries(model.current.files.map(f => [f, `${base}/r2/${model.prefix}/tiles3d/${model.current.run}/${f}?X-Amz-Signature=rc`])) } });
    }
    return r.fulfill({ json: { ready: true, xkt: true, urls: [], tiles: [], meta: { tree: `${base}${meta}/tree.json`, shardSize: model.pointer.shardSize,
      shardCount: model.pointer.shardCount, objects: model.pointer.objects ?? 0 } } });
  }
  return r.fulfill({ status: 404, json: { error: 'not in the responsive check' } });
}

/** Layout problems on the current screen. */
const inspect = () => {
  const W = innerWidth;
  const clipped = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
    }
    return false;
  };
  const name = el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const past = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const over = Math.max(r.right - W, -r.left);
    if (over > 1 && !clipped(el) && !(el.parentElement && past.some(p => p.el === el.parentElement))) past.push({ el, over: Math.round(over) });
  }
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, textarea, summary')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > W) continue;
    if (Math.min(r.width, r.height) < 32 && el.type !== 'checkbox' && el.type !== 'radio') small.push(`${name(el)}${el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 14)}"` : ''} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return { overflowX: document.documentElement.scrollWidth - W, past: past.sort((a, b) => b.over - a.over).slice(0, 8).map(p => `${name(p.el)} +${p.over}px`),
    smallTargets: small.length, smallExamples: small.slice(0, 8) };
};

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const report = {};
for (const vp of only) {
  const context = await browser.newContext(VIEWPORTS[vp]);
  await context.addInitScript(([key, s]) => { window.localStorage.setItem(key, JSON.stringify(s)); }, ['sb-x-auth-token', session]);
  await context.route('http://x.test/**', routeSupabase);
  await context.route('**/api/**', routeApi);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  report[vp] = {};
  for (const p of pages) {
    const url = `${base}/project/${P}${p ? `/${p}` : ''}`;
    errors.length = 0;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const shot = async tag => {
        const file = `${vp}-${p || 'dashboard'}${tag ? `-${tag}` : ''}.png`;
        await page.screenshot({ path: path.join(out, file), timeout: 60000 }).catch(e => log('shot failed', file, e.message));
        return { file, ...(await page.evaluate(inspect)) };
      };
      const entry = report[vp][p || 'dashboard'] = { initial: await shot('') };
      if (p === 'model-test-2' && model) {
        await page.getByRole('button', { name: 'ACC에서 열기' }).click();
        await page.locator('.acc-picker-row', { hasText: '통합모델' }).first().click();
        await page.waitForSelector('.threed-test2__stats', { timeout: 120000 }).catch(() => {});
        await page.waitForTimeout(6000);
        entry.open = await shot('open');
        const props = page.getByRole('button', { name: '속성', exact: true });
        if (await props.count() && !(await page.locator('.prop-panel').count())) { await props.click(); await page.waitForTimeout(800); entry.props = await shot('props'); }
      }
      entry.errors = [...errors];
      log(vp, p || 'dashboard', JSON.stringify({ overflowX: entry.initial.overflowX, past: entry.initial.past.slice(0, 3), small: entry.initial.smallTargets, errors: errors.length }));
    } catch (e) {
      report[vp][p || 'dashboard'] = { error: e.message.slice(0, 300) };
      log(vp, p, 'failed', e.message.slice(0, 200));
    }
  }
  await context.close();
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
server.close();
log('done', out);
