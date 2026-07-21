// =====================================================================
// MIR_VDC — ACC(APS) 모델 → XKT 변환 게이트웨이 (신규 3D뷰: xeokit).
//
// 구조(모두에게 자동·큰 파일 커버):
//   ① 브라우저 'ACC에서 열기' → 이 함수(GET)로 **공용 캐시** 조회
//   ② 없으면 이 함수(POST)가 **변환 워커**(장시간 실행 컨테이너)에 작업 위임
//   ③ 워커가 SVF→glTF→XKT 변환 후 같은 캐시(Supabase)에 업로드
//   ④ 브라우저는 GET 을 폴링 → 캐시에 XKT 뜨면 xeokit 로드
// 변환은 **모델당 1회**(캐시 공유) — 이후 모든 사용자는 즉시 로드.
//
// 이 함수는 무거운 변환기를 안 쓰므로 **edge 런타임**으로 가볍고 안정적이다.
//   GET  /api/aps-convert?urn=<base64 URN>  → {ready:true,url} | {ready:false}
//   POST /api/aps-convert  {urn}            → {ready:true,url} | {status:'processing'}
//
// Required env: SUPABASE_URL(or VITE_) / SUPABASE_SERVICE_ROLE_KEY /
//               WORKER_URL(변환 워커 공개 URL) / WORKER_SECRET(공유 비밀).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_URL = process.env.WORKER_URL; // 예: https://mir-aps-worker.up.railway.app
const WORKER_SECRET = process.env.WORKER_SECRET;

const BUCKET = 'models';
const PREFIX = 'aps-xkt';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** URN → 캐시 오브젝트 경로(SHA-1, Web Crypto). */
async function cacheKey(urn: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(urn));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${PREFIX}/${hex}`;
}

function supa() {
  return createClient(SUPABASE_URL as string, SERVICE_ROLE as string, {
    auth: { persistSession: false },
  });
}

/** 캐시에 model.xkt 가 실제로 존재하면 서명 URL, 없으면 null. */
async function cachedUrl(urn: string): Promise<string | null> {
  const dir = await cacheKey(urn);
  const client = supa();
  const { data: list } = await client.storage.from(BUCKET).list(dir, { search: 'model.xkt' });
  if (!list?.some((f) => f.name === 'model.xkt')) return null;
  const { data } = await client.storage.from(BUCKET).createSignedUrl(`${dir}/model.xkt`, 3600);
  return data?.signedUrl ?? null;
}

export default async function handler(req: Request): Promise<Response> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ error: 'Supabase 환경변수 미설정' }, 500);

  // 로그인한 MIR 사용자만.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'missing token' }, 401);
  const { data: userData, error: userErr } = await supa().auth.getUser(bearer);
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);

  const url = new URL(req.url);

  // ── GET: 캐시 조회 ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const urn = url.searchParams.get('urn') ?? '';
    if (!urn) return json({ error: 'urn 필요' }, 400);
    const cached = await cachedUrl(urn);
    return json(cached ? { ready: true, url: cached } : { ready: false });
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── POST: 캐시 확인 후 워커에 변환 위임 ───────────────────────────
  let body: { urn?: string };
  try {
    body = (await req.json()) as { urn?: string };
  } catch {
    return json({ error: 'JSON 본문 필요' }, 400);
  }
  const urn = body.urn ?? '';
  if (!urn) return json({ error: 'urn 필요' }, 400);

  const already = await cachedUrl(urn);
  if (already) return json({ ready: true, url: already });

  if (!WORKER_URL || !WORKER_SECRET) {
    return json({ error: '변환 워커가 설정되지 않았습니다(WORKER_URL/SECRET).' }, 503);
  }

  // 워커에 작업 등록(즉시 반환 — 실제 변환은 백그라운드). 브라우저가 GET 폴링.
  try {
    const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ urn }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ready?: boolean;
      url?: string;
      status?: string;
      error?: string;
    };
    if (!res.ok) return json({ error: data.error ?? `워커 오류(${res.status})` }, 502);
    // 워커가 이미 캐시됨을 알려주면 그대로, 아니면 처리중.
    if (data.ready && data.url) return json({ ready: true, url: data.url });
    return json({ status: 'processing' });
  } catch (e) {
    return json({ error: `워커 연결 실패: ${(e as Error).message}` }, 502);
  }
}
