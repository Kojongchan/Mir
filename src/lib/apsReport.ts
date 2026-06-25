import * as THREE from 'three';
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

/**
 * 한 간섭을 4각도(상위 파일만 보이는 상태)로 캡처해 dataURL 배열로 반환(#7).
 * showApsClash 로 격리·색·줌을 잡은 뒤 클래시 중심을 축으로 카메라를 회전한다.
 */
export async function captureClashAngles(
  viewer: ApsViewer,
  model: ApsModel,
  aDbId: number,
  bDbId: number,
  count = 4,
): Promise<string[]> {
  const shots: string[] = [];
  try {
    showApsClash(viewer, model, aDbId, bDbId);
    await wait(350);
    const nav = viewer.navigation;
    const center = nav.getTarget().clone();
    const pos0 = nav.getPosition().clone();
    const up: THREE.Vector3 = (nav.getWorldUpVector?.() ?? new THREE.Vector3(0, 0, 1)).clone().normalize();
    const offset = pos0.clone().sub(center);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      const rot = new THREE.Matrix4().makeRotationAxis(up, ang);
      const eye = center.clone().add(offset.clone().applyMatrix4(rot));
      try {
        nav.setView(eye, center);
        nav.setCameraUpVector?.(up);
      } catch {
        /* 무시 */
      }
      await wait(300);
      shots.push(await captureScreenshot(viewer, 720, 460));
    }
    try {
      nav.setView(pos0, center); // 원위치 복귀
    } catch {
      /* 무시 */
    }
  } catch {
    /* 무시 */
  }
  return shots;
}

/** dataURL → File(이슈 첨부 업로드용). */
export function dataUrlToFile(dataUrl: string, name: string): File | null {
  try {
    const [meta, b64] = dataUrl.split(',');
    const mime = /data:(.*?);/.exec(meta)?.[1] ?? 'image/png';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  } catch {
    return null;
  }
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

  // 검토사항 요약 — 모델(상위 파일) 쌍별 건수(첨부 양식의 '구분/검토결과' 표처럼).
  const byPair = new Map<string, number>();
  for (const r of rows) {
    const fa = modelNameOf(model, r.a.expressID);
    const fb = modelNameOf(model, r.b.expressID);
    const key = [fa, fb].sort().join(' ↔ ');
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  const summaryRows = [...byPair.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, n], i) =>
        `<tr><td style="${td}">${i + 1}</td><td style="${td};text-align:left">${esc(k)}</td><td style="${td}">${n} 건</td></tr>`,
    )
    .join('');

  // 항목별 상세 — 첨부 보고서의 1건당 표(분야/항목/관련 모델/BIM 모델 사진/검토내용).
  const sections = rows
    .map((r, i) => {
      const fa = modelNameOf(model, r.a.expressID);
      const fb = modelNameOf(model, r.b.expressID);
      const img = shots[r.id]
        ? `<img src="${shots[r.id]}" alt="간섭 ${i + 1}" style="max-width:100%;border:1px solid #bbb" />`
        : `<div style="color:#888;font-size:12px;padding:20px;text-align:center">(이미지 없음 — ${i < max ? '캡처 실패' : '캡처 생략'})</div>`;
      const review = `${esc(fa)}의 「${esc(r.a.name || r.a.category)}」와(과) ${esc(fb)}의 「${esc(r.b.name || r.b.category)}」가 간섭(관통깊이 ${r.depth.toFixed(3)} m). 설계 협의·도면 수정 검토 필요.`;
      return `
      <div style="page-break-inside:avoid;margin:14px 0">
        <h3 style="margin:0 0 6px;font-size:15px">(${i + 1}) ${esc(fa)} ↔ ${esc(fb)} 간섭</h3>
        <table style="border-collapse:collapse;width:100%;font-size:12.5px">
          <tr><th style="${th};width:90px">분야</th><td style="${td};text-align:left">${esc(fa)}</td>
              <th style="${th};width:70px">구분</th><td style="${td};text-align:left">간섭</td></tr>
          <tr><th style="${th}">항목</th><td style="${td};text-align:left" colspan="3">
              <span style="color:#16a34a;font-weight:700">A</span> ${esc(r.a.name || r.a.category)}
              &nbsp;↔&nbsp; <span style="color:#dc2626;font-weight:700">B</span> ${esc(r.b.name || r.b.category)}</td></tr>
          <tr><th style="${th}">관련 모델</th><td style="${td};text-align:left" colspan="3">A: ${esc(fa)} · ${esc(r.a.category)}<br/>B: ${esc(fb)} · ${esc(r.b.category)}</td></tr>
          <tr><th style="${th}">BIM 모델</th><td style="${td}" colspan="3">${img}</td></tr>
          <tr><th style="${th}">간섭 위치</th><td style="${td};text-align:left" colspan="3">
              X ${r.point.x.toFixed(3)} · Y ${r.point.y.toFixed(3)} · Z ${r.point.z.toFixed(3)} &nbsp; / &nbsp; 관통깊이 ${r.depth.toFixed(3)} m &nbsp; / &nbsp; 상태 ${esc(CLASH_STATUS_LABEL[r.status])}</td></tr>
          <tr><th style="${th}">검토내용</th><td style="${td};text-align:left" colspan="3">${review}</td></tr>
        </table>
      </div>`;
    })
    .join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" /><title>간섭 검토 보고서</title></head>
<body style="font-family:'Malgun Gothic','맑은 고딕',sans-serif;max-width:920px;margin:24px auto;color:#222;padding:0 18px;line-height:1.5">
  <h1 style="margin:0 0 2px;font-size:22px;border-bottom:3px solid #1f3b66;padding-bottom:6px">BIM 간섭 검토 결과</h1>
  <div style="color:#666;font-size:12.5px;margin:8px 0 18px">
    ${opts.projectName ? `프로젝트: ${esc(opts.projectName)} &nbsp;·&nbsp; ` : ''}작성일: ${esc(now)}
  </div>

  <h2 style="font-size:16px;margin:18px 0 6px">1. 검토 개요</h2>
  <p style="font-size:13px;color:#333">
    ACC 통합모델을 대상으로 부재 간 간섭(Hard Clash)을 자동 검출하였다. 대상 A(${esc(opts.setA ?? '-')})와
    대상 B(${esc(opts.setB ?? '-')}) 사이에서 <b>총 ${rows.length}건</b>(미해결 ${open}건)의 간섭이 확인되었다.
    관통깊이는 한 부재가 상대 부재 내부로 파고든 최대 거리이며, 면접촉(≈0)은 허용오차로 제외하였다.
  </p>

  <h2 style="font-size:16px;margin:18px 0 6px">2. 검토 사항 (요약)</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr><th style="${th};width:50px">No</th><th style="${th}">대상(모델 쌍)</th><th style="${th};width:90px">건수</th></tr>
    ${summaryRows || `<tr><td style="${td}" colspan="3">간섭 없음</td></tr>`}
  </table>

  <h2 style="font-size:16px;margin:22px 0 6px">3. 간섭 상세</h2>
  ${sections}

  <p style="margin-top:24px;font-size:11px;color:#999">※ 본 보고서 양식은 임시안이며, 표준 양식 제공 시 반영합니다.</p>
</body></html>`;
}

const th = 'border:1px solid #999;background:#eef1f6;padding:5px 8px;text-align:center;font-weight:700;color:#1f3b66';
const td = 'border:1px solid #999;padding:5px 8px;text-align:center;color:#222';

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
