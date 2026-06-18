import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  getFile,
  signedFileUrl,
  sizeLabel,
  viewerKindFor,
  type FileRecord,
} from '../lib/files';
// Light viewers stay inline; the heavy ones (PDF.js / SheetJS / mammoth) are
// code-split so their libraries load only when such a file is actually opened.
import { ImageViewer } from '../components/viewers/ImageViewer';
import { VideoViewer } from '../components/viewers/VideoViewer';
import { AudioViewer } from '../components/viewers/AudioViewer';
import { TextViewer } from '../components/viewers/TextViewer';
import { DownloadFallback } from '../components/viewers/DownloadFallback';

const PdfViewer = lazy(() =>
  import('../components/viewers/PdfViewer').then((m) => ({ default: m.PdfViewer })),
);
const SheetViewer = lazy(() =>
  import('../components/viewers/SheetViewer').then((m) => ({ default: m.SheetViewer })),
);
const DocxViewer = lazy(() =>
  import('../components/viewers/DocxViewer').then((m) => ({ default: m.DocxViewer })),
);

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; file: FileRecord; url: string };

/**
 * Standalone preview route (opened in a new tab from the workspace).
 * Resolves the file (RLS-checked), mints a short-lived signed URL, then
 * dispatches to the right viewer by MIME/extension. Unsupported formats get a
 * download fallback so there's never a dead end.
 */
export function FileViewer() {
  const { fileId = '' } = useParams();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const file = await getFile(fileId);
        if (!file) {
          if (!cancelled)
            setState({ phase: 'error', message: '파일을 찾을 수 없거나 접근 권한이 없습니다.' });
          return;
        }
        const url = await signedFileUrl(file.storage_path);
        if (!cancelled) setState({ phase: 'ready', file, url });
      } catch (e) {
        if (!cancelled) setState({ phase: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return (
    <div className="doc-viewer-page">
      <header className="doc-viewer-bar">
        <span className="brand">
          <BrandLogo size="sm" />
        </span>
        <span className="doc-viewer-title">
          {state.phase === 'ready' ? state.file.name : '미리보기'}
        </span>
        {state.phase === 'ready' && (
          <span className="muted doc-viewer-size">{sizeLabel(state.file.size_bytes)}</span>
        )}
        <div className="spacer" />
        <ThemeToggle />
        {state.phase === 'ready' && (
          <a className="doc-viewer-dl" href={state.url} download={state.file.name}>
            다운로드
          </a>
        )}
      </header>

      <main className="doc-viewer-body">
        {state.phase === 'loading' && <p className="muted doc-loading">불러오는 중…</p>}
        {state.phase === 'error' && <p className="doc-error">{state.message}</p>}
        {state.phase === 'ready' && (
          <Suspense fallback={<p className="muted doc-loading">뷰어 불러오는 중…</p>}>
            <Dispatch file={state.file} url={state.url} />
          </Suspense>
        )}
      </main>
    </div>
  );
}

function Dispatch({ file, url }: { file: FileRecord; url: string }) {
  const kind = viewerKindFor(file.name, file.mime_type);
  switch (kind) {
    case 'image':
      return <ImageViewer file={file} url={url} />;
    case 'pdf':
      return <PdfViewer file={file} url={url} />;
    case 'video':
      return <VideoViewer file={file} url={url} />;
    case 'audio':
      return <AudioViewer file={file} url={url} />;
    case 'sheet':
      return <SheetViewer file={file} url={url} />;
    case 'docx':
      return <DocxViewer file={file} url={url} />;
    case 'text':
      return <TextViewer file={file} url={url} />;
    default:
      return <DownloadFallback file={file} url={url} />;
  }
}
