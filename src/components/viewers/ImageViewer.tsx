import type { FileRecord } from '../../lib/files';

/** Native image preview — jpg/png/webp/gif/bmp/svg. */
export function ImageViewer({ url, file }: { url: string; file: FileRecord }) {
  return (
    <div className="doc-stage doc-stage--center">
      <img className="doc-image" src={url} alt={file.name} />
    </div>
  );
}
