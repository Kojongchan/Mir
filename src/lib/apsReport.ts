import type { ClashRow } from './clash';
import { CLASH_STATUS_LABEL } from './clash';
import { nodeName, topLevelAncestor } from './apsTree';
import { showApsClash, clearApsClashView } from './apsClashView';

// =====================================================================
// APS 간섭 보고서 — S49 (#4). CSV(요소 대신 **모델=상위 파일명**) + 각 간섭의
// 대표 스냅샷을 담은 **HTML 간섭 보고서**(글+표+사진). 정식 양식이 정해지면 차후 교체.
// 스냅샷은 viewer.getScreenShot 으로 각 간섭을 showApsClash 한 뒤 캡처해 base64 내장.
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

/** 행 한쪽의 상위 파일명(모델). dbId 는 expressID 슬롯에 들어있다. */
function modelNameOf(model: ApsModel, dbId: number): string {
  if (dbId < 0) return '(미해석)';
  return nodeName(model, topLevelAncestor(model, dbId)) || '(모델)';
}

function csvCell(s: string | number | null | undefined): string {
  const v = s == null ? '' : String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** APS 간섭 CSV — 모델 A/B(상위 파일명)·카테고리 A/B(그룹)·부재·위치·깊이·상태. */
export function apsClashesToCsv(rows: ClashRow[], model: ApsModel): string {
  const header = [
    'No', '모델 A', '카테고리 A', '부재 A', '모델 B', '카테고리 B', '부재 B',
    'X', 'Y', 'Z', '관통깊이(m)', '상태',
  ];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        csvCell(modelNameOf(model, r.a.expressID)),
        csvCell(r.a.category),
        csvCell(r.a.name || ''),
        csvCell(modelNameOf(model, r.b.expressID)),
        csvCell(r.b.category),
        csvCell(r.b.name || ''),
        r.point.x.toFixed(3),
        r.point.y.toFixed(3),
        r.point.z.toFixed(3),
        r.depth.toFixed(3),
        CLASH_STATUS_LABEL[r.status],
      ].join(','),
    );
  });
  return lines.join('\n');
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 현재 뷰를 PNG dataURL 로 캡처(blob URL → dataURL 변환 포함). */
function captureScreenshot(viewer: ApsViewer, w: number, h: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      viewer.getScreenShot(
        w,
        h,
        (url: string) => {
          if (!url) return resolve('');
          if (url.startsWith('data:')) return resolve(url);
          fetch(url)
            .then((r) => r.blob())
            .then((b) => {
              const fr = new FileReader();
              fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
              fr.onerror = () => resolve('');
              fr.readAsDataURL(b);
            })
            .catch(() => resolve(''));
        },
      );
    } catch {
      resolve('');
    }
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

export interface ReportOptions {
  projectName?: string;
  setA?: string;
  setB?: string;
  /** 캡처할 최대 간섭 수(과다 캡처 방지). */
  maxShots?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 간섭 보고서 HTML 을 생성한다(각 간섭을 showApsClash 로 비추고 스냅샷 캡처).
 * 반환된 HTML 문자열을 그대로 다운로드하면 사진·표·요약이 든 보고서가 된다.
 */
export async function buildApsClashReport(
  viewer: ApsViewer,
  model: ApsModel,
  rows: ClashRow[],
  opts: ReportOptions = {},
): Promise<string> {
  const max = opts.maxShots ?? 60;
  const shots: Record<string, string> = {};
  const targets = rows.slice(0, max);
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    try {
      showApsClash(viewer, model, r.a.expressID, r.b.expressID);
      await wait(450); // 렌더 안정화
      shots[r.id] = await captureScreenshot(viewer, 720, 460);
    } catch {
      shots[r.id] = '';
    }
    opts.onProgress?.(i + 1, targets.length);
  }
  clearApsClashView(viewer, model);

  const now = new Date().toLocaleString('ko-KR');
  const open = rows.filter((r) => r.status === 'new' || r.status === 'reviewing').length;
  const sections = rows
    .map((r, i) => {
      const img = shots[r.id]
        ? `<img src="${shots[r.id]}" alt="간섭 ${i + 1}" style="max-width:100%;border:1px solid #ccc;border-radius:6px" />`
        : `<div style="color:#888;font-size:12px">(이미지 없음 — ${i < max ? '캡처 실패' : '캡처 생략'})</div>`;
      return `
      <div style="page-break-inside:avoid;margin:18px 0;padding:12px;border:1px solid #ddd;border-radius:8px">
        <h3 style="margin:0 0 8px">간섭 #${i + 1} · 관통깊이 ${r.depth.toFixed(3)} m · ${esc(CLASH_STATUS_LABEL[r.status])}</h3>
        <table style="border-collapse:collapse;font-size:13px;margin-bottom:8px">
          <tr><td style="padding:2px 8px;color:#16a34a;font-weight:700">대상 A</td>
              <td style="padding:2px 8px">${esc(modelNameOf(model, r.a.expressID))}</td>
              <td style="padding:2px 8px;color:#555">${esc(r.a.category)}</td>
              <td style="padding:2px 8px;color:#555">${esc(r.a.name || '')}</td></tr>
          <tr><td style="padding:2px 8px;color:#dc2626;font-weight:700">대상 B</td>
              <td style="padding:2px 8px">${esc(modelNameOf(model, r.b.expressID))}</td>
              <td style="padding:2px 8px;color:#555">${esc(r.b.category)}</td>
              <td style="padding:2px 8px;color:#555">${esc(r.b.name || '')}</td></tr>
          <tr><td style="padding:2px 8px;color:#555">위치</td>
              <td style="padding:2px 8px" colspan="3">X ${r.point.x.toFixed(3)} · Y ${r.point.y.toFixed(3)} · Z ${r.point.z.toFixed(3)}</td></tr>
        </table>
        ${img}
      </div>`;
    })
    .join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>간섭 보고서</title></head>
<body style="font-family:'Malgun Gothic',sans-serif;max-width:900px;margin:24px auto;color:#222;padding:0 16px">
  <h1 style="margin:0 0 4px">간섭 검토 보고서</h1>
  <div style="color:#666;font-size:13px;margin-bottom:16px">
    ${opts.projectName ? `프로젝트: ${esc(opts.projectName)} · ` : ''}생성: ${esc(now)}
  </div>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:8px">
    <tr><td style="padding:3px 10px;color:#555">대상 A</td><td style="padding:3px 10px">${esc(opts.setA ?? '-')}</td></tr>
    <tr><td style="padding:3px 10px;color:#555">대상 B</td><td style="padding:3px 10px">${esc(opts.setB ?? '-')}</td></tr>
    <tr><td style="padding:3px 10px;color:#555">총 간섭</td><td style="padding:3px 10px">${rows.length} 건 (미해결 ${open} 건)</td></tr>
  </table>
  <p style="font-size:13px;color:#444;line-height:1.6">
    본 보고서는 ACC 통합모델에 대해 자동 간섭 검토를 수행한 결과입니다. 각 간섭은 대상 A(초록)·
    B(빨강) 부재로 강조되어 있으며, 관통깊이는 한 부재가 다른 부재 내부로 파고든 최대 거리입니다.
    면접촉(관통깊이 ≈ 0)은 허용오차로 제외됩니다.
  </p>
  ${sections}
</body></html>`;
}

/** HTML 문자열을 .html 파일로 다운로드. */
export function downloadReport(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
