// Browser smoke test of the production build (`npm run test:e2e`).
// Builds the app against a fake Supabase host, serves it, and drives Chromium through every
// menu with a mocked signed-in admin and empty data. Fails on uncaught errors, error-boundary
// screens, and a first-load JavaScript budget overrun. No real backend or credentials involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.join(ROOT, 'node_modules', '.cache', 'e2e-dist');
const SUPABASE = 'http://supabase.e2e';
const SESSION_KEY = 'sb-supabase-auth-token'; // supabase-js: sb-<first host label>-auth-token
/** gzip KB of the JS the browser fetches before the first screen (entry + modulepreload). */
const FIRST_LOAD_BUDGET_KB = 200;
const ERROR_BOUNDARY_TEXT = '이 화면을 표시하는 중 문제가 발생했습니다';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT = { id: '00000000-0000-4000-8000-0000000000aa', name: 'E2E 프로젝트', code: 'E2E',
  acc_hub_id: 'b.hub', acc_project_id: 'b.proj', acc_root_folder_id: 'F-root', acc_root_folder_name: '프로젝트 파일' };
/** Fake ACC folder tree behind /api/aps-acc (자료 관리). */
const ACC_TREE = {
  'F-root': { folders: [{ id: 'F-a', name: '01.도면' }, { id: 'F-b', name: '02.문서' }], items: [] },
  'F-a': { folders: [], items: [{ id: 'I-1', name: '평면도.pdf', urn: null, lastModified: '2026-10-01T00:00:00Z', size: 1024 }] },
  'F-b': { folders: [], items: [] },
};
const POST_TITLE = 'E2E 공지사항';
const FIXTURES = {
  profiles: [{ id: USER_ID, username: 'e2e', full_name: 'E2E 관리자', is_admin: true }],
  projects: [PROJECT],
  posts: [{ id: '00000000-0000-4000-8000-0000000000b1', project_id: PROJECT.id, title: POST_TITLE, body: '본문',
    pinned: false, author_name: 'E2E 관리자', created_at: '2026-10-01T00:00:00Z' }],
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

let server, base, browser;

before(async () => {
  if (!process.env.E2E_SKIP_BUILD || !existsSync(path.join(OUT, 'index.html'))) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: 'e2e-anon-key' },
    });
    assert.equal(r.status, 0, 'vite build failed');
  }
  // Static server with SPA fallback (deep links resolve to index.html like on Vercel).
  server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(OUT, url);
    if (!file.startsWith(OUT) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(OUT, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
});

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeSession() {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'e2e@mir.local',
    app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const access_token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: USER_ID, exp, role: 'authenticated', aud: 'authenticated' })}.e2e`;
  return { access_token, token_type: 'bearer', expires_in: 24 * 3600, expires_at: exp, refresh_token: 'e2e-refresh', user };
}

/** Mocked backend: Supabase REST/auth/storage from fixtures, app APIs unavailable, no outside network. */
async function mockBackend(context) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === base) {
      if (url.pathname === '/api/aps-acc' && url.searchParams.get('action') === 'contents') {
        const listing = ACC_TREE[url.searchParams.get('folder')];
        return listing ? route.fulfill({ json: listing }) : route.fulfill({ status: 404, json: { error: 'no such folder' } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'not available in e2e' } });
      return route.continue();
    }
    if (url.origin !== SUPABASE) return route.abort(); // fonts, Autodesk viewer, CDNs: offline on purpose
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: fakeSession().user });
    if (url.pathname.startsWith('/auth/v1/')) return route.fulfill({ json: {} });
    if (url.pathname.startsWith('/storage/v1/')) return route.fulfill({ json: [] });
    if (!url.pathname.startsWith('/rest/v1/')) return route.fulfill({ status: 404, json: {} });
    const table = url.pathname.slice('/rest/v1/'.length);
    if (table.startsWith('rpc/')) return route.fulfill({ json: null });
    const method = req.method();
    if (method === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' });
    if (method !== 'GET') return route.fulfill({ status: 201, json: [] });
    const rows = FIXTURES[table] ?? [];
    if ((req.headers().accept ?? '').includes('vnd.pgrst.object+json')) {
      // .single(): one object, or PostgREST's "0 rows" error.
      return rows.length
        ? route.fulfill({ json: rows[0] })
        : route.fulfill({ status: 406, json: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows', hint: null } });
    }
    return route.fulfill({ json: rows, headers: { 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' } });
  });
}

async function openContext({ signedIn }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'ko-KR' });
  await mockBackend(context);
  if (signedIn) {
    await context.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [SESSION_KEY, JSON.stringify(fakeSession())]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()} :: ${e.message}`));
  return { context, page, errors };
}

/** Let lazy chunks load and effects settle, then check the screen did not fall into an error boundary. */
async function settle(page, label, errors) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const crashed = await page.getByText(ERROR_BOUNDARY_TEXT).count();
  assert.equal(crashed, 0, `${label}: error boundary shown`);
  assert.deepEqual(errors, [], `${label}: uncaught errors`);
}

test('login page renders without errors', { timeout: 60_000 }, async () => {
  const { context, page, errors } = await openContext({ signedIn: false });
  await page.goto(`${base}/login`);
  await page.getByRole('button', { name: /로그인/ }).first().waitFor({ timeout: 15_000 });
  await settle(page, 'login', errors);
  assert.match(await page.title(), /로그인 — MIR SMART/);
  // Protected pages send signed-out users to the login screen.
  await page.goto(`${base}/project/${PROJECT.id}/issues`);
  await page.waitForURL(/\/login$/, { timeout: 15_000 });
  await context.close();
});

test('signed-in admin can open every project menu', { timeout: 240_000 }, async () => {
  const { context, page, errors } = await openContext({ signedIn: true });
  await page.goto(`${base}/`);
  await page.getByText(PROJECT.name).first().click({ timeout: 15_000 });
  await page.waitForURL(new RegExp(`/project/${PROJECT.id}$`));
  await settle(page, 'dashboard', errors);

  const nav = page.locator('nav[aria-label="메인 네비게이션"] a');
  const labels = await nav.evaluateAll((links) => links.map((a) => a.getAttribute('aria-label')));
  assert.ok(labels.length >= 10, `expected the module menu, got ${labels.length} items`);
  const visited = [];
  for (const label of labels) {
    // Client-side navigation, as users move between menus (exercises lazy route chunks).
    await page.locator(`nav[aria-label="메인 네비게이션"] a[aria-label="${label}"]`).click();
    await settle(page, label, errors);
    const title = await page.title();
    assert.ok(title.startsWith(`${label} · ${PROJECT.name}`), `${label}: tab title was "${title}"`);
    visited.push(label);
  }
  console.log(`  visited ${visited.length} menus: ${visited.join(', ')}`);

  for (const [route, label] of [['/admin', 'admin console'], ['/styleguide', 'style guide'], ['/view/00000000-0000-4000-8000-00000000ffff', 'missing file preview']]) {
    await page.goto(`${base}${route}`);
    await settle(page, label, errors);
  }
  await context.close();
});

test('revisiting a menu shows cached data without a new request', { timeout: 120_000 }, async () => {
  const { context, page, errors } = await openContext({ signedIn: true });
  const requests = {};
  page.on('request', (r) => {
    const m = new URL(r.url()).pathname.match(/^\/rest\/v1\/([a-z_]+)/);
    if (m && r.method() === 'GET') requests[m[1]] = (requests[m[1]] ?? 0) + 1;
  });
  const go = async (label) => {
    await page.locator(`nav[aria-label="메인 네비게이션"] a[aria-label="${label}"]`).click();
    await settle(page, label, errors);
  };
  await page.goto(`${base}/project/${PROJECT.id}`);
  await settle(page, 'dashboard', errors);
  const logsAfterDashboard = requests.daily_logs ?? 0;
  assert.ok(logsAfterDashboard >= 1, 'dashboard did not load daily logs');
  await go('공사일보'); // same first page of logs as the dashboard: served from the cache
  assert.equal(requests.daily_logs ?? 0, logsAfterDashboard, '공사일보 refetched logs the dashboard just loaded');
  await go('게시판');
  await page.getByText(POST_TITLE).waitFor();
  const postsFirst = requests.posts ?? 0;
  await go('사업개요');
  await go('게시판');
  assert.ok(await page.getByText(POST_TITLE).isVisible(), 'board revisit did not show the cached post');
  assert.equal(requests.posts ?? 0, postsFirst, 'board revisit within the fresh window refetched posts');
  await context.close();
});

test('자료 관리 reopens the last folder from cache', { timeout: 120_000 }, async () => {
  const { context, page, errors } = await openContext({ signedIn: true });
  let accCalls = 0;
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/aps-acc') accCalls++; });
  const go = async (label) => {
    await page.locator(`nav[aria-label="메인 네비게이션"] a[aria-label="${label}"]`).click();
    await settle(page, label, errors);
  };
  await page.goto(`${base}/project/${PROJECT.id}`);
  await settle(page, 'dashboard', errors);
  await go('자료 관리');
  await page.locator('.acc-trow.folder', { hasText: '01.도면' }).click();
  await page.getByText('평면도.pdf').waitFor();
  const callsAfterFirstVisit = accCalls; // root + 01.도면
  await go('게시판');
  await go('자료 관리');
  await page.getByText('평면도.pdf').waitFor({ timeout: 2_000 }); // back in 01.도면, not the start folder
  assert.equal(accCalls, callsAfterFirstVisit, 'revisit refetched folder listings that were just loaded');
  await context.close();
});

test(`first-load JavaScript stays under ${FIRST_LOAD_BUDGET_KB} KB gzip`, () => {
  const html = readFileSync(path.join(OUT, 'index.html'), 'utf8');
  const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(files.length > 0, 'no scripts found in index.html');
  const kb = files.reduce((sum, f) => sum + gzipSync(readFileSync(path.join(OUT, f))).length, 0) / 1024;
  console.log(`  first load: ${files.length} files, ${kb.toFixed(0)} KB gzip`);
  assert.ok(kb <= FIRST_LOAD_BUDGET_KB, `first load ${kb.toFixed(0)} KB gzip exceeds ${FIRST_LOAD_BUDGET_KB} KB`);
});
