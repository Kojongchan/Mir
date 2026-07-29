// 원본 DWG 다운로드 — ACC(자료관리)는 저장소일 뿐이므로 원본 파일을 그대로 받는다.
// api/aps-file.ts 와 동일 흐름: 2-legged 토큰(data:read) → item tip → 스토리지 오브젝트
// → signeds3download 서명 URL → 바이트 다운로드. SVF 를 안 거치는 자체 변환의 1단계.
// env: APS_CLIENT_ID, APS_CLIENT_SECRET, PROJECT, ITEM
import fs from 'node:fs';

const APS = 'https://developer.api.autodesk.com';
const id = process.env.APS_CLIENT_ID, secret = process.env.APS_CLIENT_SECRET;
const project = process.env.PROJECT, item = process.env.ITEM;
if (!id || !secret) throw new Error('APS_CLIENT_ID/SECRET 필요');
if (!project || !item) throw new Error('PROJECT/ITEM 필요');

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
const name = tip?.data?.attributes?.name ?? 'file.dwg';
console.log('[dwg] tip name=', name, '| storage=', storageUrn);
const m = storageUrn?.match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
if (!m) throw new Error('스토리지 urn 형식 오류: ' + storageUrn);
const bucket = m[1], object = m[2];

const signRes = await fetch(`${APS}/oss/v2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(object)}/signeds3download`, { headers: auth });
const sign = await signRes.json();
if (!signRes.ok) throw new Error('서명URL 실패: ' + JSON.stringify(sign));
const dl = sign?.url ?? sign?.urls?.[0];
if (!dl) throw new Error('다운로드 URL 없음: ' + JSON.stringify(sign));

const fileRes = await fetch(dl);
if (!fileRes.ok) throw new Error('DWG 다운로드 실패 HTTP ' + fileRes.status);
const buf = Buffer.from(await fileRes.arrayBuffer());
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/original.dwg', buf);
// DWG 버전은 헤더 첫 6바이트(예: 'AC1032'=2018, 'AC1027'=2013). 무료 파서 지원 범위 판단용.
const ver = buf.slice(0, 6).toString('ascii');
console.log(`[dwg] 저장 out/original.dwg · ${buf.length.toLocaleString()} bytes · 버전헤더=${ver}`);
