// =====================================================================
// MIR_VDC — ACC(APS) 모델 → XKT 변환 (신규 3D뷰: xeokit 스트리밍용).
//
// 확정 설계: ACC 파일(rvt·nwd·dwg·ifc)은 브라우저가 직접 못 읽는다. 항상
//   ACC(URN, 이미 SVF2 파생 보유) → [서버] SVF→glTF(svf-utils) → XKT(convert2xkt)
//   → Supabase(models 버킷 파생 경로) 캐시 → xeokit 가 서명 URL 로 로드.
// 파일은 잘 안 바뀌므로 첫 변환만 무겁고, 이후엔 캐시에서 즉시 로드한다.
//
//   GET  /api/aps-convert?urn=<base64 URN>   → 캐시 상태 조회
//        200 {ready:true, url}  |  {ready:false}
//   POST /api/aps-convert  body {urn, size?} → 변환 실행(캐시에 저장 후 URL 반환)
//        200 {ready:true, url}  |  413 {tooLarge:true, ...}
//
// ⚠️ Node 런타임 필수(svf-utils 가 fs/스트림 사용) — edge 아님. 그래서 Vercel
//    표준 Node 시그니처 (req,res) 를 쓴다(Web Request/Response 아님 — 그건 edge용).
// ⚠️ 무거운 변환기(svf-utils·convert2xkt)는 POST 안에서 **지연 import** — 모듈
//    로드/GET 경로가 이들 초기화로 죽지 않게(500 방지).
// ⚠️ 대용량(≈527MB급)은 serverless 한도 초과 → 413 로 거절, 오프라인/배치 변환 유도.
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET / SUPABASE_URL(or VITE_) /
//               SUPABASE_SERVICE_ROLE_KEY.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

// 파생 캐시 위치(기존 'models' 버킷 재사용 — 새 버킷 생성 불필요).
const BUCKET = 'models';
const PREFIX = 'aps-xkt';
// serverless 안전 상한(원본 파일 크기 기준). 넘으면 오프라인 변환으로 유도.
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

// Vercel Node 함수 시그니처(느슨한 타입 — @vercel/node 의존 없이).
interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (k: string, v: string) => void;
}

function supa() {
  return createClient(SUPABASE_URL as string, SERVICE_ROLE as string, {
    auth: { persistSession: false },
  });
}

function cachePath(urn: string): string {
  const key = createHash('sha1').update(urn).digest('hex');
  return `${PREFIX}/${key}/model.xkt`;
}

async function cachedUrl(urn: string): Promise<string | null> {
  const { data } = await supa().storage.from(BUCKET).createSignedUrl(cachePath(urn), 3600);
  return data?.signedUrl ?? null;
}

async function mintToken(): Promise<string> {
  const basic = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

/** 매니페스트에서 SVF 뷰어블(graphics/autodesk-svf)의 GUID 를 찾는다. */
async function findSvfGuid(urn: string, token: string): Promise<string | null> {
  const res = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const manifest = (await res.json()) as { derivatives?: unknown[] };
  let found: string | null = null;
  const walk = (node: unknown) => {
    if (found || !node || typeof node !== 'object') return;
    const n = node as { role?: string; mime?: string; guid?: string; children?: unknown[] };
    if (n.role === 'graphics' && n.mime === 'application/autodesk-svf' && n.guid) {
      found = n.guid;
      return;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  (manifest.derivatives ?? []).forEach(walk);
  return found;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.setHeader('cache-control', 'no-store');
    res.status(status).json(body);
  };

  try {
    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return send(500, { error: 'APS 환경변수 미설정' });
    if (!SUPABASE_URL || !SERVICE_ROLE) return send(500, { error: 'Supabase 환경변수 미설정' });

    // 로그인한 MIR 사용자만.
    const authHeader = req.headers['authorization'];
    const bearer = (Array.isArray(authHeader) ? authHeader[0] : authHeader || '').replace(
      /^Bearer\s+/i,
      '',
    );
    if (!bearer) return send(401, { error: 'missing token' });
    const { data: userData, error: userErr } = await supa().auth.getUser(bearer);
    if (userErr || !userData?.user) return send(401, { error: 'invalid session' });

    // ── GET: 캐시 상태만 조회(변환 안 함, 무거운 import 없음) ──────────
    if (req.method === 'GET') {
      const q = req.query['urn'];
      const urn = (Array.isArray(q) ? q[0] : q) ?? '';
      if (!urn) return send(400, { error: 'urn 필요' });
      const cached = await cachedUrl(urn);
      return send(200, cached ? { ready: true, url: cached } : { ready: false });
    }

    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

    // ── POST: 변환 실행 ─────────────────────────────────────────────
    const body = (req.body ?? {}) as { urn?: string; size?: number };
    const urn = body.urn ?? '';
    if (!urn) return send(400, { error: 'urn 필요' });

    // 이미 캐시돼 있으면 바로 반환.
    const already = await cachedUrl(urn);
    if (already) return send(200, { ready: true, url: already });

    // serverless 안전 상한 — 초대형은 오프라인 변환으로 유도.
    if (typeof body.size === 'number' && body.size > MAX_SOURCE_BYTES) {
      return send(413, {
        tooLarge: true,
        limitMB: Math.round(MAX_SOURCE_BYTES / (1024 * 1024)),
        sizeMB: Math.round(body.size / (1024 * 1024)),
        message: '이 모델은 서버리스 변환 한도를 초과합니다. 오프라인/배치 변환이 필요합니다.',
      });
    }

    // 무거운 변환기는 여기서만 지연 로드(모듈 초기화 실패로 500 나는 것 방지).
    const { mkdtemp, readdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SVFReader, GLTFWriter, TwoLeggedAuthenticationProvider } = await import('svf-utils');
    const { convert2xkt } = await import('@xeokit/xeokit-convert');

    const token = await mintToken();
    const guid = await findSvfGuid(urn, token);
    if (!guid) return send(422, { error: 'SVF 뷰어블을 찾을 수 없습니다(변환 전이거나 3D 파생 없음).' });

    let workDir: string | null = null;
    try {
      // 1) SVF → 중간표현 → glTF (svf-utils, /tmp)
      const authProvider = new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);
      const reader = await SVFReader.FromDerivativeService(urn, guid, authProvider);
      const scene = await reader.read();

      workDir = await mkdtemp(join(tmpdir(), 'aps-'));
      const gltfDir = join(workDir, 'gltf');
      const writer = new GLTFWriter({
        deduplicate: true,
        skipUnusedUvs: true,
        center: false, // 실좌표 유지(지형/타 모델과 정합)
        log: () => {},
      });
      await writer.write(scene, gltfDir);

      const files = await readdir(gltfDir);
      const gltfName = files.find((f) => f.toLowerCase().endsWith('.gltf'));
      if (!gltfName) return send(500, { error: 'glTF 산출 실패' });

      // 2) glTF → XKT (단일 파일)
      let xkt: ArrayBuffer | null = null;
      await convert2xkt({
        source: join(gltfDir, gltfName),
        outputXKT: (buf: ArrayBuffer) => {
          xkt = buf;
        },
        log: () => {},
      });
      if (!xkt) return send(500, { error: 'XKT 변환 실패' });

      // 3) Supabase 파생 캐시에 업로드 → 서명 URL 반환
      const { error: upErr } = await supa()
        .storage.from(BUCKET)
        .upload(cachePath(urn), Buffer.from(xkt as ArrayBuffer), {
          contentType: 'application/octet-stream',
          upsert: true,
        });
      if (upErr) return send(500, { error: `업로드 실패: ${upErr.message}` });

      const signed = await cachedUrl(urn);
      if (!signed) return send(500, { error: '서명 URL 발급 실패' });
      return send(200, { ready: true, url: signed });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    return send(500, { error: `변환 실패: ${(e as Error)?.message ?? String(e)}` });
  }
}
