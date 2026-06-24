import { supabase } from './supabase';

export interface FileRecord {
  id: string;
  project_id: string;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

const BUCKET = 'docs';
// Signed URLs are deliberately short-lived: a fresh one is minted each time a
// file is opened, after RLS has confirmed the caller may read it.
const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes

/** Files belonging to a project (RLS restricts to members). */
export async function listFiles(projectId: string): Promise<FileRecord[]> {
  const { data, error } = await supabase
    .from('files')
    .select('id, project_id, name, storage_path, mime_type, size_bytes, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** A single file record by id (RLS-checked through project membership). */
export async function getFile(fileId: string): Promise<FileRecord | null> {
  const { data, error } = await supabase
    .from('files')
    .select('id, project_id, name, storage_path, mime_type, size_bytes, created_at')
    .eq('id', fileId)
    .single();
  if (error) return null;
  return data;
}

/** Upload an arbitrary document/media file and register it in `files`. */
export async function uploadFile(projectId: string, file: File): Promise<FileRecord> {
  const fileId = crypto.randomUUID();
  const ext = extensionOf(file.name);
  const path = ext ? `${projectId}/${fileId}.${ext}` : `${projectId}/${fileId}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('files')
    .insert({
      id: fileId,
      project_id: projectId,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: userData.user?.id ?? null,
    })
    .select('id, project_id, name, storage_path, mime_type, size_bytes, created_at')
    .single();
  if (error) {
    // best-effort cleanup so we don't leave an orphan object
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  return data;
}

/** Delete the storage object and its record (admin-only by RLS). */
export async function deleteFile(file: FileRecord): Promise<void> {
  const { error } = await supabase.from('files').delete().eq('id', file.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([file.storage_path]);
}

/** Download raw bytes of a stored doc-bucket object (RLS-checked). */
export async function downloadFileBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Mint a short-lived signed URL for the stored object. Supabase authorises
 * this against the bucket's SELECT policy, so a non-member cannot get one.
 */
export async function signedFileUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// --------------------------------------------------------------------------
// MIME / viewer-kind detection
// --------------------------------------------------------------------------

export type ViewerKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'sheet'
  | 'docx'
  | 'pptx'
  | 'text'
  | 'unsupported';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'csv']);
const TEXT_EXT = new Set(['txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Decide which viewer to use. Extension is the primary signal (most reliable
 * across browsers); MIME is a secondary hint. Anything we can't render in the
 * browser today (avi, doc, hwp, …) falls back to download — never a
 * dead end.
 */
export function viewerKindFor(name: string, mime?: string | null): ViewerKind {
  const ext = extensionOf(name);
  const m = (mime ?? '').toLowerCase();

  if (IMAGE_EXT.has(ext) || m.startsWith('image/')) return 'image';
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (VIDEO_EXT.has(ext) || m.startsWith('video/')) return 'video';
  if (AUDIO_EXT.has(ext) || m.startsWith('audio/')) return 'audio';
  // .csv is handled by the sheet viewer (SheetJS parses it too).
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (TEXT_EXT.has(ext) || m.startsWith('text/')) return 'text';
  return 'unsupported';
}

export function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
