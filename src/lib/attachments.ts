import { supabase } from './supabase';
import { extensionOf } from './files';

// =====================================================================
// 범용 첨부파일 데이터층 (사진/문서) — 공사일보·게시판·이슈 공용.
// 바이너리는 'docs' 버킷에 '<project_id>/attach/<id>.<ext>' 로 저장한다.
// =====================================================================

const BUCKET = 'docs';

export type AttachTarget =
  | 'daily_log'
  | 'post'
  | 'issue'
  | 'rfi'
  | 'meeting'
  | 'punch'
  | 'asset'
  | 'remote';

export interface Attachment {
  id: string;
  project_id: string;
  target_type: AttachTarget;
  target_id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

const COLS =
  'id, project_id, target_type, target_id, name, storage_path, mime_type, size_bytes, created_at';

export async function listAttachments(
  targetType: AttachTarget,
  targetId: string,
): Promise<Attachment[]> {
  const { data, error } = await supabase
    .from('attachments')
    .select(COLS)
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Attachment[];
}

export async function uploadAttachment(
  projectId: string,
  targetType: AttachTarget,
  targetId: string,
  file: File,
): Promise<Attachment> {
  const id = crypto.randomUUID();
  const ext = extensionOf(file.name);
  const path = ext
    ? `${projectId}/attach/${id}.${ext}`
    : `${projectId}/attach/${id}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('attachments')
    .insert({
      id,
      project_id: projectId,
      target_type: targetType,
      target_id: targetId,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      created_by: userData.user?.id ?? null,
    })
    .select(COLS)
    .single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  return data as Attachment;
}

export async function deleteAttachment(att: Attachment): Promise<void> {
  const { error } = await supabase.from('attachments').delete().eq('id', att.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([att.storage_path]);
}

export async function attachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  if (error) throw error;
  return data.signedUrl;
}

export function isImage(att: Attachment): boolean {
  const ext = extensionOf(att.name);
  return (
    (att.mime_type?.startsWith('image/') ?? false) ||
    ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)
  );
}
