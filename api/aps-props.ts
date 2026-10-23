// =====================================================================
// MIR — 모델 객체 속성 요약(공정·공사비 6단계 BIM 연결, D30). ACC 가 변환한 모델(Model Derivative)의
// 첫 3D 뷰 속성을 읽어 연결에 필요한 칸만 돌려준다 — 모델 파일은 받지 않는다.
//
//   GET /api/aps-props?urn=<base64url 버전 URN>
//   → { pending: true } (속성 준비 중, 잠시 뒤 다시) | { view, objects: [{ id, ext, name, label, type, comment, ifcGuid,
//        code, level7, level8, volume }] }  — 객체 = 속성이 있는 끝 객체(이름·유형 그룹 노드 제외)
//
// 속성 이름은 Revit 한국어판 기준(유형 이름·해설·체적)과 공단 BIM 속성(A1_객체명칭·A3_*). 영문판 이름도 함께 본다.
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET (+ Supabase 로그인 확인).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

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
  const type = pick(flat, '유형 이름', 'Type Name');
  const label = pick(flat, 'A1_객체명칭');
  if (!type && !label) return null; // 그룹 노드(범주·패밀리)
  const vol = /([\d.,]+)\s*m\^?3/.exec(pick(flat, '체적', 'Volume'));
  return {
    id: o.objectid, ext: o.externalId ?? '', name: (o.name ?? '').replace(/\s*\[\d+\]\s*$/, ''),
    label, type, comment: pick(flat, '해설', 'Comments'), ifcGuid: pick(flat, 'IfcGUID'),
    code: pick(flat, 'A3_WBS CODE (IPS)'), level7: pick(flat, 'A3_Level7'), level8: pick(flat, 'A3_Level8'),
    volume: vol ? Number(vol[1].replace(/,/g, '')) : null,
  };
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
    const headers = { authorization: `Bearer ${await mintToken()}` };
    const meta = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata`, { headers });
    if (meta.status === 202) return json({ pending: true });
    const m = (await meta.json()) as { data?: { metadata?: { guid: string; name: string; role: string }[] } };
    if (!meta.ok) return json({ error: `metadata ${meta.status}` }, 502);
    const views = (m.data?.metadata ?? []).filter(v => v.role === '3d');
    const view = views.find(v => v.name === '{3D}') ?? views[0];
    if (!view) return json({ error: '3D 뷰가 없는 모델입니다.' }, 422);
    const pr = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, { headers });
    if (pr.status === 202) return json({ pending: true });
    if (!pr.ok) return json({ error: `properties ${pr.status}` }, 502);
    const p = (await pr.json()) as { data?: { collection?: { objectid: number; name?: string; externalId?: string; properties?: Props }[] } };
    const objects = (p.data?.collection ?? []).map(summarize).filter(o => o !== null);
    return json({ view: view.name, objects });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
