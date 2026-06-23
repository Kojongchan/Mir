// =====================================================================
// MIR_VDC — APS (Autodesk Platform Services) 2-legged viewer token.
//
// Mints a short-lived `viewables:read` token so the embedded APS Viewer can
// stream models that live in our ACC hub / OSS — WITHOUT the end user needing
// an Autodesk account (our app brokers access). The APS_CLIENT_SECRET must
// NEVER reach the browser, so this runs server-side (edge).
//
// Required env (Vercel project settings — NOT VITE_ prefixed):
//   APS_CLIENT_ID
//   APS_CLIENT_SECRET
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (to verify the caller is a
//                                              logged-in MIR SMART user)
//
// Outside tsconfig's `src` include; Vercel compiles on deploy.
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 뷰어 + ACC 데이터(파일 트리) 조회용 읽기 권한.
const SCOPE = 'data:read viewables:read';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    return json({ error: 'APS 환경변수 미설정 (APS_CLIENT_ID / APS_CLIENT_SECRET)' }, 500);
  }

  // 로그인한 MIR SMART 사용자만 토큰을 받을 수 있게 게이트(앱이 접근을 브로커).
  if (SUPABASE_URL && SERVICE_ROLE) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'missing bearer token' }, 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  }

  // 2-legged client_credentials → viewables:read 액세스 토큰.
  const basic = btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`);
  const res = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) {
    return json({ error: data.error_description ?? 'APS 토큰 발급 실패' }, 502);
  }
  return json({ access_token: data.access_token, expires_in: data.expires_in ?? 3600 });
}
