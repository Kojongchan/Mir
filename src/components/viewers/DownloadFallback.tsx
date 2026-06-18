import { extensionOf, sizeLabel, type FileRecord } from '../../lib/files';

/**
 * Fallback for formats we can't render in the browser today (avi, pptx, doc,
 * hwp, …). Never a dead end: offer a direct download via the signed URL.
 */
export function DownloadFallback({ url, file }: { url: string; file: FileRecord }) {
  const ext = extensionOf(file.name).toUpperCase() || '파일';
  return (
    <div className="doc-stage doc-stage--center">
      <div className="doc-fallback">
        <div className="doc-fallback-ext">{ext}</div>
        <p className="doc-fallback-name">{file.name}</p>
        <p className="muted">{sizeLabel(file.size_bytes)}</p>
        <p className="muted doc-fallback-note">
          이 형식은 브라우저 미리보기를 아직 지원하지 않습니다. 다운로드 후 확인하세요.
          <br />
          (서버 변환은 다음 단계에서 지원 예정)
        </p>
        <a className="btn-primary" href={url} download={file.name}>
          다운로드
        </a>
      </div>
    </div>
  );
}
