// =====================================================================
// MIR_VDC — Office Online 전용 파일 capability 엔드포인트.
//
// Office Online(view.aspx)은 src URL의 마지막 경로 조각을 '파일명'으로 표시한다.
// ACC 서명 URL은 끝이 스토리지 UUID라 이름이 깨져 보여서, 경로 끝에 실제 파일명을
// 둔 단기 capability URL을 만들어 넘긴다(우리 세션 토큰 미포함).
//
//   GET /api/office-file/<표시용 파일명>?project=&item=&exp=&sig=
//        sig = HMAC-SHA256(APS_CLIENT_SECRET, `${project}\n${item}\n${exp}`)
//   → 검증 후 Autodesk 서명 다운로드 URL로 302.
//
// 경로의 <파일명>은 표시 전용이며 서명 대상이 아니다(변조해도 다운로드 대상은
// project/item/exp 로 고정 → 무해).
// =====================================================================
export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const APS = 'https://developer.api.autodesk.com';

function err(msg: string, status = 502): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

  const url = new URL(req.url);
  const project = url.searchParams.get('project') ?? '';
  const item = url.searchParams.get('item') ?? '';
  const exp = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!project || !item || !exp || !sig) return err('파라미터 누락', 400);
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return err('링크 만료', 401);

  const expect = await hmacHex(APS_CLIENT_SECRET, `${project}\n${item}\n${exp}`);
  if (sig.length !== expect.length || sig !== expect) return err('서명 불일치', 401);

  try {
    const token = await mintToken();
    const auth = { authorization: `Bearer ${token}` };

    const tipRes = await fetch(
      `${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/tip`,
      { headers: auth },
    );
    const tip = await tipRes.json();
    if (!tipRes.ok) return err(tip?.errors?.[0]?.detail ?? 'tip 조회 실패');
    const storageUrn: string | undefined = tip?.data?.relationships?.storage?.data?.id;
    if (!storageUrn) return err('스토리지 위치를 찾을 수 없습니다.');
    const m = storageUrn.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
    if (!m) return err('스토리지 urn 형식 오류');

    const signRes = await fetch(
      `${APS}/oss/v2/buckets/${encodeURIComponent(m[1])}/objects/${encodeURIComponent(m[2])}/signeds3download`,
      { headers: auth },
    );
    const sign = await signRes.json();
    if (!signRes.ok) return err(sign?.reason ?? '서명 URL 발급 실패');
    const dl: string | undefined = sign?.url ?? sign?.urls?.[0];
    if (!dl) return err('다운로드 URL 없음');

    return new Response(null, { status: 302, headers: { location: dl } });
  } catch (e) {
    return err((e as Error).message);
  }
}
