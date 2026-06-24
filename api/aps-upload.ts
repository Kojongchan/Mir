// =====================================================================
// MIR_VDC — ACC Data Management 업로드 브로커 (2-legged). S47.
//
// 자료관리에서 올린 파일을 우리 서버(2-legged client_credentials)가 ACC 폴더에
// 써준다. 외부 사용자는 오토데스크 계정이 필요 없다(앱이 쓰기를 브로커).
//
// 0단계 스파이크 결론:
//   APS Data Management 업로드는 (1) storage object 생성 → (2) S3 signed upload
//   (브라우저가 S3 로 직접 PUT) → (3) item(신규)/version(기존) 생성 의 3단계다.
//   2-legged(client_credentials) 로 이 흐름을 수행하려면 **커스텀 통합 앱(Client ID)
//   이 대상 ACC 폴더에 '편집/업로드' 권한을 부여받아야 한다**(S46 은 읽기만 승인).
//   읽기는 검증됨(S46). 쓰기는 운영에서 폴더 권한 부여 후 검증 필요 — item/version
//   생성이 403 이면 폴더 권한 미부여이거나 3-legged 필요(그때 S47 범위 재조정).
//   필요 스코프: data:create data:write (+ data:read).
//
// 2단계로 나눠 호출(대용량 모델 대비 — 바이트는 우리 서버를 거치지 않고 S3 직행):
//   POST /api/aps-upload  { action:'begin',    project, folder, fileName }
//        → { uploadKey, signedUrl, bucket, object, storageUrn }
//   (브라우저가 signedUrl 로 파일 바이트를 직접 PUT, XHR onprogress 로 진행률)
//   POST /api/aps-upload  { action:'complete', project, folder, fileName,
//                           bucket, object, uploadKey, storageUrn, itemId? }
//        → { itemUrn, versionUrn, urn(base64) }
//
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET + SUPABASE_URL /
//               SUPABASE_SERVICE_ROLE_KEY (호출자 검증 — 로그인 + 관리자, D11).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

// JSON:API 헤더(Data Management v1 은 vnd.api+json 을 요구).
const VND = { 'content-type': 'application/vnd.api+json', accept: 'application/vnd.api+json' };
// ACC/BIM360 파일 확장 타입(ACC 도 bim360 확장 식별자를 그대로 쓴다).
const ITEM_EXT = { type: 'items:autodesk.bim360:File', version: '1.0' };
const VERSION_EXT = { type: 'versions:autodesk.bim360:File', version: '1.0' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintToken(): Promise<string> {
  const basic = btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`);
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'data:read data:create data:write',
    }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

// 에러 본문에서 사람이 읽을 메시지 추출(JSON:API errors / OSS reason).
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

  const { action, project, folder, fileName, mirProject } = body ?? {};
  if (!project || !fileName) return json({ error: 'project/fileName 필요' }, 400);

  // 로그인 + 실무자(editor) 이상만 쓰기(RBAC, 0023). mirProject = MIR 프로젝트 id.
  if (SUPABASE_URL && SERVICE_ROLE) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'missing bearer token' }, 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return json({ error: 'invalid session' }, 401);
    const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).single();
    let allowed = !!prof?.is_admin; // 시스템 관리자
    if (!allowed && mirProject) {
      const { data: mem } = await supa
        .from('project_members')
        .select('role')
        .eq('project_id', mirProject)
        .eq('user_id', data.user.id)
        .maybeSingle();
      allowed = mem?.role === 'editor' || mem?.role === 'admin';
    }
    if (!allowed) return json({ error: '업로드 권한이 없습니다(실무자 이상).' }, 403);
  }

  try {
    const token = await mintToken();
    const bearer = { authorization: `Bearer ${token}` };

    // ---- 1) begin: storage 생성 + S3 서명 업로드 URL 발급 -------------------
    if (action === 'begin') {
      if (!folder) return json({ error: 'folder 필요' }, 400);
      const stRes = await fetch(
        `${APS}/data/v1/projects/${encodeURIComponent(project)}/storage`,
        {
          method: 'POST',
          headers: { ...bearer, ...VND },
          body: JSON.stringify({
            jsonapi: { version: '1.0' },
            data: {
              type: 'objects',
              attributes: { name: fileName },
              relationships: { target: { data: { type: 'folders', id: folder } } },
            },
          }),
        },
      );
      const st = await stRes.json();
      if (!stRes.ok) return json({ error: detail(st, stRes.status) }, stRes.status);
      const storageUrn: string = st?.data?.id;
      const m = storageUrn?.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
      if (!m) return json({ error: '스토리지 urn 형식 오류' }, 502);
      const bucket = m[1];
      const object = m[2];

      const upRes = await fetch(
        `${APS}/oss/v2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(
          object,
        )}/signeds3upload?minutesExpiration=60`,
        { headers: bearer },
      );
      const up = await upRes.json();
      if (!upRes.ok) return json({ error: detail(up, upRes.status) }, upRes.status);
      const signedUrl: string | undefined = up?.urls?.[0];
      if (!signedUrl || !up?.uploadKey) return json({ error: '서명 업로드 URL 없음' }, 502);
      return json({ uploadKey: up.uploadKey, signedUrl, bucket, object, storageUrn });
    }

    // ---- 2) complete: S3 업로드 확정 + item(신규)/version(기존) 생성 --------
    if (action === 'complete') {
      const { bucket, object, uploadKey, storageUrn, itemId } = body;
      if (!bucket || !object || !uploadKey || !storageUrn) {
        return json({ error: 'bucket/object/uploadKey/storageUrn 필요' }, 400);
      }

      // S3 업로드 확정 → OSS 오브젝트 완성.
      const finRes = await fetch(
        `${APS}/oss/v2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(
          object,
        )}/signeds3upload`,
        {
          method: 'POST',
          headers: { ...bearer, 'content-type': 'application/json' },
          body: JSON.stringify({ uploadKey }),
        },
      );
      if (!finRes.ok && finRes.status !== 200) {
        const f = await finRes.json().catch(() => ({}));
        return json({ error: detail(f, finRes.status) }, finRes.status);
      }

      if (itemId) {
        // 기존 아이템의 새 버전.
        const vRes = await fetch(
          `${APS}/data/v1/projects/${encodeURIComponent(project)}/versions`,
          {
            method: 'POST',
            headers: { ...bearer, ...VND },
            body: JSON.stringify({
              jsonapi: { version: '1.0' },
              data: {
                type: 'versions',
                attributes: { name: fileName, extension: VERSION_EXT },
                relationships: {
                  item: { data: { type: 'items', id: itemId } },
                  storage: { data: { type: 'objects', id: storageUrn } },
                },
              },
            }),
          },
        );
        const v = await vRes.json();
        if (!vRes.ok) return json({ error: detail(v, vRes.status) }, vRes.status);
        const versionUrn: string = v?.data?.id;
        return json({ itemUrn: itemId, versionUrn, urn: versionUrn ? toBase64Url(versionUrn) : null });
      }

      // 신규 파일 → item + 첫 version 을 한 번에 생성.
      if (!folder) return json({ error: 'folder 필요' }, 400);
      const iRes = await fetch(
        `${APS}/data/v1/projects/${encodeURIComponent(project)}/items`,
        {
          method: 'POST',
          headers: { ...bearer, ...VND },
          body: JSON.stringify({
            jsonapi: { version: '1.0' },
            data: {
              type: 'items',
              attributes: { displayName: fileName, extension: ITEM_EXT },
              relationships: {
                tip: { data: { type: 'versions', id: '1' } },
                parent: { data: { type: 'folders', id: folder } },
              },
            },
            included: [
              {
                type: 'versions',
                id: '1',
                attributes: { name: fileName, extension: VERSION_EXT },
                relationships: { storage: { data: { type: 'objects', id: storageUrn } } },
              },
            ],
          }),
        },
      );
      const i = await iRes.json();
      if (!iRes.ok) return json({ error: detail(i, iRes.status) }, iRes.status);
      const itemUrn: string = i?.data?.id;
      const versionUrn: string | undefined = i?.data?.relationships?.tip?.data?.id;
      return json({ itemUrn, versionUrn, urn: versionUrn ? toBase64Url(versionUrn) : null });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
