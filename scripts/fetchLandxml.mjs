// 원본 LandXML 다운로드 — Civil3D 가 내보낸 지표면(TIN) LandXML 을 ACC(자료관리)에서 그대로
// 받는다. fetchDwg.mjs 와 동일 흐름(2-legged data:read → item tip → signeds3download).
// LibreDWG DXF 가 못 가져오는 '진짜 지표면 삼각망'의 소스. dxfToGlb 가 DXF_LANDXML 로 읽어 병합.
// env: APS_CLIENT_ID, APS_CLIENT_SECRET, LANDXML_PROJECT, LANDXML_ITEM
import fs from 'node:fs';

const APS = 'https://developer.api.autodesk.com';
const id = process.env.APS_CLIENT_ID, secret = process.env.APS_CLIENT_SECRET;
const project = process.env.LANDXML_PROJECT, item = process.env.LANDXML_ITEM;
if (!id || !secret) throw new Error('APS_CLIENT_ID/SECRET 필요');
if (!project || !item) { console.log('[landxml] LANDXML_PROJECT/ITEM 없음 — 건너뜀'); process.exit(0); }

const basic = Buffer.from(`${id}:${secret}`).toString('base64');
const tokRes = await fetch(`${APS}/authentication/v2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
});
const tok = await tokRes.json();
if (!tokRes.ok) throw new Error('token 실패: ' + JSON.stringify(tok));
const auth = { authorization: `Bearer ${tok.access_token}` };

const tipRes = await fetch(`${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/tip`, { headers: auth });
const tip = await tipRes.json();
if (!tipRes.ok) throw new Error('tip 실패: ' + JSON.stringify(tip?.errors ?? tip));
const storageUrn = tip?.data?.relationships?.storage?.data?.id;
const name = tip?.data?.attributes?.name ?? 'surface.xml';
console.log('[landxml] tip name=', name, '| storage=', storageUrn);
const m = storageUrn?.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
if (!m) throw new Error('스토리지 urn 형식 오류: ' + storageUrn);
const bucket = m[1], object = m[2];

const signRes = await fetch(`${APS}/oss/v2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(object)}/signeds3download`, { headers: auth });
const sign = await signRes.json();
if (!signRes.ok) throw new Error('서명URL 실패: ' + JSON.stringify(sign));
const dl = sign?.url ?? sign?.urls?.[0];
if (!dl) throw new Error('다운로드 URL 없음: ' + JSON.stringify(sign));

const fileRes = await fetch(dl);
if (!fileRes.ok) throw new Error('LandXML 다운로드 실패 HTTP ' + fileRes.status);
const buf = Buffer.from(await fileRes.arrayBuffer());
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/surface.xml', buf);
console.log(`[landxml] 저장 out/surface.xml · ${buf.length.toLocaleString()} bytes`);
