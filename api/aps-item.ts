// =====================================================================
// MIR_VDC — ACC Data Management 항목 작업 (2-legged). S48.
//
// 자료관리 ACC 파일의 이름변경/삭제/이동을 우리 서버(2-legged)가 대신 수행한다.
// 쓰기이므로 호출자는 로그인 + 실무자(editor) 이상이어야 한다(RBAC, 0023).
//
//   POST /api/aps-item  { action:'rename', project, item, name,    mirProject }
//   POST /api/aps-item  { action:'delete', project, item,          mirProject }
//   POST /api/aps-item  { action:'move',   project, item, folder,  mirProject }
//
// rename : PATCH item.displayName (ACC 표준).
// delete : tip 위에 'Deleted' 확장 버전을 올려 휴지통 처리(ACC 표준 — 하드딜리트 X).
// move   : PATCH item.relationships.parent (ACC 지원 여부는 환경에 따라 — 실패 시
//          에러 그대로 노출, 추후 commands API 폴백 검토).
//
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET + SUPABASE_URL / SERVICE_ROLE.
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

const VND = { 'content-type': 'application/vnd.api+json', accept: 'application/vnd.api+json' };
const DELETED_EXT = { type: 'versions:autodesk.core:Deleted', version: '1.0' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function mintToken(): Promise<string> {
  const basic = btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`);
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read data:write data:create' }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

function detail(d: any, status: number): string {
  return d?.errors?.[0]?.detail ?? d?.reason ?? d?.developerMessage ?? `APS ${status}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return json({ error: 'APS 환경변수 미설정' }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid body' }, 400);
  }
  const { action, project, item, name, folder, mirProject } = body ?? {};
  if (!project || !item) return json({ error: 'project/item 필요' }, 400);

  // 로그인 + 실무자(editor) 이상(RBAC, 0023).
  if (SUPABASE_URL && SERVICE_ROLE) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'missing bearer token' }, 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return json({ error: 'invalid session' }, 401);
    const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).single();
    let allowed = !!prof?.is_admin;
    if (!allowed && mirProject) {
      const { data: mem } = await supa
        .from('project_members')
        .select('role')
        .eq('project_id', mirProject)
        .eq('user_id', data.user.id)
        .maybeSingle();
      allowed = mem?.role === 'editor' || mem?.role === 'admin';
    }
    if (!allowed) return json({ error: '권한이 없습니다(실무자 이상).' }, 403);
  }

  try {
    const token = await mintToken();
    const bearer = { authorization: `Bearer ${token}` };
    const itemUrl = `${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}`;

    if (action === 'rename') {
      if (!name?.trim()) return json({ error: 'name 필요' }, 400);
      const res = await fetch(itemUrl, {
        method: 'PATCH',
        headers: { ...bearer, ...VND },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: { type: 'items', id: item, attributes: { displayName: name.trim() } },
        }),
      });
      const d = await res.json();
      if (!res.ok) return json({ error: detail(d, res.status) }, res.status);
      return json({ ok: true, name: name.trim() });
    }

    if (action === 'delete') {
      // tip 의 item id 위에 'Deleted' 확장 버전을 만들어 휴지통 처리.
      const res = await fetch(`${APS}/data/v1/projects/${encodeURIComponent(project)}/versions`, {
        method: 'POST',
        headers: { ...bearer, ...VND },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: {
            type: 'versions',
            attributes: { extension: DELETED_EXT },
            relationships: { item: { data: { type: 'items', id: item } } },
          },
        }),
      });
      const d = await res.json();
      if (!res.ok) return json({ error: detail(d, res.status) }, res.status);
      return json({ ok: true });
    }

    if (action === 'move') {
      if (!folder) return json({ error: 'folder 필요' }, 400);
      const res = await fetch(itemUrl, {
        method: 'PATCH',
        headers: { ...bearer, ...VND },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: {
            type: 'items',
            id: item,
            relationships: { parent: { data: { type: 'folders', id: folder } } },
          },
        }),
      });
      const d = await res.json();
      if (!res.ok) return json({ error: detail(d, res.status) }, res.status);
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
