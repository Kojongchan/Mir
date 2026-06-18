import { useEffect, useState } from 'react';
import {
  listVersions,
  signedUrl,
  sizeLabel,
  type CdeFile,
  type FileVersion,
} from '../../lib/cde';

/**
 * Modal showing every version of a document, newest first. Each row links to a
 * fresh short-lived signed URL so any historical version can be downloaded.
 */
export function VersionHistory({ file, onClose }: { file: CdeFile; onClose: () => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVersions(file.id)
      .then(setVersions)
      .catch((e) => setError((e as Error).message));
  }, [file.id]);

  const download = async (v: FileVersion) => {
    try {
      const url = await signedUrl(v.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>버전 이력</h3>
          <span className="muted">{file.name}</span>
        </div>
        <div className="modal-body">
          {error && <p className="auth-error">{error}</p>}
          {!versions && !error && <p className="muted">불러오는 중…</p>}
          {versions && versions.length === 0 && <p className="muted">버전 기록이 없습니다.</p>}
          {versions && versions.length > 0 && (
            <table className="map-table">
              <thead>
                <tr>
                  <th>버전</th>
                  <th>크기</th>
                  <th>등록일</th>
                  <th>비고</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      v{v.version_no}
                      {v.id === file.current_version_id && <span className="tag">현재</span>}
                    </td>
                    <td className="nowrap">{sizeLabel(v.size_bytes)}</td>
                    <td className="nowrap">{new Date(v.created_at).toLocaleString('ko-KR')}</td>
                    <td className="preview">{v.note || '—'}</td>
                    <td>
                      <button onClick={() => download(v)}>열기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
