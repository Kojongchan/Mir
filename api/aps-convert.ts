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

// R2 무료 한도(10GB)에 임박하면 변환 전 경고하기 위해 총 사용량을 잰다.
const FREE_BYTES = 10e9;
const WARN_BYTES = 9e9; // 9GB 부터 경고
async function r2TotalSize(): Promise<number> {
  const client = r2();
  let total = 0;
  let token = '';
  for (let i = 0; i < 50; i++) {
    const u =
      `${R2_ENDPOINT}/${R2_BUCKET}?list-type=2&max-keys=1000` +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
    const res = await client.fetch(u);
    if (!res.ok) break;
    const xml = await res.text();
    for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) total += Number(m[1]);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    const nt = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!nt) break;
    token = nt[1];
  }
  return total;
}

type Focus = { center: [number, number, number]; half: [number, number, number] };
type CacheState =
  | { ready: true; xkt: true; urls: string[]; navUrls?: string[]; lod1Url?: string; focus?: Focus }
  | { ready: true; url: string; focus?: Focus }
  | { failed: true; error: string }
  | { ready: false };

async function readFocus(dir: string): Promise<Focus | undefined> {
  const focusText = await r2GetText(`${dir}/focus.json`);
  if (!focusText) return undefined;
  try {
    return JSON.parse(focusText) as Focus;
  } catch {
    return undefined;
  }
}

/**
 * R2 캐시 상태 조회. 우선순위:
 *  1) xkt/manifest.json → XKT 파이프라인(분할 XKT). 각 파일 presigned URL 배열 반환.
 *  2) model.glb → 구 단일 GLB 경로(DWG 등).
 *  3) error.json → 실패. 없으면 처리중.
 */
async function cacheState(urn: string): Promise<CacheState> {
  const dir = glbKey(urn);
  const manifestText = await r2GetText(`${dir}/xkt/manifest.json`);
  if (manifestText) {
    try {
      const { xktFiles, navFiles, lod1 } = JSON.parse(manifestText) as { xktFiles: string[]; navFiles?: string[]; lod1?: string | null };
      if (Array.isArray(xktFiles) && xktFiles.length > 0) {
        const urls = await Promise.all(xktFiles.map((f) => r2PresignGet(`${dir}/xkt/${f}`)));
        const navUrls = Array.isArray(navFiles) && navFiles.length > 0
          ? await Promise.all(navFiles.map((f) => r2PresignGet(`${dir}/xkt/${f}`)))
          : undefined;
        const lod1Url = lod1 ? await r2PresignGet(`${dir}/xkt/${lod1}`) : undefined;
        return { ready: true, xkt: true, urls, navUrls, lod1Url, focus: await readFocus(dir) };
      }
    } catch {
      /* 매니페스트 파손 — GLB/실패 경로로 폴백 */
    }
  }
  if (await r2Head(`${dir}/model.glb`)) {
    const url = await r2PresignGet(`${dir}/model.glb`);
    let focus: Focus | undefined;
    const focusText = await r2GetText(`${dir}/focus.json`);
    if (focusText) {
      try {
        focus = JSON.parse(focusText) as Focus;
      } catch {
        /* 무시 */
      }
    }
    return { ready: true, url, focus };
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
  // XKT 분할 파일 전체 삭제(list → delete) — 재변환 시 이전 잔재(파일 수 변동)가 남지 않게.
  const client = r2();
  let token = '';
  for (let i = 0; i < 50; i++) {
    const u =
      `${R2_ENDPOINT}/${R2_BUCKET}?list-type=2&prefix=${encodeURIComponent(`${dir}/xkt/`)}&max-keys=1000` +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
    const res = await client.fetch(u);
    if (!res.ok) break;
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    await Promise.all(keys.map((k) => r2Delete(k)));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    const nt = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!nt) break;
    token = nt[1];
  }
}

// DWG 는 솔리드 + 선/점을 모두 보여줘야 하므로 선 유지('1'), 그 외(IFC/RVT/NWD)는
// 엣지선 잡음을 제외('0'). 파일명 확장자로 판단한다.
function includeLinesFor(name: string): '0' | '1' {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ext === 'dwg' ? '1' : '0';
}

async function dispatchConvert(
  inputs: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
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
      body: JSON.stringify({ ref: GH_REF, inputs }),
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
  let body: { urn?: string; name?: string; project?: string; item?: string; force?: boolean; ackOverage?: boolean; dxf?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'JSON 본문 필요' }, 400);
  }
  const urn = body.urn ?? '';
  if (!urn) return json({ error: 'urn 필요' }, 400);
  const isDwg = (body.name ?? '').split('.').pop()?.toLowerCase() === 'dwg';
  // DWG 3D: 자체 DXF 경로(깔끔한 벡터 선형·문자)를 기본으로 쓴다. 이 DWG 의 지표면은 계산식
  // Civil3D 객체라 오토데스크 3D 변환(SVF)에도 음영면으로 안 나온다(ACC 3D 뷰에서도 동일 확인).
  // SVF 는 지표면 이득 없이 무지개색 선·평면 시트만 더해 더 지저분해져서 DWG 엔 안 쓴다.
  // 진짜 음영 지표면은 NWD(Navisworks — 지표면이 메시로 구워짐) → 자동 SVF 경로로 얻는다.
  const useDxf = isDwg && !!body.project && !!body.item;
  const includeLines = includeLinesFor(body.name ?? '');

  if (body.force) {
    await clearCache(urn);
  } else {
    const st = await cacheState(urn);
    if ('ready' in st && st.ready) return json(st);
    if ('failed' in st) await clearCache(urn);
  }

  // 저장소 임박 경고: 9GB 이상이면 변환(=새 업로드) 전에 경고. 사용자가 ackOverage 로 진행.
  if (!body.ackOverage) {
    const used = await r2TotalSize();
    if (used >= WARN_BYTES) {
      return json({
        warn: true,
        usedGB: +(used / 1e9).toFixed(2),
        freeGB: +Math.max(0, (FREE_BYTES - used) / 1e9).toFixed(2),
      });
    }
  }

  if (!GH_REPO || !GH_TOKEN) {
    return json({ error: '변환 워크플로가 설정되지 않았습니다(GH_REPO/GH_TOKEN).' }, 503);
  }

  const inputs: Record<string, string> = useDxf
    ? { urn, region: 'US', dxf_test: '1', project: body.project as string, item: body.item as string }
    : { urn, region: 'US', include_lines: includeLines };
  const d = await dispatchConvert(inputs);
  if (!d.ok) {
    return json({ error: `워크플로 dispatch 실패(${d.status}): ${d.body.slice(0, 200)}` }, 502);
  }
  return json({ status: 'processing' });
}
