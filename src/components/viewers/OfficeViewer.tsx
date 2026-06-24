import type { FileRecord } from '../../lib/files';

/**
 * Office 문서(워드/엑셀/파워포인트) 미리보기 — Microsoft Office Online 전체 뷰어.
 * ACC 내장 뷰어와 동일하게 view.aspx(풀 툴바: 슬라이드쇼·확대·시트 탐색 등)를
 * 그 자리에 인라인으로 띄운다(view.aspx 는 X-Frame-Options 가 없어 임베드 가능).
 *
 * Office Online 서버가 `url` 을 직접 가져가므로 `url` 은 **공개 접근 가능한 절대
 * URL**(우리 세션 토큰 미포함)이어야 한다 — ACC=Autodesk 단기 서명 URL,
 * Supabase=서명 URL.
 */
export function OfficeViewer({ url, file }: { url: string; file: FileRecord }) {
  const enc = encodeURIComponent(url);
  const view = `https://view.officeapps.live.com/op/view.aspx?src=${enc}`;
  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <iframe
        title={file.name}
        src={view}
        style={{ flex: 1, width: '100%', border: 0 }}
        allowFullScreen
      />
      <div
        className="muted"
        style={{ fontSize: 12, padding: '5px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 14, flexWrap: 'wrap' }}
      >
        <span>Microsoft Office Online</span>
        <a href={view} target="_blank" rel="noopener noreferrer">↗ 새 탭에서 열기</a>
        <a href={url} download={file.name}>⬇ 원본 다운로드</a>
      </div>
    </div>
  );
}
