import { supabase } from './supabase';

export interface Project {
  id: string;
  name: string;
  code: string | null;
}

export interface ModelRecord {
  id: string;
  project_id: string;
  name: string;
  storage_path: string;
  size_bytes: number | null;
  created_at: string;
}

const BUCKET = 'models';

/** Projects the current user is allowed to see (enforced by RLS). */
export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, code')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function getProject(projectId: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, code')
    .eq('id', projectId)
    .single();
  if (error) return null;
  return data;
}

export async function listModels(projectId: string): Promise<ModelRecord[]> {
  const { data, error } = await supabase
    .from('models')
    .select('id, project_id, name, storage_path, size_bytes, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Upload an IFC file to Storage and register it in the models table. */
export async function uploadModel(projectId: string, file: File): Promise<ModelRecord> {
  const modelId = crypto.randomUUID();
  const path = `${projectId}/${modelId}.ifc`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: 'application/octet-stream', upsert: false });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('models')
    .insert({
      id: modelId,
      project_id: projectId,
      name: file.name,
      storage_path: path,
      size_bytes: file.size,
      uploaded_by: userData.user?.id ?? null,
    })
    .select('id, project_id, name, storage_path, size_bytes, created_at')
    .single();
  if (error) {
    // best-effort cleanup so we don't leave an orphan object
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  return data;
}

/** Download the IFC bytes for a stored model (RLS-checked signed access). */
export async function downloadModelBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}
