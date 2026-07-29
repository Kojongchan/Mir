// 자체 DWG 파이프라인 결과 업로드 — DWG→DXF→GLB(dxfToGlb) 산출물을 Cloudflare R2 에
// 올려 앱(신규 3D뷰)이 SVF 대신 이걸 로드하게 한다. 캐시 키 규약은 SVF 경로(convert4d.mjs)
// · 게이트웨이(api/aps-convert.ts)와 **반드시 동일**: urn → 영숫자만 남겨 앞 40자.
//   저장 경로: R2  <bucket>/<urn40>/model.glb (+ focus.json). 실패 시 error.json 마커.
// env: URN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
import fs from 'node:fs';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const { URN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!URN) throw new Error('URN 필요');
for (const [k, v] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET }))
  if (!v) throw new Error(`환경변수 누락: ${k}`);

const keyBase = URN.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});
const put = (key, body, ct) => s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: ct }));
const del = (key) => s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {});

const glbPath = 'out/model.glb';
if (!fs.existsSync(glbPath) || fs.statSync(glbPath).size < 100) {
  // 변환 산출물이 없다 → 프런트가 무한 폴링하지 않도록 실패 마커를 남긴다.
  const msg = process.env.DXF_ERROR || 'DWG→DXF→GLB 변환 산출물이 생성되지 않았습니다.';
  await put(`${keyBase}/error.json`, Buffer.from(JSON.stringify({ error: String(msg).slice(0, 300), at: new Date().toISOString() })), 'application/json');
  console.log(`[uploadDxf] 산출물 없음 → error.json 기록 (key=${keyBase})`);
  process.exit(0);
}

const glb = fs.readFileSync(glbPath);
await put(`${keyBase}/model.glb`, glb, 'model/gltf-binary');
if (fs.existsSync('out/focus.json')) {
  await put(`${keyBase}/focus.json`, fs.readFileSync('out/focus.json'), 'application/json');
} else {
  await del(`${keyBase}/focus.json`);
}
await del(`${keyBase}/error.json`);
console.log(`[uploadDxf] 업로드 완료 R2 ${R2_BUCKET}/${keyBase}/model.glb (${(glb.length / 1048576).toFixed(1)}MB)`);
