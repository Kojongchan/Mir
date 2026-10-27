// =====================================================================
// MIR — AI 연결(MCP)이 자료관리(ACC)를 읽는 부분: 파일 바이트(읽기 전용 2-legged), PDF 쪽 글·책갈피·쪽 그림, 모델 객체.
// 같은 함수 인스턴스가 이어서 불리면(Fluid) 받은 파일을 잠시 기억해 같은 PDF 를 다시 받지 않는다. 큰 PDF(도면)는 범위 요청.
// 쪽 그림은 @napi-rs/canvas(pdfjs 의 Node 캔버스) — 여기서 직접 불러 배포 묶음에 네이티브 모듈이 따라가게 한다(그림 도구 안에서만
// 불러, 네이티브 모듈이 실패해도 다른 도구는 산다).
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
/** 이보다 큰 PDF 는 통째로 받지 않고 필요한 부분만 범위 요청으로 읽는다(도면 한 권이 120~340MB). 그보다 작은 문서는 예전처럼 통째로(전 쪽 검색이 빠름). */
const RANGE_OVER = 120e6;

const links = new Map<string, { url: string; size: number; at: number }>();
const LINK_MS = 30 * 60_000;

/** ACC 항목 최신 버전의 서명된 다운로드 주소와 크기(60분 유효 — 30분만 기억). */
async function accLink(project: string, item: string): Promise<{ url: string; size: number }> {
  const key = `${project}|${item}`;
  const hit = links.get(key);
  if (hit && Date.now() - hit.at < LINK_MS) return hit;
  const auth = { authorization: `Bearer ${await apsToken()}` };
  const tipRes = await fetch(`${APS}/data/v1/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/tip`, { headers: auth });
  const tip = await tipRes.json() as any;
  if (!tipRes.ok) throw new Error(tip?.errors?.[0]?.detail ?? `자료관리 항목을 읽지 못했습니다(${tipRes.status})`);
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(tip?.data?.relationships?.storage?.data?.id ?? '');
  if (!m) throw new Error('파일 저장 위치를 찾지 못했습니다');
  const signRes = await fetch(`${APS}/oss/v2/buckets/${encodeURIComponent(m[1])}/objects/${encodeURIComponent(m[2])}/signeds3download?minutesExpiration=60`, { headers: auth });
  const sign = await signRes.json() as any;
  const url: string | undefined = sign?.url ?? sign?.urls?.[0];
  if (!signRes.ok || !url) throw new Error('다운로드 주소를 받지 못했습니다');
  const link = { url, size: Number(sign?.size ?? tip?.data?.attributes?.storageSize ?? 0), at: Date.now() };
  links.set(key, link);
  return link;
}

/** ACC 항목의 최신 버전 바이트. */
export async function accFileBytes(project: string, item: string): Promise<Uint8Array> {
  const key = `${project}|${item}`;
  const hit = files.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  const { url } = await accLink(project, item);
  const fileRes = await fetch(url);
  if (!fileRes.ok) { links.delete(key); throw new Error(`파일 받기 실패(${fileRes.status})`); }
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  files.set(key, { bytes, at: Date.now() });
  let total = 0;
  for (const [k, v] of [...files].reverse()) { total += v.bytes.length; if (total > CACHE_BYTES && k !== key) files.delete(k); }
  return bytes;
}

async function pdfjsLib() {
  // Node 에는 Worker 가 없어 pdfjs 가 같은 스레드의 '가짜 워커'를 쓴다 — 워커 모듈을 직접 불러 넣어 두면
  // 경로 추측 없이 쓰고, 배포 묶음(nft)에도 워커 파일이 따라간다.
  const g = globalThis as { pdfjsWorker?: unknown };
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

type PdfDoc = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjsLib>>['getDocument']>['promise']>;

/**
 * PDF 열기: 작으면(또는 이미 받았으면) 통째로, 크면 범위 요청(필요한 쪽의 바이트만). 실측 — 461쪽 240MB 도면 한 권을
 * 여는 데 1MB, 도면 한 장에 1~3MB.
 */
async function openPdf(project: string, item: string): Promise<PdfDoc> {
  const pdfjs = await pdfjsLib();
  const common = { isEvalSupported: false, disableFontFace: true, useSystemFonts: false };
  const link = await accLink(project, item);
  if (files.has(`${project}|${item}`) || !link.size || link.size <= RANGE_OVER) {
    return pdfjs.getDocument({ ...common, data: (await accFileBytes(project, item)).slice() }).promise;
  }
  let failed: Error | null = null;
  class Ranges extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetch(link.url, { headers: { range: `bytes=${begin}-${end - 1}` } });
            if (r.status !== 206 && r.status !== 200) throw new Error(`범위 읽기 실패(${r.status})`);
            const b = new Uint8Array(await r.arrayBuffer());
            this.onDataRange(begin, r.status === 200 ? b.subarray(begin, end) : b);
            return;
          } catch (e) { failed = e as Error; }
        }
        links.delete(`${project}|${item}`);
        void task.destroy(); // 기다리던 쪽 읽기를 끝낸다(오류로)
      })();
    }
  }
  const task = pdfjs.getDocument({ ...common, range: new Ranges(link.size, null), length: link.size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1 << 18 });
  try {
    return await task.promise;
  } catch (e) {
    throw failed ?? e;
  }
}

/**
 * PDF 쪽 글(텍스트 층). pages('9-38, 45')가 있으면 그 쪽만, search(정규식)가 있으면 그 글이 든 쪽만, 최대 maxPages 쪽·maxChars 글자.
 * 넘치면 truncated 와 다음에 읽을 쪽 번호를 준다. 글이 없는 쪽(선으로 그린 도면·스캔)은 noText 로 센다.
 */
export async function pdfText(project: string, item: string, opts: { pages?: string; search?: RegExp; maxPages: number; maxChars: number }) {
  const doc = await openPdf(project, item);
  try {
    const wanted = parsePageRange(opts.pages ?? '', doc.numPages) ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const out: PageText[] = [];
    let chars = 0, noText = 0;
    let next: number | null = null;
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = pageLines(tc.items as { str: string; transform: number[] }[]).replace(/[ \t]{3,}/g, '  ');
      if (!text.trim()) noText++;
      if (opts.search && !opts.search.test(text)) continue;
      if (out.length >= opts.maxPages || chars + text.length > opts.maxChars) { next = n; break; }
      out.push({ page: n, text });
      chars += text.length;
    }
    return { totalPages: doc.numPages, pages: out, truncated: next != null, nextPage: next, noText };
  } finally {
    await doc.destroy();
  }
}

/**
 * PDF 쪽 글을 위치와 함께(표 읽기): 쪽마다 글 조각 [x, y, 너비, 글](pt, 왼쪽 아래 원점). 빈 칸이 있는 집계표에서 숫자가 어느 열인지
 * 정하려면 위치가 필요하다(lib/sim45d/qtyTable.ts).
 */
export async function pdfCells(project: string, item: string, pages: number[]) {
  const doc = await openPdf(project, item);
  try {
    const out: { page: number; width: number; cells: [number, number, number, string][] }[] = [];
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const r1 = (v: number) => Math.round(v * 10) / 10;
      const cells = (tc.items as { str: string; transform: number[]; width: number }[])
        .filter(it => it.str.trim())
        .map(it => [r1(it.transform[4]), r1(it.transform[5]), r1(it.width), it.str] as [number, number, number, string]);
      out.push({ page: n, width: r1(page.view[2] - page.view[0]), cells });
    }
    return { totalPages: doc.numPages, pages: out };
  } finally {
    await doc.destroy();
  }
}

/** PDF 책갈피(목차)와 쪽 번호 — 도면 묶음은 권·분야·도면 이름이 책갈피로 들어 있는 경우가 많다. */
export async function pdfOutline(project: string, item: string) {
  const doc = await openPdf(project, item);
  try {
    const outline: { title: string; page: number | null; depth: number }[] = [];
    const walk = async (items: { title: string; dest: unknown; items: unknown[] }[] | null, depth: number) => {
      for (const it of items ?? []) {
        if (outline.length >= 800) return;
        let page: number | null = null;
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest as unknown[] | null;
          if (dest?.[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1;
        } catch { /* 쪽 없는 책갈피 */ }
        if (it.title.trim()) outline.push({ title: it.title.trim(), page, depth });
        await walk(it.items as never, depth + 1);
      }
    };
    await walk(await doc.getOutline() as never, 0);
    return { totalPages: doc.numPages, outline };
  } finally {
    await doc.destroy();
  }
}

/**
 * PDF 쪽을 그림(PNG)으로 — 글자가 선으로 그려진 도면은 텍스트로 못 읽으므로 AI 가 그림으로 본다.
 * region(쪽 비율 x,y,w,h)을 주면 그 부분만 확대해서(그 부분 크기의 캔버스만 만든다). 합계가 maxBytes 를 넘는 쪽은 skipped.
 */
export async function pdfImages(project: string, item: string, opts: { pages: number[]; region?: [number, number, number, number]; width: number; maxBytes: number }) {
  let createCanvas: typeof import('@napi-rs/canvas').createCanvas;
  try {
    ({ createCanvas } = await import('@napi-rs/canvas'));
  } catch (e) {
    throw new Error(`도면 그림을 만들 수 없습니다(서버 캔버스 모듈): ${(e as Error).message}`, { cause: e });
  }
  const doc = await openPdf(project, item);
  try {
    const [rx, ry, rw, rh] = opts.region ?? [0, 0, 1, 1];
    const images: { page: number; png: Uint8Array; width: number; height: number; text: string }[] = [];
    const skipped: number[] = [];
    let total = 0;
    for (const n of opts.pages) {
      if (n < 1 || n > doc.numPages) { skipped.push(n); continue; }
      if (total >= opts.maxBytes) { skipped.push(n); continue; }
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(8, opts.width / (base.width * rw));
      const full = page.getViewport({ scale });
      const width = Math.max(1, Math.round(full.width * rw)), height = Math.max(1, Math.round(full.height * rh));
      const viewport = page.getViewport({ scale, offsetX: -full.width * rx, offsetY: -full.height * ry });
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx as never, viewport }).promise;
      const png = new Uint8Array(await canvas.encode('png'));
      const text = pageLines((await page.getTextContent()).items as { str: string; transform: number[] }[]).trim().slice(0, 1500);
      page.cleanup();
      if (images.length && total + png.length > opts.maxBytes) { skipped.push(n); continue; }
      images.push({ page: n, png, width, height, text });
      total += png.length;
    }
    return { totalPages: doc.numPages, images, skipped };
  } finally {
    await doc.destroy();
  }
}

/** 모델 객체 요약(6단계와 같은 규칙). */
export async function modelObjects(urn: string) {
  return readModelObjects(urn, await apsToken());
}
