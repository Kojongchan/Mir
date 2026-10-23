// =====================================================================
// MIR — AI 연결(MCP)이 자료관리(ACC)를 읽는 부분: 파일 바이트(읽기 전용 2-legged), PDF 쪽 글, 모델 객체.
// 같은 함수 인스턴스가 이어서 불리면(Fluid) 받은 파일을 잠시 기억해 같은 PDF 를 다시 받지 않는다.
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET.
// =====================================================================
import { parsePageRange, pageLines, type PageText } from '../src/lib/sim45d/pages.js';
import { readModelObjects } from './aps-props.js';

const APS = 'https://developer.api.autodesk.com';

let token: { value: string; until: number } | null = null;

async function apsToken(): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return token.value;
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${process.env.APS_CLIENT_ID}:${process.env.APS_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
  });
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !d.access_token) throw new Error('APS 토큰 발급 실패');
  token = { value: d.access_token, until: Date.now() + (d.expires_in ?? 3000) * 1000 };
  return token.value;
}

const files = new Map<string, { bytes: Uint8Array; at: number }>();
const CACHE_MS = 10 * 60_000;
const CACHE_BYTES = 300e6;

/** ACC 항목의 최신 버전 바이트. */
export async function accFileBytes(project: string, item: string): Promise<Uint8Array> {
  const key = `${project}|${item}`;
  const hit = files.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  const auth = { authorization: `Bearer ${await apsToken()}` };
  const tipRes = await fetch(`${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/tip`, { headers: auth });
  const tip = await tipRes.json() as any;
  if (!tipRes.ok) throw new Error(tip?.errors?.[0]?.detail ?? `자료관리 항목을 읽지 못했습니다(${tipRes.status})`);
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(tip?.data?.relationships?.storage?.data?.id ?? '');
  if (!m) throw new Error('파일 저장 위치를 찾지 못했습니다');
  const signRes = await fetch(`${APS}/oss/v2/buckets/${encodeURIComponent(m[1])}/objects/${encodeURIComponent(m[2])}/signeds3download`, { headers: auth });
  const sign = await signRes.json() as any;
  const url: string | undefined = sign?.url ?? sign?.urls?.[0];
  if (!signRes.ok || !url) throw new Error('다운로드 주소를 받지 못했습니다');
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`파일 받기 실패(${fileRes.status})`);
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  files.set(key, { bytes, at: Date.now() });
  let total = 0;
  for (const [k, v] of [...files].reverse()) { total += v.bytes.length; if (total > CACHE_BYTES && k !== key) files.delete(k); }
  return bytes;
}

/**
 * PDF 쪽 글(텍스트 층). pages('9-38, 45')가 있으면 그 쪽만, search(정규식)가 있으면 그 글이 든 쪽만, 최대 maxPages 쪽·maxChars 글자.
 * 넘치면 truncated 와 다음에 읽을 쪽 번호를 준다.
 */
export async function pdfText(bytes: Uint8Array, opts: { pages?: string; search?: RegExp; maxPages: number; maxChars: number }) {
  // Node 에는 Worker 가 없어 pdfjs 가 같은 스레드의 '가짜 워커'를 쓴다 — 워커 모듈을 직접 불러 넣어 두면
  // 경로 추측 없이 쓰고, 배포 묶음(nft)에도 워커 파일이 따라간다.
  const g = globalThis as { pdfjsWorker?: unknown };
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const wanted = parsePageRange(opts.pages ?? '', doc.numPages) ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const out: PageText[] = [];
    let chars = 0;
    let next: number | null = null;
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = pageLines(tc.items as { str: string; transform: number[] }[]).replace(/[ \t]{3,}/g, '  ');
      if (opts.search && !opts.search.test(text)) continue;
      if (out.length >= opts.maxPages || chars + text.length > opts.maxChars) { next = n; break; }
      out.push({ page: n, text });
      chars += text.length;
    }
    return { totalPages: doc.numPages, pages: out, truncated: next != null, nextPage: next };
  } finally {
    await doc.destroy();
  }
}

/** 모델 객체 요약(6단계와 같은 규칙). */
export async function modelObjects(urn: string) {
  return readModelObjects(urn, await apsToken());
}
