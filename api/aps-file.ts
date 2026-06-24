// =====================================================================
// MIR_VDC — ACC 파일 바이트 프록시 (2-legged).
//
// ACC 아이템의 '원본 파일'(PDF/Word/Excel/이미지/영상 등)을 우리 뷰어로 열기
// 위해, 서버가 Data Management 로 다운로드 URL을 구해 바이트를 같은 출처로
// 전달한다(CORS 회피). 영상/오디오 등 큰 파일은 mode=redirect 로 서명 URL에
// 302 리다이렉트(ACC에서 직접 스트리밍).
//
//   GET /api/aps-file?project=<projectId>&item=<itemId>[&mode=redirect]
//
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET (+ Supabase 검증).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

const CT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

function err(msg: string, status = 502): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mintToken(): Promise<string> {
  const basic = btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`);
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

export default async function handler(req: Request): Promise<Response> {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return err('APS 환경변수 미설정', 500);

  // 로그인한 MIR 사용자만.
  if (SUPABASE_URL && SERVICE_ROLE) {
    const url = new URL(req.url);
    const bearer =
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') || // 미디어 태그(src)는 헤더를 못 보내므로 쿼리 허용
      '';
    if (!bearer) return err('missing token', 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return err('invalid session', 401);
  }

  const url = new URL(req.url);
  const project = url.searchParams.get('project') ?? '';
  const item = url.searchParams.get('item') ?? '';
  const mode = url.searchParams.get('mode') ?? 'proxy';
  if (!project || !item) return err('project/item 필요', 400);

  try {
    const token = await mintToken();
    const auth = { authorization: `Bearer ${token}` };

    // 1) 아이템의 최신 버전(tip) → 스토리지 오브젝트 urn + 파일명.
    const tipRes = await fetch(
      `${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/tip`,
      { headers: auth },
    );
    const tip = await tipRes.json();
    if (!tipRes.ok) return err(tip?.errors?.[0]?.detail ?? 'tip 조회 실패');
    const storageUrn: string | undefined = tip?.data?.relationships?.storage?.data?.id;
    const name: string = tip?.data?.attributes?.name ?? 'file';
    if (!storageUrn) return err('스토리지 위치를 찾을 수 없습니다(변환 전이거나 권한).');

    // urn:adsk.objects:os.object:<bucket>/<object>
    const m = storageUrn.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
    if (!m) return err('스토리지 urn 형식 오류');
    const bucket = m[1];
    const object = m[2];

    // 2) S3 서명 다운로드 URL. Office Online(mode=signed) 은 파일명을 표시하므로
    //    response-content-disposition 에 실제 파일명을 실어 URL에 굽는다(공개 URL).
    const dispoName = url.searchParams.get('name') || name;
    const signParams =
      mode === 'signed'
        ? `?response-content-disposition=${encodeURIComponent(`attachment; filename*=UTF-8''${encodeURIComponent(dispoName)}`)}`
        : '';
    const signRes = await fetch(
      `${APS}/oss/v2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(object)}/signeds3download${signParams}`,
      { headers: auth },
    );
    const sign = await signRes.json();
    if (!signRes.ok) return err(sign?.reason ?? '서명 URL 발급 실패');
    const dl: string | undefined = sign?.url ?? sign?.urls?.[0];
    if (!dl) return err('다운로드 URL 없음');

    // 영상/오디오 등 — 직접 스트리밍(서버 부담 회피).
    if (mode === 'redirect') {
      return new Response(null, { status: 302, headers: { location: dl } });
    }

    // Office Online 등 외부 렌더러가 직접 가져갈 수 있도록 '서명 다운로드 URL'만
    // JSON 으로 반환(우리 세션 토큰은 노출되지 않음 — Autodesk 단기 서명 URL).
    if (mode === 'signed') {
      return new Response(JSON.stringify({ url: dl, name }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' },
      });
    }

    // 문서 — 바이트를 같은 출처로 프록시(CORS 회피).
    const fileRes = await fetch(dl);
    if (!fileRes.ok || !fileRes.body) return err('파일 다운로드 실패');
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const ct = fileRes.headers.get('content-type') ?? CT[ext] ?? 'application/octet-stream';
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'content-type': ct,
        'cache-control': 'private, max-age=300',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch (e) {
    return err((e as Error).message);
  }
}
