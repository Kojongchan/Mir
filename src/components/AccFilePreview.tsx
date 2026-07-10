import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accFileBlobUrl, accFileRedirectUrl, accFileSignedUrl, isAccModel } from '../lib/aps';
import { viewerKindFor, type ViewerKind, type FileRecord } from '../lib/files';
import { ApsMiniViewer } from './ApsMiniViewer';
import { ImageViewer } from './viewers/ImageViewer';
import { VideoViewer } from './viewers/VideoViewer';
import { AudioViewer } from './viewers/AudioViewer';
import { TextViewer } from './viewers/TextViewer';
import { DownloadFallback } from './viewers/DownloadFallback';
import { PdfViewer } from './viewers/PdfViewer';
import { SheetViewer } from './viewers/SheetViewer';
import { OfficeViewer } from './viewers/OfficeViewer';

const fakeFile = (name: string) => ({ name, size_bytes: null, mime_type: null }) as unknown as FileRecord;

/**
 * 이슈 '관련 자료' 인라인 미리보기 — 자료관리(ACC) 파일을 오버레이로 연다.
 * AccBrowser 의 문서 미리보기와 동일한 경로(blob/서명/리다이렉트 + 우리 뷰어).
 * 모델(rvt·nwd·ifc…)은 미리보기 대신 3D 뷰어로 열도록 안내한다.
 */
export function AccFilePreview({
  accProject,
  itemId,
  name,
  urn,
  onClose,
}: {
  accProject: string;
  itemId: string;
  name: string;
  urn?: string | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<{ url: string; kind: ViewerKind } | null>(null);
  const [status, setStatus] = useState('여는 중…');
  const model = isAccModel(name);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const kind = viewerKindFor(name);
      // 모델(rvt·nwd·ifc…)은 인라인 3D 뷰어로 직접 띄운다(urn 있을 때).
      if (isAccModel(name)) {
        setStatus(urn ? 'model3d' : 'model');
        return;
      }
      if (kind === 'unsupported' && model) {
        setStatus('model');
        return;
      }
      try {
        let url: string;
        if (kind === 'office') url = await accFileSignedUrl(accProject, itemId, name);
        else if (kind === 'video' || kind === 'audio' || kind === 'unsupported') url = await accFileRedirectUrl(accProject, itemId);
        else {
          url = await accFileBlobUrl(accProject, itemId);
          blobRef.current = url;
        }
        if (!alive) return;
        setView({ url, kind });
        setStatus('');
      } catch (e) {
        if (alive) setStatus(`열기 실패: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accProject, itemId]);

  const renderDoc = () => {
    if (!view) return null;
    const f = fakeFile(name);
    switch (view.kind) {
      case 'image': return <ImageViewer url={view.url} file={f} />;
      case 'pdf': return <PdfViewer url={view.url} file={f} />;
      case 'video': return <VideoViewer url={view.url} file={f} />;
      case 'audio': return <AudioViewer url={view.url} file={f} />;
      case 'sheet': return <SheetViewer url={view.url} file={f} />;
      case 'office': return <OfficeViewer url={view.url} file={f} />;
      case 'text': return <TextViewer url={view.url} file={f} />;
      default: return <DownloadFallback url={view.url} file={f} />;
    }
  };

  return createPortal(
    <div className="acc-doc-overlay">
      <div className="acc-doc-head">
        <strong className="cde-view-name">👁 {name}</strong>
        <div className="spacer" />
        <button onClick={onClose}>✕ 닫기</button>
      </div>
      <div className="acc-doc-body">
        {status === 'model3d' && urn ? (
          <ApsMiniViewer urn={urn} />
        ) : status === 'model' ? (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
            변환된 3D 뷰가 아직 없습니다(ACC 처리 중이거나 권한 없음).
          </div>
        ) : status ? (
          <div className="muted" style={{ padding: 24 }}>{status}</div>
        ) : (
          renderDoc()
        )}
      </div>
    </div>,
    document.body,
  );
}
