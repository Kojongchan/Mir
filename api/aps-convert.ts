// =====================================================================
// MIR_VDC — ACC(APS) 모델 → (신규 3D뷰: xeokit) 게이트웨이.
//
// 변환은 **이미 있는 검증된 파이프라인**을 재사용한다:
//   .github/workflows/convert-4d.yml + scripts/convert4d.mjs
//   → SVF(ACC 보유) → glTF → 병합/데시메이션 GLB → Supabase 'models4d' 버킷
//      <urn40>/model.glb  (거대 모델 대응·CI 다운로드 타임아웃 해결 완료)
// 변환은 **모델당 1회**(캐시 공유) — 이후 모든 사용자는 캐시 GLB 를 xeokit 로 즉시 로드.
//
// 이 함수(edge)는 무거운 변환을 하지 않는다:
//   GET  /api/aps-convert?urn=<base64 URN>  → {ready:true,url} | {ready:false}
//   POST /api/aps-convert  {urn}            → {ready:true,url} | {status:'processing'}
//     (캐시 없으면 GitHub Actions 워크플로를 urn 으로 dispatch → 즉시 processing)
//
// Required env: SUPABASE_URL(or VITE_) / SUPABASE_SERVICE_ROLE_KEY /
//               GH_REPO(owner/repo) / GH_TOKEN(workflow dispatch PAT) /
//               GH_REF(워크플로 실행 브랜치, 기본 main)
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GH_REPO = process.env.GH_REPO; // 예: 'Kojongchan/Mir'
const GH_TOKEN = process.env.GH_TOKEN; // workflow dispatch 권한 PAT
const GH_REF = process.env.GH_REF || 'main'; // 워크플로가 있는 브랜치
const WORKFLOW_FILE = 'convert-4d.yml';

// convert4d.mjs 와 **동일한** 캐시 규약(반드시 일치해야 로드가 캐시를 찾는다).
const BUCKET = 'models4d';
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

type CacheState =
  | { ready: true; url: string }
  | { failed: true; error: string }
  | { ready: false };

/** 캐시 상태: model.glb 있으면 ready, error.json 있으면 failed, 둘 다 없으면 처리중. */
async function cacheState(urn: string): Promise<CacheState> {
  const dir = glbKey(urn);
  const client = supa();
  const { data: list } = await client.storage.from(BUCKET).list(dir);
  const names = new Set((list ?? []).map((f) => f.name));
  if (names.has('model.glb')) {
    const { data } = await client.storage.from(BUCKET).createSignedUrl(`${dir}/model.glb`, 3600);
    if (data?.signedUrl) return { ready: true, url: data.signedUrl };
  }
  if (names.has('error.json')) {
    let error = '변환 실패';
    try {
      const { data } = await client.storage.from(BUCKET).download(`${dir}/error.json`);
      if (data) error = (JSON.parse(await data.text()) as { error?: string }).error ?? error;
    } catch {
      /* 마커 읽기 실패는 무시 */
    }
    return { failed: true, error };
  }
  return { ready: false };
}

/** 강제 재변환 전 캐시/실패 마커 제거. */
async function clearCache(urn: string): Promise<void> {
  const dir = glbKey(urn);
  await supa().storage.from(BUCKET).remove([`${dir}/model.glb`, `${dir}/error.json`]).catch(() => {});
}

/** GitHub Actions 변환 워크플로를 urn 으로 실행(비동기). 성공 시 204. */
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
    // 강제 재변환: 기존 GLB·실패 마커 제거 후 새로 돌린다(빈 캐시 갱신·재시도).
    await clearCache(urn);
  } else {
    const st = await cacheState(urn);
    if ('ready' in st && st.ready) return json({ ready: true, url: st.url });
    // 실패 마커가 남아 있으면(직전 실패) 재시도 위해 제거하고 재dispatch.
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
