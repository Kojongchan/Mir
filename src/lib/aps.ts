// =====================================================================
// MIR_VDC — APS/ACC 프론트엔드 공유 헬퍼 (S47).
//
// S46 의 ACC 조회(/api/aps-acc, /api/aps-file)와 S47 의 ACC 업로드
// (/api/aps-upload)를 한곳에서 호출한다. 토큰은 서버(2-legged)가 처리하므로
// 외부 사용자는 오토데스크 계정이 필요 없다.
// =====================================================================
import { supabase } from './supabase';

export type AccNamed = { id: string; name: string };
export type AccItem = { id: string; name: string; urn: string | null; lastModified?: string | null };
export type AccVersion = {
  id: string;
  versionNumber: number | null;
  name: string | null;
  lastModified: string | null;
  urn: string | null;
};

// APS Viewer 로 띄울 모델/도면 확장자(나머지 렌더 가능한 건 우리 자체 뷰어).
const MODEL_EXT = new Set([
  'rvt', 'rfa', 'nwd', 'nwc', 'ifc', 'dwg', 'dwf', 'dwfx', 'dgn', 'dxf',
  '3ds', 'fbx', 'obj', 'stp', 'step', 'iges', 'igs', 'sat', 'ipt', 'iam',
  'prt', 'catpart', 'catproduct', 'model', 'sldprt', 'sldasm', 'jt', 'rcp',
  'rcs', 'glb', 'gltf', 'dae', '3dm', 'skp', 'x_t', 'x_b',
]);

/** ACC 파일이 APS Viewer 로 열어야 하는 모델/도면인지(rvt·nwd·ifc·dwg…). */
export function isAccModel(name: string): boolean {
  return MODEL_EXT.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : {};
}

async function sessionToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? '';
}

/** APS Viewer 2-legged 토큰(서버 발급). */
export async function getApsToken(): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch('/api/aps-token', { method: 'POST', headers: await authHeader() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `토큰 오류(${res.status})`);
  return res.json();
}

/** 4D 자체 뷰어 PoC: 모델 SVF 파생물 규모(개수·용량·뷰어블) 측정. */
export async function apsDerivativeInfo(urn: string, region = 'US'): Promise<any> {
  const res = await fetch(
    `/api/aps-derivative-info?urn=${encodeURIComponent(urn)}&region=${encodeURIComponent(region)}`,
    { headers: await authHeader() },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `규모 측정 실패(${res.status})`);
  return body;
}

/** ACC Data Management 프록시 호출(서버가 2-legged 처리). */
export async function accFetch(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/aps-acc?${qs}`, { headers: await authHeader() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `ACC 오류(${res.status})`);
  return body;
}

/** ACC 원본 파일 바이트 프록시 URL(기준). */
export function accFileBase(project: string, item: string): string {
  return `/api/aps-file?project=${encodeURIComponent(project)}&item=${encodeURIComponent(item)}`;
}

/** 미디어/다운로드용 — 서명 URL로 302 리다이렉트(토큰은 쿼리). */
export async function accFileRedirectUrl(project: string, item: string): Promise<string> {
  const tok = await sessionToken();
  return `${accFileBase(project, item)}&mode=redirect&token=${encodeURIComponent(tok)}`;
}

/** 문서(pdf/이미지/엑셀/워드/텍스트) — 바이트를 blob 으로(CORS 회피). 호출측이 revoke. */
export async function accFileBlobUrl(project: string, item: string): Promise<string> {
  const res = await fetch(accFileBase(project, item), { headers: await authHeader() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `열기 실패(${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * 외부 렌더러(예: Office Online)가 직접 가져갈 수 있는 'Autodesk 단기 서명 URL'.
 * 우리 세션 토큰은 헤더로만 보내고 노출되지 않는다. pptx 등 자체 렌더가 어려운
 * 포맷을 Office Online 임베드로 띄울 때 사용.
 */
/**
 * 외부 렌더러(Office Online)용 공개 서명 URL. Autodesk 단기 서명 URL(공개)이라
 * Microsoft 서버가 직접 가져갈 수 있고, name 을 주면 response-content-disposition
 * 으로 실제 파일명이 URL에 구워져 Office 가 이름을 올바로 표시한다. 우리 세션
 * 토큰은 헤더로만 보내고 노출되지 않는다.
 */
export async function accFileSignedUrl(project: string, item: string, name?: string): Promise<string> {
  const q = name ? `&name=${encodeURIComponent(name)}` : '';
  const res = await fetch(`${accFileBase(project, item)}&mode=signed${q}`, { headers: await authHeader() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error ?? `서명 URL 실패(${res.status})`);
  return body.url as string;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** ACC 원본 파일을 디스크로 저장(다운로드 — 실무자 이상 UI 에서만 호출). */
export async function downloadAccItem(project: string, item: string, fileName: string): Promise<void> {
  const res = await fetch(accFileBase(project, item), { headers: await authHeader() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `다운로드 실패(${res.status})`);
  saveBlob(await res.blob(), fileName);
}

/**
 * 진행률(0~1)을 보고하며 다운로드한다. Content-Length 가 없으면 fraction=null(불확정).
 * 응답 바디를 스트림으로 읽어 loaded/total 을 계산한다.
 */
export async function downloadAccItemProgress(
  project: string,
  item: string,
  fileName: string,
  onProgress?: (fraction: number | null) => void,
): Promise<void> {
  const res = await fetch(accFileBase(project, item), { headers: await authHeader() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `다운로드 실패(${res.status})`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || !total) {
    onProgress?.(null); // 길이/스트림 없음 → 불확정
    saveBlob(await res.blob(), fileName);
    onProgress?.(1);
    return;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  onProgress?.(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress?.(Math.min(1, loaded / total));
    }
  }
  saveBlob(new Blob(chunks), fileName);
  onProgress?.(1);
}

/** ACC 아이템의 버전 이력. */
export async function accItemVersions(project: string, item: string): Promise<AccVersion[]> {
  const { versions } = await accFetch({ action: 'versions', project, item });
  return (versions ?? []) as AccVersion[];
}

async function apsItem(action: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/aps-item', {
    method: 'POST',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `작업 오류(${res.status})`);
  return body;
}

/** ACC 아이템 이름 변경(실무자 이상). */
export function renameAccItem(project: string, item: string, name: string, mirProject: string): Promise<any> {
  return apsItem('rename', { project, item, name, mirProject });
}

/** ACC 아이템 삭제(휴지통 — 실무자 이상). */
export function deleteAccItem(project: string, item: string, mirProject: string): Promise<any> {
  return apsItem('delete', { project, item, mirProject });
}

/** ACC 아이템을 다른 폴더로 이동(실무자 이상 · ACC 환경에 따라 미지원일 수 있음). */
export function moveAccItem(project: string, item: string, folder: string, mirProject: string): Promise<any> {
  return apsItem('move', { project, item, folder, mirProject });
}

export type ProgressFn = (fraction: number) => void;

export interface AccUploadResult {
  itemUrn: string;
  versionUrn: string | null;
  /** 뷰어용 base64 URN(변환 완료 후 모델로 열 때). */
  urn: string | null;
}

interface BeginResult {
  uploadKey: string;
  signedUrl: string;
  bucket: string;
  object: string;
  storageUrn: string;
}

async function apsUpload(action: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/aps-upload', {
    method: 'POST',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `업로드 오류(${res.status})`);
  return body;
}

/** S3 서명 URL로 파일 바이트를 직접 PUT(진행률 보고). 바이트는 우리 서버를 거치지 않음. */
function putToS3(signedUrl: string, file: File, onProgress?: ProgressFn): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`ACC 업로드 실패 (${xhr.status})`));
    xhr.onerror = () => reject(new Error('ACC 업로드 네트워크 오류(CORS/권한 확인).'));
    xhr.send(file);
  });
}

/**
 * 파일을 ACC 폴더에 업로드한다(신규) 또는 기존 아이템의 새 버전으로 올린다(itemId).
 *   begin(스토리지·서명URL) → S3 직접 PUT(진행률) → complete(item/version 생성).
 */
export async function uploadToAcc(
  project: string,
  folder: string,
  file: File,
  opts?: { itemId?: string; fileName?: string; onProgress?: ProgressFn; mirProject?: string },
): Promise<AccUploadResult> {
  const mirProject = opts?.mirProject;
  // 새 버전(itemId)일 때는 원본 아이템 이름을 유지해 파일 정체성을 보존한다.
  const fileName = opts?.fileName ?? file.name;
  const begin = (await apsUpload('begin', {
    project,
    folder,
    fileName,
    mirProject,
  })) as BeginResult;

  await putToS3(begin.signedUrl, file, opts?.onProgress);
  if (opts?.onProgress) opts.onProgress(1);

  return (await apsUpload('complete', {
    project,
    folder,
    fileName,
    mirProject,
    bucket: begin.bucket,
    object: begin.object,
    uploadKey: begin.uploadKey,
    storageUrn: begin.storageUrn,
    itemId: opts?.itemId,
  })) as AccUploadResult;
}
