// =====================================================================
// 4D 자체 뷰어용 변환기 — ACC 모델(SVF) → glTF → GLB(Draco) → Supabase Storage.
//
// GitHub Actions(메모리/디스크 충분)에서 1회 실행한다. Vercel 서버리스로는 대형
// 모델을 한 번에 변환하기 어렵기 때문(시간·메모리·/tmp 한도). 4D 모델은 관리자가
// "고정"하는 단일 모델이라 모델당 1회 변환이면 충분하다.
//
// 객체별 4D 통제(숨김/색)를 위해 각 glTF 노드 이름에 SVF dbId 를 넣는다. 런타임
// (자체 Three.js 뷰어)은 매핑된 객체만 개별 메시로 두고 나머지는 병합해 가볍게 그린다.
//
// 필요한 환경변수(전부 GitHub Actions Secrets 로 주입):
//   APS_CLIENT_ID, APS_CLIENT_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PROJECT_ID            (대상 프로젝트 — projects.acc_4d_urn 을 읽음)
//   URN(선택)             (직접 URN 지정 시 PROJECT_ID 보다 우선)
//   APS_REGION(선택, 기본 US)
//   STORAGE_BUCKET(선택, 기본 'models4d')
// 산출물: Supabase Storage  <bucket>/<projectId-or-urnhash>/model.glb
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { SVFReader } from 'svf-utils';
import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';
import { ModelDerivativeClient } from '@aps_sdk/model-derivative';
import AdmZip from 'adm-zip';
import gltfPipeline from 'gltf-pipeline';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { buildMergedGlb } from './mergeGlb.mjs';

const APS_BASE = 'https://developer.api.autodesk.com';

const {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  SUPABASE_SERVICE_ROLE_KEY,
  PROJECT_ID = '',
  URN: URN_ENV = '',
  APS_REGION = 'US',
  STORAGE_BUCKET = 'models4d',
} = process.env;

// SUPABASE_URL 정규화: 앞뒤 공백/따옴표 제거, 스킴 없으면 https:// 보정,
// 끝 슬래시 제거. SUPABASE_URL 없으면 VITE_SUPABASE_URL 로 폴백.
function cleanUrl(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}
const SUPABASE_URL = cleanUrl(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL);

// Cloudflare R2 (결과 GLB 저장소) — Supabase 무료 50MB 상한 회피(무료 10GB·egress 무료).
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
} = process.env;
let _r2 = null;
function r2() {
  if (!_r2) {
    _r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return _r2;
}
async function r2Put(key, body, contentType) {
  await r2().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
}
async function r2Delete(key) {
  await r2().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {});
}

function need(name, v) {
  if (!v) throw new Error(`환경변수 누락: ${name}`);
  return v;
}

async function resolveUrn(supabase) {
  if (URN_ENV) return URN_ENV;
  need('PROJECT_ID', PROJECT_ID);
  const { data, error } = await supabase.from('projects').select('acc_4d_urn').eq('id', PROJECT_ID).single();
  if (error) throw new Error(`projects.acc_4d_urn 조회 실패: ${error.message}`);
  if (!data?.acc_4d_urn) throw new Error('이 프로젝트에 4D 모델(acc_4d_urn)이 지정돼 있지 않습니다.');
  return data.acc_4d_urn;
}

async function getSvfDerivatives(urn) {
  const authClient = new AuthenticationClient();
  const md = new ModelDerivativeClient();
  const cred = await authClient.getTwoLeggedToken(APS_CLIENT_ID, APS_CLIENT_SECRET, [Scopes.ViewablesRead]);
  const manifest = await md.getManifest(urn, { accessToken: cred.access_token, region: APS_REGION });
  const out = [];
  const walk = (d, depth = 0) => {
    // 진단: 이 URN 의 '모든' 뷰어블/리소스를 출력 — 특히 2D(f2d) 뷰가 있으면 폴리선·호·
    // 선종류·선가중치·해치·TIN 이 벡터로 보존됐을 수 있어 SVF(3D 테셀레이션) 대신 쓸 수 있다.
    if (d.type === 'view' || d.type === 'geometry' || d.type === 'resource') {
      console.log(`[manifest] ${' '.repeat(depth * 2)}type=${d.type} role=${d.role || '-'} mime=${d.mime || '-'} name=${(d.name || '-').slice(0, 40)} guid=${(d.guid || '-').slice(0, 12)}`);
    }
    if (d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') out.push(d);
    d.children?.forEach((c) => walk(c, depth + 1));
  };
  manifest.derivatives?.forEach((d) => {
    console.log(`[manifest] derivative outputType=${d.outputType} name=${d.name || '-'}`);
    d.children?.forEach((c) => walk(c, 1));
  });
  return out;
}

// ACC 최신 파일은 뷰어용으로 SVF2 만 있을 때가 많다(svf-utils 는 SVF 만 읽음). SVF 파생물이
// 없으면 Model Derivative 에 **SVF(2d+3d) 변환 작업**을 요청하고 준비될 때까지 폴링한다.
// 이렇게 해야 원본 DWG 업로드만으로(추가 파일 없이) 진짜 지표면·코리더(3D 뷰)를 얻는다.
async function apsToken(scope) {
  const basic = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 실패: ' + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}
function scanManifest(mani) {
  let svf = false, svf2 = false, views3d = 0, views2d = 0;
  const walk = (d) => {
    if (d.role === 'graphics' && d.mime === 'application/autodesk-svf') svf = true;
    if (d.mime === 'application/autodesk-svf2') svf2 = true;
    if (d.role === '3d') views3d++;
    if (d.role === '2d') views2d++;
    d.children?.forEach(walk);
  };
  mani.derivatives?.forEach((dd) => dd.children?.forEach(walk));
  return { svf, svf2, views3d, views2d, status: mani.status, progress: mani.progress };
}
async function ensureSvf(urn) {
  const md = new ModelDerivativeClient();
  const readTok = async () =>
    (await new AuthenticationClient().getTwoLeggedToken(APS_CLIENT_ID, APS_CLIENT_SECRET, [Scopes.ViewablesRead])).access_token;
  let s = scanManifest(await md.getManifest(urn, { accessToken: await readTok(), region: APS_REGION }));
  console.log(`[convert4d] 기존 파생물: svf=${s.svf} svf2=${s.svf2} 3D뷰=${s.views3d} 2D뷰=${s.views2d} status=${s.status}`);
  if (s.svf) return;
  // SVF 없음 → 변환 작업 요청.
  const tok = await apsToken('data:read data:write data:create viewables:read');
  const jobRes = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`, 'content-type': 'application/json',
      ...(APS_REGION && APS_REGION !== 'US' ? { 'x-ads-region': APS_REGION } : {}),
    },
    body: JSON.stringify({ input: { urn }, output: { formats: [{ type: 'svf', views: ['2d', '3d'] }] } }),
  });
  const jt = await jobRes.text();
  if (!jobRes.ok) throw new Error(`SVF 변환 작업 요청 실패(${jobRes.status}): ${jt.slice(0, 200)}`);
  console.log('[convert4d] SVF 변환 작업 접수 — 완료까지 폴링(최대 40분)…');
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 12000));
    s = scanManifest(await md.getManifest(urn, { accessToken: await readTok(), region: APS_REGION }));
    if (s.svf) { console.log('[convert4d] SVF 파생물 준비됨'); return; }
    if (s.status === 'failed') throw new Error('APS SVF 변환 실패(manifest status=failed)');
    if (Date.now() - t0 > 40 * 60 * 1000) throw new Error('SVF 변환 시간 초과(40분)');
    console.log(`[convert4d]   변환중… status=${s.status} progress=${s.progress}`);
  }
}

// --- 직접 다운로더(레거시 derivativeservice) ---
// svf-utils 내장 다운로더는 getDerivativeUrl(signedcookies, SDK 15초 타임아웃)에서
// CI 환경에서 자주 끊긴다. 우리 인앱 뷰어가 쓰는 레거시 엔드포인트로 타임아웃 없이
// 직접 받아 디스크에 저장한 뒤 SVFReader.FromFileSystem 으로 읽는다.
async function mintApsToken() {
  const basic = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  return d.access_token;
}

async function fetchDerivativeBytes(token, derivativeUrn, tries = 5) {
  const url = `${APS_BASE}/derivativeservice/v2/derivatives/${encodeURIComponent(derivativeUrn)}`;
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const headers = { authorization: `Bearer ${token}` };
      if (APS_REGION && APS_REGION !== 'US') headers['region'] = APS_REGION;
      const res = await fetch(url, { headers }); // fetch 는 기본 타임아웃 없음
      if (!res.ok) {
        const err = new Error(`derivative ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw lastErr;
}

async function downloadSvfToDisk(derivative, outDir) {
  let token = await mintApsToken();
  const svfDerivUrn = derivative.urn;
  if (!svfDerivUrn) throw new Error('SVF 파생물 urn 이 manifest 에 없습니다.');
  fs.mkdirSync(outDir, { recursive: true });

  const svfBytes = await fetchDerivativeBytes(token, svfDerivUrn);
  const svfName = svfDerivUrn.substring(svfDerivUrn.lastIndexOf('/') + 1) || 'output.svf';
  fs.writeFileSync(path.join(outDir, svfName), svfBytes);

  // .svf(zip) 안의 manifest.json 에서 에셋 목록을 얻어 같은 폴더로 받는다.
  const zip = new AdmZip(svfBytes);
  const svfManifest = JSON.parse(zip.readAsText('manifest.json'));
  const basePath = svfDerivUrn.substring(0, svfDerivUrn.lastIndexOf('/') + 1);
  const assets = (svfManifest.assets || []).filter(
    (a) =>
      a.URI &&
      !a.URI.startsWith('embed:') &&
      !a.URI.includes('://') &&
      a.URI !== svfName &&
      // 속성 DB(objects_*.json.gz)는 지오메트리 GLB 에 불필요(dbId 는 fragment 에서 나옴)하고,
      // 모델마다 상위폴더 공유(../, RVT)거나 매니페스트에 있는데 실제 404(DWG)라 변환을 죽인다.
      // read({skipPropertyDb:true}) 로 읽으니 아예 받지 않는다.
      !/objects_.*\.json\.gz$/i.test(a.URI),
  );
  const skipped = (svfManifest.assets || []).length - assets.length - 1; /* svf 자기 자신 */
  console.log(
    `[convert4d] 에셋 ${assets.length}개 병렬 다운로드…${skipped > 0 ? ` (속성DB ${skipped}개 제외)` : ''}`,
  );
  let done = 0;
  // 원격 derivative URN 은 '..' 를 해석하지 못한다(APS 404). RVT 등은 공유 '속성 DB'
  // (objects_*.json.gz)를 상위 폴더(../../)로 참조하므로, 다운로드용 URN 에서만 '..' 를
  // 미리 정규화한다. 로컬 저장 경로(path.join)는 그대로 두면 svf-utils 가 SVF 기준으로
  // 같은 위치에서 되찾는다(양쪽 경로 일치).
  const normUrn = (p) => {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '..') out.pop();
      else if (seg !== '.') out.push(seg);
    }
    return out.join('/');
  };
  const downloadOne = async (asset) => {
    const remote = normUrn(basePath + asset.URI);
    let bytes;
    try {
      bytes = await fetchDerivativeBytes(token, remote);
    } catch (e) {
      if (e?.status === 401) {
        token = await mintApsToken(); // 장시간 다운로드 중 토큰 만료 → 재발급
        bytes = await fetchDerivativeBytes(token, remote);
      } else {
        throw new Error(`에셋 다운로드 실패(${asset.URI}): ${e?.message || e}`);
      }
    }
    const dest = path.join(outDir, asset.URI);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    if (++done % 50 === 0 || done === assets.length) console.log(`[convert4d]   ${done}/${assets.length}`);
  };
  // 동시성 풀(기본 16) — 순차 다운로드 병목 제거.
  const CONCURRENCY = Number(process.env.DL_CONCURRENCY || 16);
  let cursor = 0;
  const worker = async () => {
    while (cursor < assets.length) {
      const a = assets[cursor++];
      await downloadOne(a);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, worker));
  console.log(`[convert4d] 에셋 다운로드 완료 ${done}개`);
  return path.join(outDir, svfName);
}

// 실패 마커(error.json)를 남길 컨텍스트 — 프런트가 실패를 즉시 감지하도록.
let errCtx = null;

async function main() {
  need('APS_CLIENT_ID', APS_CLIENT_ID);
  need('APS_CLIENT_SECRET', APS_CLIENT_SECRET);
  need('R2_ACCOUNT_ID', R2_ACCOUNT_ID);
  need('R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID);
  need('R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY);
  need('R2_BUCKET', R2_BUCKET);
  // URN 을 직접 받으면 Supabase 불필요(앱은 URN 을 넘긴다). PROJECT_ID 로 조회할 때만 필요.
  let urn;
  if (URN_ENV) {
    urn = URN_ENV;
  } else {
    need('SUPABASE_URL', SUPABASE_URL);
    need('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
    let host = '';
    try { host = new URL(SUPABASE_URL).host; } catch {
      throw new Error(`SUPABASE_URL 형식 오류. "https://<프로젝트>.supabase.co" 형태여야 합니다.`);
    }
    console.log(`[convert4d] Supabase host: ${host}`);
    if (!/supabase\.(co|in|net)$/.test(host)) {
      throw new Error(
        `SUPABASE_URL 시크릿에 프로젝트 URL이 아니라 다른 값(키 등)이 들어간 것 같습니다. ` +
          `Supabase 대시보드 → Project Settings → API → "Project URL"(https://xxxx.supabase.co)을 넣으세요. 현재 host=${host}`,
      );
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    urn = await resolveUrn(supabase);
  }
  const keyBase = PROJECT_ID || urn.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  console.log(`[convert4d] URN=${urn.slice(0, 24)}… region=${APS_REGION} bucket=${STORAGE_BUCKET} key=${keyBase}`);
  errCtx = { keyBase };
  // 이전 실패 마커 제거 — 재시도 중엔 '처리중'으로 보이게(실패로 오인 방지).
  await r2Delete(`${keyBase}/error.json`);

  await ensureSvf(urn); // SVF 없으면(SVF2만 있으면) SVF 변환 요청+대기
  const derivatives = await getSvfDerivatives(urn);
  if (derivatives.length === 0) throw new Error('SVF 파생물을 찾지 못했습니다(변환 후에도 없음).');
  console.log(`[convert4d] SVF 파생물 ${derivatives.length}개`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svf2gltf-'));

  // 여러 SVF 가 있으면 첫 번째(주) 것을 변환. 보통 1개.
  const derivative = derivatives[0];
  const t0 = Date.now();
  console.log(`[convert4d] SVF 다운로드 중 (guid=${derivative.guid})…`);
  const svfPath = await downloadSvfToDisk(derivative, path.join(tmp, 'svf'));
  console.log(`[convert4d] SVF 읽는 중 (${svfPath})…`);
  const reader = await SVFReader.FromFileSystem(svfPath);
  // skipPropertyDb: 속성 DB(dbId→속성)는 지오메트리 변환에 불필요 — 안 읽어 404/ENOENT 회피.
  const scene = await reader.read({ skipPropertyDb: true, log: () => process.stdout.write('.') });
  process.stdout.write('\n');

  // === XKT 파이프라인(비-DWG 메시 모델): 감량 없이 재질그룹별 GLB → convert2xkt → 분할 XKT →
  // 매니페스트. 뷰어(XKTLoaderPlugin)가 여러 XKT 를 한 씬에 스트리밍 로드(xeokit-bim-viewer 방식).
  // 통짜 GLB(4GB 한계)·감량(shard/과감량)을 모두 회피. DWG(선형)는 기존 GLB 경로 유지. ===
  const useXkt = process.env.XKT !== '0' && process.env.INCLUDE_LINES !== '1';
  if (useXkt) {
    process.env.DECIMATE = '0'; // XKT 는 원본 정밀도 보존(감량 없음)
    fs.mkdirSync('out/xkt', { recursive: true });
    const mod = await import('@xeokit/xeokit-convert');
    const convert2xkt = mod.convert2xkt || mod.default?.convert2xkt || mod.default;
    if (typeof convert2xkt !== 'function') throw new Error('convert2xkt 로드 실패(@xeokit/xeokit-convert)');
    // 스트리밍: mergeGlb 가 청크 GLB 를 하나 만들 때마다 여기서 XKT 로 굽고 R2 업로드 후 즉시 삭제
    // → 디스크·메모리 모두 한 청크로 상한(대용량 OOM/디스크풀 원천 차단).
    const xktFiles = [];
    let lodFile = null;
    const onChunk = async (glbPath, idx, tris, isLod1 = false) => {
      const xktPath = glbPath.replace(/\.glb$/, '.xkt');
      const name = path.basename(xktPath);
      try {
        await convert2xkt({ source: glbPath, output: xktPath, log: () => {} });
        await r2Put(`${keyBase}/xkt/${name}`, fs.readFileSync(xktPath), 'application/octet-stream');
        if (isLod1) { lodFile = name; console.log(`[convert4d]   LOD1 → ${name} (${(tris / 1e6).toFixed(1)}M삼각형) 업로드`); }
        else { xktFiles.push(name); console.log(`[convert4d]   청크 ${idx} → ${name} (${(tris / 1e6).toFixed(1)}M삼각형) 업로드`); }
      } catch (e) {
        console.warn(`[convert4d]   ${isLod1 ? 'LOD1' : '청크 ' + idx} XKT 실패: ${e?.message || e}`);
      } finally {
        fs.rmSync(glbPath, { force: true });
        fs.rmSync(xktPath, { force: true });
      }
    };
    console.log('[convert4d] XKT 스트리밍 변환 시작(감량 없음)…');
    const res = await buildMergedGlb(scene, { xktStreamDir: 'out/xkt', onChunk, log: console.log });
    if (xktFiles.length === 0) throw new Error('XKT 청크 0개 — 변환할 지오메트리 없음');
    // 매니페스트: 풀디테일 청크(xktFiles) + 개요(lod1). 뷰어가 줌아웃 시 lod1 만, 줌인 시 청크.
    await r2Put(`${keyBase}/xkt/manifest.json`, Buffer.from(JSON.stringify({ xktFiles, lod1: lodFile })), 'application/json');
    if (res.focus) await r2Put(`${keyBase}/focus.json`, Buffer.from(JSON.stringify(res.focus)), 'application/json');
    else await r2Delete(`${keyBase}/focus.json`);
    await r2Delete(`${keyBase}/model.glb`); // 구 GLB 캐시 제거(프런트가 XKT 우선)
    await r2Delete(`${keyBase}/error.json`);
    console.log(`[convert4d] XKT 업로드 완료: ${xktFiles.length} 청크 · 정점 ${res.vertices.toLocaleString()} · 삼각형 ${Math.round(res.triangles).toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log('[convert4d] DONE');
    return;
  }

  // 재질별 병합 + 정점당 dbId → 단일 GLB(거대 모델의 glTF JSON 한계 회피).
  fs.mkdirSync('out', { recursive: true });
  const outPath = path.join('out', 'model.glb');
  console.log(`[convert4d] 병합 GLB 생성 중…`);
  const res = await buildMergedGlb(scene, { outPath, log: console.log });
  console.log(
    `[convert4d] GLB 완료: ${(res.bytes / 1048576).toFixed(1)} MB · 메시 ${res.groups} · 정점 ${res.vertices.toLocaleString()} · 단순화 ${res.decimated} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  // Draco 압축 — Supabase 무료 스토리지 상한(50MB) 아래로 낮추고 로드도 빠르게.
  // (xeokit 는 KHR_draco_mesh_compression 디코드 지원. meshopt 는 xeokit 가 요구하는
  //  KHR_mesh_quantization 미지원이라 부적합 → Draco 사용.) 위치 14bit 로 형상 보존.
  const rawBytes = res.bytes;
  // Draco 는 삼각형/점 전용 — 선(line) 프리미티브를 제대로 못 다뤄 대형 선형이 깨지거나
  // 드롭된다(DWG 지형 삼각망 50만 선분이 안 보이던 원인). DWG(선 포함)는 Draco 를 건너뛴다.
  // R2 는 파일 크기 제한이 없어 비압축(수십 MB)도 문제없다.
  const skipDraco = process.env.INCLUDE_LINES === '1';
  if (skipDraco) {
    console.log(`[convert4d] Draco 건너뜀(DWG 선형 보존) — 비압축 ${(rawBytes / 1048576).toFixed(1)}MB 업로드`);
  } else {
    // Draco 는 삼각형만 압축 — best-effort(실패 시 원본 사용).
    try {
      console.log(`[convert4d] Draco 압축 중…`);
      const compressed = await gltfPipeline.processGlb(fs.readFileSync(outPath), {
        dracoOptions: {
          compressionLevel: 7,
          quantizePositionBits: 16,
          quantizeNormalBits: 10,
          quantizeTexcoordBits: 12,
          quantizeGenericBits: 16, // _DBID 최대한 보존
          unifiedQuantization: true, // 병합 모델(실좌표) 정합
        },
      });
      fs.writeFileSync(outPath, compressed.glb);
      const cBytes = fs.statSync(outPath).size;
      console.log(
        `[convert4d] 압축 완료: ${(rawBytes / 1048576).toFixed(1)}MB → ${(cBytes / 1048576).toFixed(1)}MB`,
      );
    } catch (e) {
      console.warn(`[convert4d] Draco 압축 건너뜀(${e?.message || e}) — 원본 GLB 사용`);
    }
  }

  // Cloudflare R2 업로드(파일당 50MB 제한 없음). 실패는 치명적으로 처리(main().catch
  // 에서 error.json 마커 → 프런트가 무한 폴링 대신 즉시 실패 표시).
  const objectPath = `${keyBase}/model.glb`;
  const fileBuf = fs.readFileSync(outPath);
  await r2Put(objectPath, fileBuf, 'model/gltf-binary');
  // 카메라 초점(이상치 제외 focus 박스) — 프런트가 flyTo 대상으로 사용(콩알 렌더 방지).
  if (res.focus) {
    await r2Put(`${keyBase}/focus.json`, Buffer.from(JSON.stringify(res.focus)), 'application/json');
    try { fs.writeFileSync('out/focus.json', JSON.stringify(res.focus)); } catch { /* 진단용, 무시 */ }
  } else {
    await r2Delete(`${keyBase}/focus.json`);
  }
  await r2Delete(`${keyBase}/error.json`);
  console.log(
    `[convert4d] 업로드 완료(R2): ${R2_BUCKET}/${objectPath} (${(fileBuf.length / 1048576).toFixed(1)}MB)`,
  );
  console.log(`[convert4d] DONE`);
}

main().catch(async (e) => {
  console.error('[convert4d] 실패:', e?.stack || e?.message || e);
  // 실패 마커를 R2 에 남겨 프런트가 즉시 감지하게 한다(무한 폴링 방지).
  if (errCtx) {
    await r2Put(
      `${errCtx.keyBase}/error.json`,
      Buffer.from(JSON.stringify({ error: String(e?.message || e).slice(0, 300), at: new Date().toISOString() })),
      'application/json',
    ).catch(() => {});
  }
  process.exit(1);
});
