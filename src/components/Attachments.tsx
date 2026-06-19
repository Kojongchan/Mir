import { useEffect, useRef, useState } from 'react';
import {
  attachmentUrl,
  deleteAttachment,
  isImage,
  listAttachments,
  uploadAttachment,
  type AttachTarget,
  type Attachment,
} from '../lib/attachments';
import { errMessage } from '../lib/errors';

interface Props {
  projectId: string;
  targetType: AttachTarget;
  targetId: string;
  isAdmin: boolean;
  label?: string;
}

/**
 * Reusable attachment strip — image thumbnails + file chips for any entity
 * (공사일보·게시판·이슈). Members view; admins upload/delete (D11). Binaries
 * live in the `docs` bucket and are opened via short-lived signed URLs.
 */
export function Attachments({ projectId, targetType, targetId, isAdmin, label = '첨부' }: Props) {
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const list = await listAttachments(targetType, targetId);
      setAtts(list);
      const entries = await Promise.all(
        list.map(async (a) => [a.id, await attachmentUrl(a.storage_path).catch(() => '')] as const),
      );
      setUrls(Object.fromEntries(entries));
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType, targetId]);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setBusy(true);
    setErr('');
    try {
      for (const f of Array.from(files)) {
        await uploadAttachment(projectId, targetType, targetId, f);
      }
      await load();
    } catch (e2) {
      setErr(errMessage(e2));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const onDelete = async (a: Attachment) => {
    if (!window.confirm(`'${a.name}' 첨부를 삭제할까요?`)) return;
    try {
      await deleteAttachment(a);
      await load();
    } catch (e) {
      setErr(errMessage(e));
    }
  };

  return (
    <div className="attach">
      <div className="attach-head">
        <span className="attach-label">{label} {atts.length > 0 && `(${atts.length})`}</span>
        {isAdmin && (
          <>
            <input ref={input} type="file" multiple style={{ display: 'none' }} onChange={onUpload} />
            <button onClick={() => input.current?.click()} disabled={busy}>
              {busy ? '업로드 중…' : '＋ 첨부'}
            </button>
          </>
        )}
      </div>
      {err && <p className="auth-error" style={{ fontSize: 12 }}>{err}</p>}
      {atts.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>첨부 없음</p>
      ) : (
        <div className="attach-grid">
          {atts.map((a) => (
            <div className="attach-item" key={a.id}>
              <a href={urls[a.id] || undefined} target="_blank" rel="noopener" title={a.name}>
                {isImage(a) && urls[a.id] ? (
                  <img className="attach-thumb" src={urls[a.id]} alt={a.name} />
                ) : (
                  <span className="attach-file">📄 {a.name}</span>
                )}
              </a>
              {isAdmin && <button className="attach-del" onClick={() => onDelete(a)} title="삭제">×</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
