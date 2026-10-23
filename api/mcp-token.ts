// =====================================================================
// MIR — AI 연결(MCP) 개인 연결 주소 발급. POST /api/mcp-token { mirProject } (로그인 사용자, 프로젝트 멤버)
//   → { url, expiresAt, role }  — url 을 자기 Claude(사용자 지정 커넥터)·ChatGPT(개발자 모드)에 등록한다.
// 주소 자체가 열쇠다(남에게 주지 않는다). 30일 뒤 만료, 멤버에서 빠지면 바로 막힘(서버가 요청마다 확인).
// Required env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (+ 선택 MCP_TOKEN_SECRET).
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { MCP_TOKEN_DAYS, mcpSecret, signMcpToken } from './_mcp-token';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const secret = mcpSecret();
  if (!SUPABASE_URL || !SERVICE_ROLE || !secret) return json({ error: 'AI 연결이 설정되지 않았습니다(서버 환경변수).' }, 503);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid body' }, 400); }
  const project = String(body?.mirProject ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(project)) return json({ error: 'mirProject 필요' }, 400);
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'missing bearer token' }, 401);
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data, error } = await supa.auth.getUser(bearer);
  if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  const { data: mem } = await supa.from('project_members').select('role').eq('project_id', project).eq('user_id', data.user.id).maybeSingle();
  if (!prof?.is_admin && !mem) return json({ error: '이 프로젝트의 멤버가 아닙니다.' }, 403);
  const exp = Date.now() + MCP_TOKEN_DAYS * 86_400_000;
  const token = await signMcpToken({ u: data.user.id, p: project, exp }, secret);
  const origin = new URL(req.url).origin;
  return json({ url: `${origin}/api/mcp/${token}`, expiresAt: new Date(exp).toISOString(), role: prof?.is_admin ? 'admin' : mem?.role ?? 'viewer' });
}
