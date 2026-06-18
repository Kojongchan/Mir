import type { FileRecord } from '../../lib/files';

/** Native HTML5 audio — mp3/wav/m4a/… */
export function AudioViewer({ url, file }: { url: string; file: FileRecord }) {
  return (
    <div className="doc-stage doc-stage--center">
      <div className="doc-audio-card">
        <div className="doc-audio-name">{file.name}</div>
        <audio src={url} controls preload="metadata" />
      </div>
    </div>
  );
}
