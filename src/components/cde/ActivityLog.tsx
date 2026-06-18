import { useEffect, useState } from 'react';
import { listActivity, type ActivityEntry } from '../../lib/cde';

const ACTION_LABEL: Record<string, string> = {
  'file.upload': '문서 업로드',
  'file.version': '새 버전 등록',
  'file.status': '상태 변경',
  'file.move': '폴더 이동',
  'file.delete': '문서 삭제',
  'folder.create': '폴더 생성',
  'folder.rename': '폴더 이름 변경',
  'folder.delete': '폴더 삭제',
};

function describe(a: ActivityEntry): string {
  const label = ACTION_LABEL[a.action] ?? a.action;
  const meta = a.meta ?? {};
  const name = typeof meta.name === 'string' ? meta.name : '';
  if (a.action === 'file.status') return `${label}: ${meta.from} → ${meta.to} (${name})`;
  if (a.action === 'folder.rename') return `${label}: ${meta.from} → ${meta.to}`;
  if (a.action === 'file.version') return `${label}: ${name} v${meta.version}`;
  return name ? `${label}: ${name}` : label;
}

/** Modal showing the project's recent CDE activity (audit trail), newest first. */
export function ActivityLog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listActivity(projectId)
      .then(setEntries)
      .catch((e) => setError((e as Error).message));
  }, [projectId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>활동 로그</h3>
          <span className="muted">최근 활동 (최신순)</span>
        </div>
        <div className="modal-body">
          {error && <p className="auth-error">{error}</p>}
          {!entries && !error && <p className="muted">불러오는 중…</p>}
          {entries && entries.length === 0 && <p className="muted">기록된 활동이 없습니다.</p>}
          {entries && entries.length > 0 && (
            <ul className="cde-activity">
              {entries.map((a) => (
                <li key={a.id}>
                  <span className="cde-activity-when">
                    {new Date(a.created_at).toLocaleString('ko-KR')}
                  </span>
                  <span className="cde-activity-what">{describe(a)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
