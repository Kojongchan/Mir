import { lazy, Suspense } from 'react';
import { extensionOf, type FileRecord } from '../../lib/files';
import { DownloadFallback } from './DownloadFallback';
import { SheetViewer } from './SheetViewer';

// Rendered entirely in the browser: document bytes never go to Microsoft/Google (D10).
const DocxViewer = lazy(() => import('./DocxViewer').then(m => ({ default: m.DocxViewer })));
const PptxViewer = lazy(() => import('./PptxViewer').then(m => ({ default: m.PptxViewer })));

/**
 * Office 문서(워드/엑셀/파워포인트) 미리보기 — 브라우저 내 렌더(외부 서버 전송 없음).
 * docx=docx-preview, pptx=pptx-preview, xlsx/xls/xlsm=자체 시트 뷰어(워커 격리).
 * 구형 바이너리(doc/ppt)는 브라우저 라이브러리가 없어 다운로드 안내(실무자 이상).
 * `url` 은 blob/동일 출처 URL(ACC 는 /api/aps-file 바이트 프록시)이어야 한다.
 */
export function OfficeViewer({ url, file, canDownload = true }: { url: string; file: FileRecord; canDownload?: boolean }) {
  const ext = extensionOf(file.name);
  const body = (() => {
    switch (ext) {
      case 'docx': return <DocxViewer url={url} file={file} />;
      case 'pptx': return <PptxViewer url={url} file={file} />;
      case 'xlsx': case 'xls': case 'xlsm': return <SheetViewer url={url} file={file} />;
      default: return <DownloadFallback url={url} file={file} canDownload={canDownload} />;
    }
  })();
  return (
    <div className="doc-stage" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Suspense fallback={<p className="muted doc-loading">뷰어 불러오는 중…</p>}>{body}</Suspense>
      </div>
      {canDownload && ext !== 'doc' && ext !== 'ppt' && (
        <div className="muted" style={{ fontSize: 12, padding: '5px 10px', borderTop: '1px solid var(--border)' }}>
          <a href={url} download={file.name}>⬇ 원본 다운로드</a>
        </div>
      )}
    </div>
  );
}
