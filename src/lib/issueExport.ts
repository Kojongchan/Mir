import type { Issue } from './issues';
import { PRIORITY_LABEL, STATUS_LABEL } from './issues';
import { TYPE_FIELDS, TYPE_LABEL, metaSummary, metaValue, siteTagOf, statusLabelFor } from './issueTypes';
import type { IssueViewpoint } from './issueViewpoints';
import type { Attachment } from './attachments';
import { attachmentUrl, isImage } from './attachments';

// =====================================================================
// 이슈 출력/양식 — 플랫폼 안에서 완결되는 문서화 레이어.
//   • 엑셀 export(xlsx) — 현재 필터/정렬이 반영된 목록 그대로 내보내기.
//   • RFI/지적통보서 양식 .docx — docxtemplater + pizzip(런타임 생성 템플릿).
//     회사 양식(.docx) 파일이 확정되면 템플릿만 교체하면 된다(데이터 키 동일).
//   • 인쇄용 양식(브라우저 인쇄 → PDF 저장) — 사진·뷰포인트 스냅샷 포함.
// 무거운 라이브러리는 dynamic import 로 사용 시점에만 로드(코드 스플리팅 유지).
// =====================================================================

function fmt(d: string | null | undefined): string {
  return d ? d.slice(0, 10) : '';
}

function issueNoOf(issue: Issue, all: Issue[]): number {
  const sorted = [...all].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return sorted.findIndex((i) => i.id === issue.id) + 1;
}

// ---------- 1) 엑셀 export ------------------------------------------

/** 현재 화면(필터·정렬 반영)의 이슈 목록을 엑셀로 저장. */
export async function exportIssuesXlsx(
  projectName: string,
  issues: Issue[],
  all: Issue[],
  categoryName: (id: string | null) => string = () => '',
): Promise<void> {
  const XLSX = await import('xlsx');
  const rows = issues.map((it) => ({
    번호: issueNoOf(it, all),
    항목: categoryName(it.category_id) || '미지정',
    유형: TYPE_LABEL[it.type],
    제목: it.title,
    상태: statusLabelFor(it.type, it.status, STATUS_LABEL[it.status]),
    우선순위: PRIORITY_LABEL[it.priority],
    담당자: it.assignee_name ?? '',
    마감일: fmt(it.due_date),
    등록자: it.created_by_name ?? '',
    등록일: fmt(it.created_at),
    내용: it.description ?? '',
    '타입별 정보': metaSummary(it.type, it.meta),
    'GPS(현장)': (() => {
      const s = siteTagOf(it.meta);
      return s ? `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}` : '';
    })(),
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 10 }, { wch: 8 },
    { wch: 14 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 50 }, { wch: 40 }, { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '이슈');
  XLSX.writeFile(wb, `이슈목록_${projectName || '프로젝트'}_${fmt(new Date().toISOString())}.xlsx`);
}

// ---------- 2) RFI/지적통보서 .docx (docxtemplater) -------------------

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

function para(text: string, opts: { bold?: boolean; size?: number; center?: boolean } = {}): string {
  const rPr = `<w:rPr>${opts.bold ? '<w:b/>' : ''}<w:sz w:val="${(opts.size ?? 11) * 2}"/></w:rPr>`;
  const pPr = `<w:pPr>${opts.center ? '<w:jc w:val="center"/>' : ''}${rPr}</w:pPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function cell(content: string, opts: { width?: number; shade?: boolean } = {}): string {
  return (
    `<w:tc><w:tcPr>` +
    (opts.width ? `<w:tcW w:w="${opts.width}" w:type="dxa"/>` : '') +
    (opts.shade ? `<w:shd w:val="clear" w:fill="EEF1F5"/>` : '') +
    `</w:tcPr>${content}</w:tc>`
  );
}

function labelRow(label: string, tag: string): string {
  return `<w:tr>${cell(para(label, { bold: true }), { width: 1800, shade: true })}${cell(para(`{${tag}}`), { width: 7200 })}</w:tr>`;
}

const TBL_PR =
  `<w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>` +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="6" w:color="666666"/>`)
    .join('') +
  `</w:tblBorders></w:tblPr>`;

/** 양식 종류별 문서 구성(템플릿 XML) — 회사 양식 확정 전 기본 서식. */
function buildFormDocumentXml(kind: 'rfi' | 'notice', rows: Array<[string, string]>): string {
  const title = kind === 'rfi' ? 'RFI (질의서)' : '지적통보서';
  const body =
    para(title, { bold: true, size: 20, center: true }) +
    para('', {}) +
    `<w:tbl>${TBL_PR}${rows.map(([label, tag]) => labelRow(label, tag)).join('')}</w:tbl>` +
    para('', {}) +
    para('위와 같이 통보하오니 조치 후 회신 바랍니다.', {}) +
    para('', {}) +
    para('{issued_date}', { center: true }) +
    para('', {}) +
    para('발신: {sender} (인)', {}) +
    para('수신: {receiver}', {});
  return (
    XML_HEAD +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

const CONTENT_TYPES =
  XML_HEAD +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const RELS =
  XML_HEAD +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

/**
 * 이슈 1건을 RFI/지적통보서 .docx 로 저장.
 * kind='rfi' 는 RFI 타입 필드(상대처·응답기한·질의/응답), 그 외는 지적통보서 서식.
 */
export async function exportIssueFormDocx(
  issue: Issue,
  all: Issue[],
  projectName: string,
  authorName: string | null,
  categoryName = '',
): Promise<void> {
  const [{ default: PizZip }, { default: Docxtemplater }] = await Promise.all([
    import('pizzip'),
    import('docxtemplater'),
  ]);

  const kind = issue.type === 'rfi' ? 'rfi' : 'notice';
  const no = issueNoOf(issue, all);
  const common: Array<[string, string]> = [
    ['문서번호', 'doc_no'],
    ['공사명', 'project'],
    ['제목', 'title'],
    ['항목', 'category'],
    ['유형', 'type'],
    ['상태', 'status'],
    ['우선순위', 'priority'],
    ['담당자', 'assignee'],
    ['마감일', 'due'],
  ];
  const typed: Array<[string, string]> = TYPE_FIELDS[issue.type].map((f) => [f.label, `f_${f.key}`]);
  const rows: Array<[string, string]> = [
    ...common,
    ...typed,
    [kind === 'rfi' ? '질의 내용' : '지적 내용', 'description'],
  ];

  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('word/document.xml', buildFormDocumentXml(kind, rows));

  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  const data: Record<string, string> = {
    doc_no: `${kind === 'rfi' ? 'RFI' : 'NTC'}-${String(no).padStart(4, '0')}`,
    project: projectName || '',
    title: issue.title,
    category: categoryName || '미지정',
    type: TYPE_LABEL[issue.type],
    status: statusLabelFor(issue.type, issue.status, STATUS_LABEL[issue.status]),
    priority: PRIORITY_LABEL[issue.priority],
    assignee: issue.assignee_name ?? '미지정',
    due: fmt(issue.due_date) || '-',
    description: issue.description ?? '',
    issued_date: new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }),
    sender: authorName ?? '',
    receiver: metaValue(issue.meta, 'to_party') || metaValue(issue.meta, 'contractor') || '',
  };
  for (const f of TYPE_FIELDS[issue.type]) data[`f_${f.key}`] = metaValue(issue.meta, f.key) || '-';
  doc.render(data);

  const blob = doc.getZip().generate({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }) as Blob;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.doc_no}_${issue.title.slice(0, 30)}.docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---------- 3) 인쇄용 양식(브라우저 인쇄 → PDF) ----------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 이슈 1건을 인쇄용 양식 창으로 연다(사진·뷰포인트 스냅샷 포함, A4 인쇄 CSS).
 * 브라우저 인쇄 대화상자에서 'PDF로 저장'을 선택하면 양식 PDF 가 된다.
 */
export async function openIssueFormPrint(
  issue: Issue,
  all: Issue[],
  projectName: string,
  attachments: Attachment[],
  viewpoints: IssueViewpoint[],
  categoryName = '',
): Promise<void> {
  const kind = issue.type === 'rfi' ? 'RFI (질의서)' : '지적통보서';
  const no = issueNoOf(issue, all);
  const docNo = `${issue.type === 'rfi' ? 'RFI' : 'NTC'}-${String(no).padStart(4, '0')}`;

  // 첨부 이미지 서명 URL(양식에 삽입) — 실패한 것은 건너뜀.
  const photos: string[] = [];
  for (const att of attachments.filter(isImage).slice(0, 6)) {
    try {
      photos.push(await attachmentUrl(att.storage_path));
    } catch {
      /* skip */
    }
  }
  for (const vp of viewpoints) if (vp.snapshot) photos.push(vp.snapshot);

  const site = siteTagOf(issue.meta);
  const typedRows = TYPE_FIELDS[issue.type]
    .map((f) => ({ f, v: metaValue(issue.meta, f.key) }))
    .filter((x) => x.v)
    .map((x) => `<tr><th>${esc(x.f.label)}</th><td>${esc(x.v)}</td></tr>`)
    .join('');

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(docNo)} ${esc(issue.title)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #111; margin: 0; }
  h1 { text-align: center; font-size: 22px; letter-spacing: 8px; margin: 0 0 18px; }
  .docmeta { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px; }
  th, td { border: 1px solid #555; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #eef1f5; width: 130px; font-weight: 600; }
  .content-cell { min-height: 120px; white-space: pre-wrap; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .photos img { width: 100%; border: 1px solid #999; }
  .sign { margin-top: 28px; font-size: 13px; display: flex; justify-content: space-between; }
  .foot { text-align: center; margin-top: 24px; font-size: 13px; }
  @media print { .noprint { display: none; } }
  .noprint { position: fixed; top: 8px; right: 8px; }
</style></head><body>
<button class="noprint" onclick="window.print()">🖨 인쇄 / PDF 저장</button>
<h1>${esc(kind)}</h1>
<div class="docmeta"><span>문서번호: ${esc(docNo)}</span><span>발행일: ${new Date().toLocaleDateString('ko-KR')}</span></div>
<table>
  <tr><th>공사명</th><td>${esc(projectName)}</td></tr>
  <tr><th>제목</th><td>${esc(issue.title)}</td></tr>
  <tr><th>항목 / 유형</th><td>${esc(categoryName || '미지정')} / ${esc(TYPE_LABEL[issue.type])}</td></tr>
  <tr><th>상태 / 우선순위</th><td>${esc(statusLabelFor(issue.type, issue.status, STATUS_LABEL[issue.status]))} / ${esc(PRIORITY_LABEL[issue.priority])}</td></tr>
  <tr><th>담당자</th><td>${esc(issue.assignee_name ?? '미지정')}</td></tr>
  <tr><th>마감일</th><td>${esc(fmt(issue.due_date) || '-')}</td></tr>
  ${typedRows}
  ${site ? `<tr><th>현장 위치(GPS)</th><td>${site.lat.toFixed(6)}, ${site.lng.toFixed(6)} (${esc(fmt(site.taken_at))})</td></tr>` : ''}
  <tr><th>${issue.type === 'rfi' ? '질의 내용' : '지적 내용'}</th><td class="content-cell">${esc(issue.description ?? '')}</td></tr>
</table>
${photos.length ? `<table><tr><th>현장 사진 / 3D 뷰</th><td><div class="photos">${photos.map((p) => `<img src="${p}" alt="첨부">`).join('')}</div></td></tr></table>` : ''}
<div class="foot">위와 같이 통보하오니 조치 후 회신 바랍니다.</div>
<div class="sign"><span>발신: ${esc(issue.created_by_name ?? '')} (인)</span><span>수신: ${esc(metaValue(issue.meta, 'to_party') || metaValue(issue.meta, 'contractor') || '　　　　')} (인)</span></div>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) throw new Error('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
  w.document.write(html);
  w.document.close();
}
