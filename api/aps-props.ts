// =====================================================================
// MIR — 모델 객체 속성 요약(공정·공사비 6단계 BIM 연결, D30). ACC 가 변환한 모델(Model Derivative)의
// 첫 3D 뷰 속성을 읽어 연결에 필요한 칸만 돌려준다 — 모델 파일은 받지 않는다.
//
//   GET /api/aps-props?urn=<base64url 버전 URN>
//   → { pending: true } (속성 준비 중, 잠시 뒤 다시) | { view, objects: [{ id, ext, name, label, type, comment, ifcGuid,
//        ifcClass, code, level7, level8, plannedStart, plannedFinish, actualStart, actualFinish, volume, volumeFrom, volumeGeometry }] }
//        — 객체 = 속성이 있는 끝 객체(이름·유형 그룹 노드 제외)
//
// 속성 이름은 Revit 한국어판 기준(유형 이름·해설·체적)과 공단 BIM 속성(A1_객체명칭·A3_*). 영문판 이름도 함께 본다.
// IFC(Revit 에서 내보낸 것)는 사용자 속성이 빠지는 일이 많다 — 요소(IfcClass 가 있는 객체)의 이름 'Family:Type:Tag' 을
// 패밀리·유형으로 나눠 Revit 과 같은 칸에 넣는다(10-23 연제교 IFC: 사용자 속성 없음, 요소 840).
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET (+ Supabase 로그인 확인).
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';

export const config = { runtime: 'edge' };

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APS = 'https://developer.api.autodesk.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function mintToken(): Promise<string> {
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  const d = (await res.json()) as { access_token?: string };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

type Props = Record<string, Record<string, unknown> | unknown>;
const pick = (flat: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) { const v = flat[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim(); }
  return '';
};

/** 속성 한 객체 → 연결용 요약(없으면 null). */
export function summarize(o: { objectid: number; name?: string; externalId?: string; properties?: Props }) {
  const flat: Record<string, unknown> = {};
  for (const g of Object.values(o.properties ?? {})) if (g && typeof g === 'object') Object.assign(flat, g as Record<string, unknown>);
  // IFC: 요소에만 IfcClass 가 있다(유형·재료·형상 노드는 없음). 공간 요소(프로젝트·대지·건물·층)는 뺀다.
  const ifcClass = pick(flat, 'IfcClass');
  if (/^Ifc(Project|Site|Building|BuildingStorey|Space)$/.test(ifcClass)) return null;
  const ifcParts = ifcClass ? (pick(flat, 'IfcName') || o.name || '').split(':') : [];
  const type = pick(flat, '유형 이름', 'Type Name') || (ifcParts.length > 1 ? ifcParts[1] : '');
  const label = pick(flat, 'A1_객체명칭');
  if (!type && !label && !ifcClass) return null; // 그룹 노드(범주·패밀리)
  const vol = /([\d.,]+)\s*m\^?3/.exec(pick(flat, '체적', 'Volume'));
  return {
    id: o.objectid, ext: o.externalId ?? '',
    name: ifcParts.length > 1 ? ifcParts[0] : (o.name ?? '').replace(/\s*\[\d+\]\s*$/, ''),
    label, type, comment: pick(flat, '해설', 'Comments'), ifcGuid: pick(flat, 'IfcGUID'), ifcClass,
    code: pick(flat, 'A3_WBS CODE (IPS)'), level7: pick(flat, 'A3_Level7'), level8: pick(flat, 'A3_Level8'),
    // 공단 BIM 속성 A5(공정 날짜) — 모델 반영(7단계) 비교·개략 IPS 와 현장 일정 비교에 쓴다
    plannedStart: pick(flat, 'A5_계획공정시작일'), plannedFinish: pick(flat, 'A5_계획공정종료일'),
    actualStart: pick(flat, 'A5_실시공정시작일'), actualFinish: pick(flat, 'A5_실시공정종료일'),
    volume: vol ? Number(vol[1].replace(/,/g, '')) as number | null : null,
    /** 체적의 출처: 모델 속성(체적) 또는 형상 계산(build-model-volumes). */
    volumeFrom: (vol ? 'model' : null) as 'model' | 'geometry' | null,
    /** 속성 체적이 있을 때 형상에서 계산한 체적(검증용 — 크게 다르면 대사에서 알림). */
    volumeGeometry: undefined as number | undefined,
  };
}

export type ModelObject = NonNullable<ReturnType<typeof summarize>>;

/** 변환본 첫 3D 뷰의 객체 요약. 준비 중이면 { pending }. 6단계 화면(이 API)과 AI 연결(MCP)이 같이 쓴다. */
export async function readModelObjects(urn: string, token: string):
  Promise<{ pending: true } | { view: string; objects: ModelObject[] } | { error: string; status: number }> {
  const headers = { authorization: `Bearer ${token}` };
  const meta = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata`, { headers });
  if (meta.status === 202) return { pending: true };
  const m = (await meta.json()) as { data?: { metadata?: { guid: string; name: string; role: string }[] } };
  if (!meta.ok) return { error: `metadata ${meta.status}`, status: 502 };
  const views = (m.data?.metadata ?? []).filter(v => v.role === '3d');
  const view = views.find(v => v.name === '{3D}') ?? views[0];
  if (!view) return { error: '3D 뷰가 없는 모델입니다.', status: 422 };
  const pr = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, { headers });
  if (pr.status === 202) return { pending: true };
  if (!pr.ok) return { error: `properties ${pr.status}`, status: 502 };
  const p = (await pr.json()) as { data?: { collection?: { objectid: number; name?: string; externalId?: string; properties?: Props }[] } };
  const objects = elementsOnly((p.data?.collection ?? []).map(summarize).filter((o): o is ModelObject => o !== null));
  // 체적 속성이 없는 객체: 형상에서 계산한 체적(Actions model-volumes → R2)이 있으면 그것. 있으면 형상 값은 검증용으로 곁에.
  const volumes = await readVolumes(urn).catch(() => null);
  if (volumes) {
    for (const o of objects) {
      const g = o.ext ? volumes[o.ext] : undefined;
      if (g == null) continue;
      if (o.volume == null) { o.volume = g; o.volumeFrom = 'geometry'; } else o.volumeGeometry = g;
    }
  }
  return { view: view.name, objects };
}

// scripts/cache-key.mjs·api/aps-convert.ts 와 같은 캐시 키: 전체 URN(버전 포함)의 SHA-256 앞 40자.
async function cacheKey(urn: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(urn));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

/** 형상에서 계산한 객체 체적(m³, 외부 ID → 값) — scripts/build-model-volumes.mjs 가 쓴 것. R2 설정이 없거나 아직 없으면 null. */
export async function readVolumes(urn: string): Promise<Record<string, number> | null> {
  const env = process.env;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) return null;
  const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const r = await r2.fetch(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${await cacheKey(urn)}/volumes/current.json`);
  if (!r.ok) return null;
  const j = (await r.json()) as { volumes?: Record<string, number> };
  return j.volumes ?? null;
}

/**
 * IFC 모델이면 요소(IfcClass 가 있는 객체)만 — 유형 이름만 있는 노드('WPC_27.5m_2.3m_1:WPC_27.5m_2.3m', 외부 ID '…/0/0')는
 * 같은 요소의 유형·형상 조각이라 연결 대상이 아니다(연제교 상선 IFC: 1,029 중 193). Revit 모델(IfcClass 없음)은 그대로.
 */
export function elementsOnly(objects: ModelObject[]): ModelObject[] {
  return objects.some(o => o.ifcClass) ? objects.filter(o => o.ifcClass) : objects;
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
  const urn = new URL(req.url).searchParams.get('urn') ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(urn)) return json({ error: 'urn 누락/형식 오류' }, 400);
  try {
    const r = await readModelObjects(urn, await mintToken());
    return 'error' in r ? json({ error: r.error }, r.status) : json(r);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
