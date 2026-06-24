import type { FileRecord } from '../../lib/files';

/**
 * Office 문서(워드/엑셀/파워포인트) 미리보기 — Microsoft Office Online 임베드.
 * ACC 내장 뷰어와 동일한 고화질 렌더. Office Online 서버가 `url` 을 직접
 * 가져가므로 `url` 은 **공개 접근 가능한 절대 URL**(우리 세션 토큰 미포함)이어야
 * 한다 — ACC=Autodesk 단기 서명 URL, Supabase=서명 URL.
 *
 * 임베드(embed.aspx)는 읽기 전용 경량 뷰라 슬라이드쇼·편집은 없다 → 전체 기능은
 * '새 탭에서 전체 보기'(view.aspx)로 Office Online 전체 뷰어에서 사용.
 */
export function OfficeViewer({ url, file }: { url: string; file: FileRecord }) {
  const enc = encodeURIComponent(url);
  const embed = `https://view.officeapps.live.com/op/embed.aspx?src=${enc}`;
  const full = `https://view.officeapps.live.com/op/view.aspx?src=${enc}`;
  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <iframe
        title={file.name}
        src={embed}
        style={{ flex: 1, width: '100%', border: 0 }}
        allowFullScreen
      />
      <div
        className="muted"
        style={{ fontSize: 12, padding: '5px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 14, flexWrap: 'wrap' }}
      >
        <span>Microsoft Office Online 미리보기</span>
        <a href={full} target="_blank" rel="noopener noreferrer">↗ 새 탭에서 전체 보기(슬라이드쇼·확대)</a>
        <a href={url} download={file.name}>⬇ 원본 다운로드</a>
      </div>
    </div>
  );
}
