import { supabase } from './supabase';
import { extensionOf } from './files';

// =====================================================================
// CDE (Common Data Environment) data layer — Phase 7 / S14.
// Builds on the `files` table + `docs` bucket from S13 (0004) by adding
// folders, per-file versions, lifecycle status and an activity trail
// (migration 0005_cde.sql). The viewer at /view/:fileId keeps working
// unchanged because we always keep files.storage_path pointing at the
// current version's object.
// =====================================================================

const BUCKET = 'docs';

export type FileStatus = 'WIP' | 'Shared' | 'Published' | 'Archived';

/** Ordered ISO 19650 lifecycle — used for the status picker and badges. */
export const FILE_STATUSES: FileStatus[] = ['WIP', 'Shared', 'Published', 'Archived'];

export const STATUS_LABEL: Record<FileStatus, string> = {
  WIP: '작업중',
  Shared: '공유',
  Published: '발행',
  Archived: '보관',
};

export interface Folder {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
}

export interface CdeFile {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  status: FileStatus;
  current_version_id: string | null;
  created_at: string;
}

export interface FileVersion {
  id: string;
  file_id: string;
  version_no: number;
  storage_path: string;
  size_bytes: number | null;
  mime_type: string | null;
  note: string | null;
  created_at: string;
}

export interface ActivityEntry {
  id: string;
  project_id: string;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

const FILE_COLS =
  'id, project_id, folder_id, name, storage_path, mime_type, size_bytes, status, current_version_id, created_at';

// --------------------------------------------------------------------------
// Folders
// --------------------------------------------------------------------------

/** All folders in a project (RLS restricts to members). Build the tree client-side. */
export async function listFolders(projectId: string): Promise<Folder[]> {
  const { data, error } = await supabase
    .from('folders')
    .select('id, project_id, parent_id, name, created_at')
    .eq('project_id', projectId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createFolder(
  projectId: string,
  parentId: string | null,
  name: string,
): Promise<Folder> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('folders')
    .insert({
      project_id: projectId,
      parent_id: parentId,
      name: name.trim(),
      created_by: userData.user?.id ?? null,
    })
    .select('id, project_id, parent_id, name, created_at')
    .single();
  if (error) throw error;
  await logActivity(projectId, 'folder.create', 'folder', data.id, { name: data.name });
  return data;
}

export async function renameFolder(folder: Folder, name: string): Promise<void> {
  const { error } = await supabase
    .from('folders')
    .update({ name: name.trim() })
    .eq('id', folder.id);
  if (error) throw error;
  await logActivity(folder.project_id, 'folder.rename', 'folder', folder.id, {
    from: folder.name,
    to: name.trim(),
  });
}

/**
 * Delete a folder. Callers must ensure it is empty (no subfolders, no files);
 * the UI enforces this. Documents whose folder is removed fall back to
 * "unfiled" (folder_id set null) by the FK, so files are never lost.
 */
export async function deleteFolder(folder: Folder): Promise<void> {
  const { error } = await supabase.from('folders').delete().eq('id', folder.id);
  if (error) throw error;
  await logActivity(folder.project_id, 'folder.delete', 'folder', folder.id, {
    name: folder.name,
  });
}

// --------------------------------------------------------------------------
// Files (CDE view — richer than lib/files.ts which the viewer uses)
// --------------------------------------------------------------------------

/** Files in one folder (folderId null = root/unfiled). RLS restricts to members. */
export async function listCdeFiles(
  projectId: string,
  folderId: string | null,
): Promise<CdeFile[]> {
  let q = supabase.from('files').select(FILE_COLS).eq('project_id', projectId);
  q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CdeFile[];
}

function versionPath(projectId: string, fileId: string, versionNo: number, name: string): string {
  const ext = extensionOf(name);
  return ext
    ? `${projectId}/${fileId}/v${versionNo}.${ext}`
    : `${projectId}/${fileId}/v${versionNo}`;
}

/**
 * Upload a brand-new document into a folder as version 1. Creates the storage
 * object, the `files` record, the v1 `file_versions` row, links it as the
 * current version and logs the activity.
 */
export async function uploadNewFile(
  projectId: string,
  folderId: string | null,
  file: File,
  note?: string,
): Promise<CdeFile> {
  const fileId = crypto.randomUUID();
  const path = versionPath(projectId, fileId, 1, file.name);

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id ?? null;

  const { data: rec, error: recErr } = await supabase
    .from('files')
    .insert({
      id: fileId,
      project_id: projectId,
      folder_id: folderId,
      name: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      status: 'WIP',
      uploaded_by: uid,
    })
    .select(FILE_COLS)
    .single();
  if (recErr) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw recErr;
  }

  const { data: ver, error: verErr } = await supabase
    .from('file_versions')
    .insert({
      file_id: fileId,
      version_no: 1,
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.type || null,
      note: note ?? null,
      uploaded_by: uid,
    })
    .select('id')
    .single();
  if (verErr) throw verErr;

  await supabase.from('files').update({ current_version_id: ver.id }).eq('id', fileId);
  await logActivity(projectId, 'file.upload', 'file', fileId, { name: file.name, version: 1 });

  return { ...(rec as CdeFile), current_version_id: ver.id };
}

/**
 * Upload a new version of an existing file. The new object is stored under a
 * fresh v<n> path; the `files` row is repointed (storage_path/mime/size/current
 * version) so the viewer always opens the latest. The original name is kept.
 */
export async function uploadNewVersion(
  target: CdeFile,
  file: File,
  note?: string,
): Promise<void> {
  const nextNo = await nextVersionNo(target.id);
  // Keep the original document's extension so the viewer dispatch stays stable.
  const path = versionPath(target.project_id, target.id, nextNo, target.name);

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();
  const { data: ver, error: verErr } = await supabase
    .from('file_versions')
    .insert({
      file_id: target.id,
      version_no: nextNo,
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.type || target.mime_type || null,
      note: note ?? null,
      uploaded_by: userData.user?.id ?? null,
    })
    .select('id')
    .single();
  if (verErr) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw verErr;
  }

  const { error: updErr } = await supabase
    .from('files')
    .update({
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.type || target.mime_type || null,
      current_version_id: ver.id,
    })
    .eq('id', target.id);
  if (updErr) throw updErr;

  await logActivity(target.project_id, 'file.version', 'file', target.id, {
    name: target.name,
    version: nextNo,
  });
}

async function nextVersionNo(fileId: string): Promise<number> {
  const { data, error } = await supabase
    .from('file_versions')
    .select('version_no')
    .eq('file_id', fileId)
    .order('version_no', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.version_no ?? 0) + 1;
}

export async function listVersions(fileId: string): Promise<FileVersion[]> {
  const { data, error } = await supabase
    .from('file_versions')
    .select('id, file_id, version_no, storage_path, size_bytes, mime_type, note, created_at')
    .eq('file_id', fileId)
    .order('version_no', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function setFileStatus(target: CdeFile, status: FileStatus): Promise<void> {
  const { error } = await supabase.from('files').update({ status }).eq('id', target.id);
  if (error) throw error;
  await logActivity(target.project_id, 'file.status', 'file', target.id, {
    name: target.name,
    from: target.status,
    to: status,
  });
}

export async function moveFile(target: CdeFile, folderId: string | null): Promise<void> {
  const { error } = await supabase.from('files').update({ folder_id: folderId }).eq('id', target.id);
  if (error) throw error;
  await logActivity(target.project_id, 'file.move', 'file', target.id, { name: target.name });
}

/** Delete a file, all its version objects and the record (admin-only by RLS). */
export async function deleteCdeFile(target: CdeFile): Promise<void> {
  const versions = await listVersions(target.id);
  const paths = versions.map((v) => v.storage_path);
  if (!paths.includes(target.storage_path)) paths.push(target.storage_path);

  const { error } = await supabase.from('files').delete().eq('id', target.id);
  if (error) throw error;
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
  await logActivity(target.project_id, 'file.delete', 'file', target.id, { name: target.name });
}

/** Mint a short-lived signed URL for a specific stored object (e.g. a version). */
export async function signedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  if (error) throw error;
  return data.signedUrl;
}

// --------------------------------------------------------------------------
// Activity log
// --------------------------------------------------------------------------

/** Best-effort append to the audit trail — never blocks the primary action. */
export async function logActivity(
  projectId: string,
  action: string,
  targetType: string,
  targetId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from('activity_log').insert({
      project_id: projectId,
      actor: userData.user?.id ?? null,
      action,
      target_type: targetType,
      target_id: targetId,
      meta: meta ?? null,
    });
  } catch {
    // Logging must not break the user's action; swallow.
  }
}

export async function listActivity(projectId: string, limit = 50): Promise<ActivityEntry[]> {
  const { data, error } = await supabase
    .from('activity_log')
    .select('id, project_id, actor, action, target_type, target_id, meta, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ActivityEntry[];
}

// --------------------------------------------------------------------------
// Small shared helpers
// --------------------------------------------------------------------------

export function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** Build a parent→children index for rendering the folder tree. */
export function buildFolderTree(folders: Folder[]): Map<string | null, Folder[]> {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parent_id;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }
  return byParent;
}
