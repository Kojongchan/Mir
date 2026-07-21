// =====================================================================
// MIR_VDC — ACC(APS) 모델 → XKT 변환 워커
//
// 왜 별도 서비스인가: 변환(SVF→glTF→XKT)은 무겁고 수 분 걸릴 수 있어
// Vercel 서버리스(≤60초)로는 큰 모델을 못 끝낸다. 이 워커는 시간 제한 없는
// 컨테이너(Railway 등)에서 돌며, 결과 XKT 를 Supabase 공용 캐시에 올린다.
// 변환은 모델당 1회 — 이후 모든 사용자는 v1 이 캐시에서 즉시 로드한다.
//
// 흐름:
//   v1(/api/aps-convert) --POST /convert {urn}--> 워커
//   워커: 즉시 {status:'processing'} 반환 + 백그라운드 변환 시작
//   워커: SVF→glTF(svf-utils)→XKT(convert2xkt) → Supabase 'models' 버킷
//         aps-xkt/{sha1(urn)}/model.xkt 업로드
//   v1: GET /api/aps-convert?urn 폴링 → 캐시에 뜨면 xeokit 로드
//
// 필요한 환경변수(Railway 등에서 설정):
//   APS_CLIENT_ID, APS_CLIENT_SECRET      — v1 APS 앱 것 재사용
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   WORKER_SECRET                          — v1 과 공유하는 비밀(요청 인증)
//   PORT (호스트가 주입; 기본 8080)
// =====================================================================
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
// svf-utils / xeokit-convert 는 CJS — 기본 import 후 구조분해(ESM interop 안전).
import svfUtils from 'svf-utils';
import xeokitConvert from '@xeokit/xeokit-convert';

const { SVFReader, GLTFWriter, TwoLeggedAuthenticationProvider } = svfUtils;
const { convert2xkt } = xeokitConvert;

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const PORT = Number(process.env.PORT || 8080);
const APS = 'https://developer.api.autodesk.com';

const BUCKET = 'models';
const PREFIX = 'aps-xkt';

/** 동시에 같은 URN 을 중복 변환하지 않도록 진행중 표시(메모리). */
const inProgress = new Set();

function supa() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

function cacheDir(urn) {
  return `${PREFIX}/${createHash('sha1').update(urn).digest('hex')}`;
}

async function cacheExists(urn) {
  const dir = cacheDir(urn);
  const { data } = await supa().storage.from(BUCKET).list(dir, { search: 'model.xkt' });
  return Boolean(data?.some((f) => f.name === 'model.xkt'));
}

async function mintToken() {
  const basic = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

/** 매니페스트에서 SVF 뷰어블(graphics/autodesk-svf)의 GUID. */
async function findSvfGuid(urn, token) {
  const res = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const manifest = await res.json();
  let found = null;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (n.role === 'graphics' && n.mime === 'application/autodesk-svf' && n.guid) {
      found = n.guid;
      return;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  (manifest.derivatives ?? []).forEach(walk);
  return found;
}

/** 실제 변환(백그라운드). 성공 시 캐시에 model.xkt 업로드. */
async function convert(urn) {
  let workDir = null;
  const t0 = Date.now();
  try {
    console.log(`[convert] start ${urn}`);
    const token = await mintToken();
    const guid = await findSvfGuid(urn, token);
    if (!guid) throw new Error('SVF 뷰어블 없음(변환 전이거나 3D 파생 없음)');

    // 1) SVF → glTF (svf-utils). deduplicate:false 로 속도 우선(뒤 XKT 단계가 압축).
    const authProvider = new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);
    const reader = await SVFReader.FromDerivativeService(urn, guid, authProvider);
    const scene = await reader.read();

    workDir = await mkdtemp(join(tmpdir(), 'aps-'));
    const gltfDir = join(workDir, 'gltf');
    const writer = new GLTFWriter({
      deduplicate: false, // 속도 우선
      skipUnusedUvs: true,
      center: false, // 실좌표 유지(지형/타 모델 정합)
      log: () => {},
    });
    await writer.write(scene, gltfDir);

    const files = await readdir(gltfDir);
    const gltfName = files.find((f) => f.toLowerCase().endsWith('.gltf'));
    if (!gltfName) throw new Error('glTF 산출 실패');

    // 2) glTF → XKT (단일 파일)
    let xkt = null;
    await convert2xkt({
      source: join(gltfDir, gltfName),
      outputXKT: (buf) => {
        xkt = buf;
      },
      log: () => {},
    });
    if (!xkt) throw new Error('XKT 변환 실패');

    // 3) Supabase 공용 캐시에 업로드
    const { error } = await supa()
      .storage.from(BUCKET)
      .upload(`${cacheDir(urn)}/model.xkt`, Buffer.from(xkt), {
        contentType: 'application/octet-stream',
        upsert: true,
      });
    if (error) throw new Error(`업로드 실패: ${error.message}`);

    console.log(`[convert] done ${urn} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    console.error(`[convert] FAIL ${urn}: ${e?.message ?? e}`);
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    inProgress.delete(urn);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/convert') {
    if ((req.headers['x-worker-secret'] || '') !== WORKER_SECRET) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy(); // 1MB 방어
    });
    req.on('end', async () => {
      let urn = '';
      try {
        urn = (JSON.parse(raw || '{}').urn || '').trim();
      } catch {
        return sendJson(res, 400, { error: 'JSON 본문 필요' });
      }
      if (!urn) return sendJson(res, 400, { error: 'urn 필요' });
      try {
        if (await cacheExists(urn)) return sendJson(res, 200, { ready: true });
      } catch {
        /* 캐시 조회 실패는 무시하고 변환 시도 */
      }
      if (!inProgress.has(urn)) {
        inProgress.add(urn);
        void convert(urn); // 백그라운드 — 응답은 즉시
      }
      return sendJson(res, 200, { status: 'processing' });
    });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[mir-aps-worker] listening on :${PORT}`);
});
