import type { FileRecord } from '../../lib/files';

/** Native HTML5 video — mp4/webm/ogg. */
export function VideoViewer({ url, file }: { url: string; file: FileRecord }) {
  return (
    <div className="doc-stage doc-stage--center">
      <video className="doc-video" src={url} controls autoPlay={false} preload="metadata">
        {file.name}
      </video>
    </div>
  );
}
