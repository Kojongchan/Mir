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
import { SVFReader, GLTFWriter, TwoLeggedAuthenticationProvider } from 'svf-utils';
import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';
import { ModelDerivativeClient } from '@aps_sdk/model-derivative';
import gltfPipeline from 'gltf-pipeline';

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
  const walk = (d) => {
    if (d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') out.push(d);
    d.children?.forEach(walk);
  };
  manifest.derivatives?.forEach((d) => d.children?.forEach(walk));
  return out;
}

// 각 노드 이름에 dbId 를 박아 런타임에서 객체별 통제가 가능하게 한다.
class DbIdGLTFWriter extends GLTFWriter {
  createNode(fragment, imf, outputUvs) {
    const node = super.createNode(fragment, imf, outputUvs);
    if (fragment && typeof fragment.dbid === 'number') node.name = `dbid:${fragment.dbid}`;
    return node;
  }
}

async function main() {
  need('APS_CLIENT_ID', APS_CLIENT_ID);
  need('APS_CLIENT_SECRET', APS_CLIENT_SECRET);
  need('SUPABASE_URL', SUPABASE_URL);
  need('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
  let host = '';
  try {
    host = new URL(SUPABASE_URL).host;
  } catch {
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
  const urn = await resolveUrn(supabase);
  const keyBase = PROJECT_ID || urn.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  console.log(`[convert4d] URN=${urn.slice(0, 24)}… region=${APS_REGION} bucket=${STORAGE_BUCKET} key=${keyBase}`);

  const derivatives = await getSvfDerivatives(urn);
  if (derivatives.length === 0) throw new Error('SVF 파생물을 찾지 못했습니다.');
  console.log(`[convert4d] SVF 파생물 ${derivatives.length}개`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svf2gltf-'));
  const auth = new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);

  // 여러 SVF 가 있으면 가장 큰(=주) 것 하나만 우선 변환(PoC). 보통 1개.
  const derivative = derivatives[0];
  const t0 = Date.now();
  console.log(`[convert4d] SVF 읽는 중 (guid=${derivative.guid})…`);
  // APS 파생물 다운로드는 간헐적으로 "no response"(네트워크 일시 오류)가 난다 → 재시도.
  let scene;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const reader = await SVFReader.FromDerivativeService(urn, derivative.guid, auth, APS_REGION);
      scene = await reader.read({ log: () => process.stdout.write('.') });
      process.stdout.write('\n');
      break;
    } catch (e) {
      lastErr = e;
      process.stdout.write('\n');
      console.warn(`[convert4d] 읽기 실패(시도 ${attempt}/4): ${e?.message || e}`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  if (!scene) throw lastErr ?? new Error('SVF 읽기 실패');
  const gltfDir = path.join(tmp, 'gltf');
  const writer = new DbIdGLTFWriter({ deduplicate: false, skipUnusedUvs: true, center: true, log: console.log });
  console.log(`[convert4d] glTF 쓰는 중…`);
  await writer.write(scene, gltfDir);
  console.log(`[convert4d] glTF 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // glTF(폴더) → GLB(단일 바이너리) + Draco 압축.
  const gltfPath = path.join(gltfDir, 'output.gltf');
  if (!fs.existsSync(gltfPath)) {
    const found = fs.readdirSync(gltfDir).find((f) => f.endsWith('.gltf'));
    if (!found) throw new Error(`glTF 산출물을 찾지 못함: ${fs.readdirSync(gltfDir).join(', ')}`);
  }
  const realGltf = fs.existsSync(gltfPath) ? gltfPath : path.join(gltfDir, fs.readdirSync(gltfDir).find((f) => f.endsWith('.gltf')));
  const gltf = JSON.parse(fs.readFileSync(realGltf, 'utf8'));
  console.log(`[convert4d] GLB+Draco 변환 중…`);
  const { glb } = await gltfPipeline.gltfToGlb(gltf, {
    resourceDirectory: gltfDir,
    dracoOptions: { compressionLevel: 7 },
  });
  console.log(`[convert4d] GLB 크기: ${(glb.length / 1048576).toFixed(1)} MB`);

  // 워크플로 아티팩트(백업·검수용)로 디스크에도 저장.
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(path.join('out', 'model.glb'), glb);

  // Supabase Storage 업로드(버킷 없으면 생성).
  await supabase.storage.createBucket(STORAGE_BUCKET, { public: false }).catch(() => {});
  const objectPath = `${keyBase}/model.glb`;
  const up = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, glb, {
    contentType: 'model/gltf-binary',
    upsert: true,
  });
  if (up.error) throw new Error(`업로드 실패: ${up.error.message}`);
  console.log(`[convert4d] 업로드 완료: ${STORAGE_BUCKET}/${objectPath}`);
  console.log(`[convert4d] DONE`);
}

main().catch((e) => {
  console.error('[convert4d] 실패:', e?.stack || e?.message || e);
  process.exit(1);
});
