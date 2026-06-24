import type { FileRecord } from '../../lib/files';

/**
 * PowerPoint .pptx 미리보기 — Microsoft Office Online 임베드 뷰어.
 * ACC 내장 뷰어와 동일한 고화질 렌더. Office Online 서버가 `url` 을 직접
 * 가져가므로 `url` 은 **공개 접근 가능한 절대 URL**(우리 세션 토큰 미포함)이어야
 * 한다 — ACC=Autodesk 단기 서명 URL, Supabase=서명 URL.
 */
export function PptxViewer({ url, file }: { url: string; file: FileRecord }) {
  const src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <iframe
        title={file.name}
        src={src}
        style={{ flex: 1, width: '100%', border: 0 }}
        allowFullScreen
      />
      <div className="muted" style={{ fontSize: 12, padding: '4px 10px', borderTop: '1px solid var(--border)' }}>
        Microsoft Office Online 미리보기 · 안 보이면 <a href={url} download={file.name}>원본 다운로드</a>
      </div>
    </div>
  );
}
