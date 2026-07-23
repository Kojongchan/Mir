// =====================================================================
// MIR_VDC — ACC(APS) 모델 → (신규 3D뷰: xeokit) 게이트웨이.
//
// 변환은 기존 검증된 파이프라인 재사용(GitHub Actions: convert-4d.yml →
// scripts/convert4d.mjs → SVF→GLB). 결과 GLB 는 **Cloudflare R2**(무료 10GB·
// egress 무료·파일당 50MB 제한 없음)에 저장한다(Supabase 무료 50MB 벽 회피).
//   저장 경로: R2  <bucket>/<urn40>/model.glb  (+ 실패 시 error.json)
// 변환은 모델당 1회(캐시 공유) — 이후 모든 사용자는 R2 presigned URL 로 즉시 로드.
//
// 이 함수(edge): 인증=Supabase 세션 / 저장소=R2(aws4fetch 서명).
//   GET  /api/aps-convert?urn=...  → {ready,url} | {failed,error} | {ready:false}
//   POST /api/aps-convert {urn,force} → 캐시 없으면 워크플로 dispatch → {status:'processing'}
//
// Required env: SUPABASE_URL(or VITE_) / SUPABASE_SERVICE_ROLE_KEY /
//   GH_REPO / GH_TOKEN / GH_REF /
//   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REF = process.env.GH_REF || 'main';
const WORKFLOW_FILE = 'convert-4d.yml';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// convert4d.mjs 와 **동일한** 캐시 키 규약(반드시 일치).
const glbKey = (urn: string) => urn.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function supa() {
  return createClient(SUPABASE_URL as string, SERVICE_ROLE as string, {
    auth: { persistSession: false },
  });
}

function r2() {
  return new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID as string,
    secretAccessKey: R2_SECRET_ACCESS_KEY as string,
    service: 's3',
    region: 'auto',
  });
}
const objUrl = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

async function r2Head(key: string): Promise<boolean> {
  const res = await r2().fetch(objUrl(key), { method: 'HEAD' });
  return res.ok;
}
async function r2PresignGet(key: string, expires = 3600): Promise<string> {
  const signed = await r2().sign(`${objUrl(key)}?X-Amz-Expires=${expires}`, {
    method: 'GET',
    aws: { signQuery: true },
  });
  return signed.url;
}
async function r2GetText(key: string): Promise<string | null> {
  const res = await r2().fetch(objUrl(key));
  return res.ok ? await res.text() : null;
}
async function r2Delete(key: string): Promise<void> {
  await r2().fetch(objUrl(key), { method: 'DELETE' }).catch(() => {});
}

type CacheState =
  | { ready: true; url: string }
  | { failed: true; error: string }
  | { ready: false };

/** R2 캐시 상태: model.glb 있으면 ready(presigned), error.json 있으면 failed, 없으면 처리중. */
async function cacheState(urn: string): Promise<CacheState> {
  const dir = glbKey(urn);
  if (await r2Head(`${dir}/model.glb`)) {
    return { ready: true, url: await r2PresignGet(`${dir}/model.glb`) };
  }
  const errText = await r2GetText(`${dir}/error.json`);
  if (errText) {
    let error = '변환 실패';
    try {
      error = (JSON.parse(errText) as { error?: string }).error ?? error;
    } catch {
      /* 무시 */
    }
    return { failed: true, error };
  }
  return { ready: false };
}

async function clearCache(urn: string): Promise<void> {
  const dir = glbKey(urn);
  await Promise.all([r2Delete(`${dir}/model.glb`), r2Delete(`${dir}/error.json`)]);
}

async function dispatchConvert(urn: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mir-vdc',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: GH_REF, inputs: { urn, region: 'US' } }),
    },
  );
  const body = res.ok ? '' : await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body };
}

export default async function handler(req: Request): Promise<Response> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ error: 'Supabase 환경변수 미설정' }, 500);
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return json({ error: 'R2 환경변수 미설정(R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET)' }, 500);
  }

  // 로그인한 MIR 사용자만.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'missing token' }, 401);
  const { data: userData, error: userErr } = await supa().auth.getUser(bearer);
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);

  const url = new URL(req.url);

  // ── GET: 캐시/실패 상태 조회 ──────────────────────────────────────
  if (req.method === 'GET') {
    const urn = url.searchParams.get('urn') ?? '';
    if (!urn) return json({ error: 'urn 필요' }, 400);
    return json(await cacheState(urn));
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── POST: 캐시 확인 후 없으면 변환 워크플로 dispatch ───────────────
  let body: { urn?: string; force?: boolean };
  try {
    body = (await req.json()) as { urn?: string; force?: boolean };
  } catch {
    return json({ error: 'JSON 본문 필요' }, 400);
  }
  const urn = body.urn ?? '';
  if (!urn) return json({ error: 'urn 필요' }, 400);

  if (body.force) {
    await clearCache(urn);
  } else {
    const st = await cacheState(urn);
    if ('ready' in st && st.ready) return json({ ready: true, url: st.url });
    if ('failed' in st) await clearCache(urn);
  }

  if (!GH_REPO || !GH_TOKEN) {
    return json({ error: '변환 워크플로가 설정되지 않았습니다(GH_REPO/GH_TOKEN).' }, 503);
  }

  const d = await dispatchConvert(urn);
  if (!d.ok) {
    return json({ error: `워크플로 dispatch 실패(${d.status}): ${d.body.slice(0, 200)}` }, 502);
  }
  return json({ status: 'processing' });
}
