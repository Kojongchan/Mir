// =====================================================================
// MIR_VDC — APS 파생물(Derivative) 규모 측정 (4D 자체 뷰어 PoC 1단계).
//
// 4D 공정관리 뷰를 LMV 대신 우리 자체 Three.js 뷰어로 그리려면, ACC 모델의
// SVF 지오메트리를 glTF 로 변환해야 한다. 변환을 한 방에 할 수 있는지(서버리스
// 시간·메모리 한도 내)를 먼저 알기 위해, 모델의 SVF 파생물 개수·총 용량·뷰어블
// (viewable) 수를 측정해 돌려준다. 변환 자체는 하지 않으므로 항상 가볍게 성공.
//
// 사용: GET /api/aps-derivative-info?urn=<base64url URN>&region=US
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET (+ Supabase 검증).
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

interface DerivativeNode {
  type?: string;
  role?: string;
  mime?: string;
  size?: number;
  status?: string;
  progress?: string;
  guid?: string;
  outputType?: string;
  name?: string;
  children?: DerivativeNode[];
}

export default async function handler(req: Request): Promise<Response> {
  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) return json({ error: 'APS 환경변수 미설정' }, 500);

  if (SUPABASE_URL && SERVICE_ROLE) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return json({ error: 'missing bearer token' }, 401);
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data, error } = await supa.auth.getUser(bearer);
    if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  }

  const url = new URL(req.url);
  const urn = url.searchParams.get('urn') ?? '';
  const region = (url.searchParams.get('region') ?? 'US').toUpperCase();
  if (!urn) return json({ error: 'urn 누락' }, 400);

  try {
    const token = await mintToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (region === 'EMEA' || region === 'AUS') headers['region'] = region;

    const mres = await fetch(`${APS}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { headers });
    const manifest = (await mres.json()) as { status?: string; progress?: string; derivatives?: DerivativeNode[] };
    if (!mres.ok) return json({ error: `manifest ${mres.status}`, detail: manifest }, 502);

    // SVF 그래픽 파생물·속성DB·뷰어블을 모은다.
    const svf: { guid?: string; size: number; status?: string; mime?: string }[] = [];
    let propDbSize = 0;
    let viewables = 0;
    let totalSize = 0;

    const walk = (n: DerivativeNode) => {
      if (typeof n.size === 'number') totalSize += n.size;
      const isSvf = n.role === 'graphics' && (n.mime === 'application/autodesk-svf' || n.mime === 'application/autodesk-svf2');
      if (isSvf) svf.push({ guid: n.guid, size: n.size ?? 0, status: n.status, mime: n.mime });
      if (n.role === 'Autodesk.CloudPlatform.PropertyDatabase') propDbSize += n.size ?? 0;
      if (n.type === 'geometry' && (n.role === '3d' || n.outputType === 'svf' || n.outputType === 'svf2')) viewables++;
      n.children?.forEach(walk);
    };
    manifest.derivatives?.forEach(walk);

    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    const svfTotal = svf.reduce((s, d) => s + d.size, 0);

    return json({
      ok: true,
      status: manifest.status,
      progress: manifest.progress,
      region,
      viewables,
      svfCount: svf.length,
      svfTotalMB: mb(svfTotal),
      propDbMB: mb(propDbSize),
      totalDerivativeMB: mb(totalSize),
      svf: svf.map((d) => ({ guid: d.guid, mime: d.mime, status: d.status, sizeMB: mb(d.size) })),
      svfKinds: [...new Set(svf.map((d) => d.mime))],
      sizeReported: svfTotal > 0,
      // 판단은 "SVF 존재 여부" 기준. 용량은 manifest 가 보통 0 으로 주므로 변환 때 실측.
      verdict:
        svf.length === 0
          ? 'SVF 파생물 없음(아직 변환 미완이거나 다른 포맷). 변환 방식 재검토 필요.'
          : svfTotal === 0
            ? 'SVF 파생물 있음 ✅ (용량은 manifest 미보고 — 정상). 변환 진행 시 실측됨.'
            : svfTotal < 80 * 1048576
              ? '소형 — 단일 서버리스 변환 가능성 높음.'
              : svfTotal < 300 * 1048576
                ? '중형 — 서버리스 한계 근접. 파생물 단위 분할 권장.'
                : '대형 — 단일 서버리스 변환 어려움. 백그라운드/분할 변환 필요.',
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
