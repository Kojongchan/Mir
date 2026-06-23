// =====================================================================
// MIR_VDC — APS Data Management 프록시 (2-legged).
//
// ACC 허브→프로젝트→폴더→모델을 서버 측 2-legged 토큰으로 조회해 브라우저에
// 돌려준다(토큰은 노출 안 함). 3번(ACC 사용자 지정 통합)으로 우리 앱 Client ID가
// 허브 데이터 접근 권한을 받았기 때문에 2-legged 로 읽을 수 있다.
//
// 사용:
//   GET /api/aps-acc?action=hubs
//   GET /api/aps-acc?action=projects&hub=<hubId>
//   GET /api/aps-acc?action=topFolders&hub=<hubId>&project=<projectId>
//   GET /api/aps-acc?action=contents&project=<projectId>&folder=<folderId>
//
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET (+ Supabase 검증용).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// version urn(urn:adsk...) → 뷰어용 base64url URN.
function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 자연 정렬: "1, 2, 3, … 10, 11" (사전식 "1,10,2" 방지).
function byName(a: { name?: string }, b: { name?: string }): number {
  return (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true, sensitivity: 'base' });
}

async function mintToken(): Promise<string> {
  const basic = btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`);
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

async function dm(path: string, token: string): Promise<any> {
  const res = await fetch(`${APS}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.errors?.[0]?.detail ?? d?.developerMessage ?? `DM ${res.status}`);
  return d;
}

export default async function handler(req: Request): Promise<Response> {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return json({ error: 'APS 환경변수 미설정' }, 500);

  // 로그인한 MIR 사용자만.
  if (SUPABASE_URL && SERVICE_ROLE) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'missing bearer token' }, 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const hub = url.searchParams.get('hub') ?? '';
  const project = url.searchParams.get('project') ?? '';
  const folder = url.searchParams.get('folder') ?? '';

  try {
    const token = await mintToken();

    if (action === 'hubs') {
      const d = await dm('/project/v1/hubs', token);
      return json({ hubs: (d.data ?? []).map((h: any) => ({ id: h.id, name: h.attributes?.name })) });
    }
    if (action === 'projects') {
      const d = await dm(`/project/v1/hubs/${encodeURIComponent(hub)}/projects`, token);
      return json({ projects: (d.data ?? []).map((p: any) => ({ id: p.id, name: p.attributes?.name })) });
    }
    if (action === 'topFolders') {
      const d = await dm(
        `/project/v1/hubs/${encodeURIComponent(hub)}/projects/${encodeURIComponent(project)}/topFolders`,
        token,
      );
      const folders = (d.data ?? [])
        .map((f: any) => ({ id: f.id, name: f.attributes?.displayName ?? f.attributes?.name }))
        .sort(byName);
      return json({ folders });
    }
    if (action === 'contents') {
      const d = await dm(
        `/data/v1/projects/${encodeURIComponent(project)}/folders/${encodeURIComponent(folder)}/contents`,
        token,
      );
      const folders = (d.data ?? [])
        .filter((x: any) => x.type === 'folders')
        .map((x: any) => ({ id: x.id, name: x.attributes?.displayName ?? x.attributes?.name }))
        .sort(byName);
      const items = (d.data ?? [])
        .filter((x: any) => x.type === 'items')
        .map((x: any) => {
          const tip = x.relationships?.tip?.data?.id as string | undefined;
          return {
            id: x.id,
            name: x.attributes?.displayName ?? x.attributes?.name,
            urn: tip ? toBase64Url(tip) : null,
          };
        })
        .sort(byName);
      return json({ folders, items });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
