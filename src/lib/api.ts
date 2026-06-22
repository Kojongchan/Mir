import { supabase } from './supabase';

export interface Project {
  id: string;
  name: string;
  code: string | null;
}

export type ModelPurpose = 'integrated' | '4d' | 'clash';

export interface ModelRecord {
  id: string;
  project_id: string;
  name: string;
  storage_path: string;
  size_bytes: number | null;
  purpose: ModelPurpose;
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

/**
 * Models for a project. `purpose` separates the integrated 3D model from the
 * copies uploaded specifically for 4D scheduling or clash detection, so each
 * module only sees its own set (S33).
 */
const COLS = 'id, project_id, name, storage_path, size_bytes, purpose, created_at';
const COLS_LEGACY = 'id, project_id, name, storage_path, size_bytes, created_at';

export async function listModels(projectId: string, purpose?: ModelPurpose): Promise<ModelRecord[]> {
  let query = supabase.from('models').select(COLS).eq('project_id', projectId);
  if (purpose) query = query.eq('purpose', purpose);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (!error) return data ?? [];

  // 0016 미적용(purpose 컬럼 없음) → 레거시 조회로 폴백: 모든 모델을
  // 'integrated' 로 간주. 통합모델은 그대로 보이고, 4d/clash 는 빈 목록.
  const legacy = await supabase
    .from('models')
    .select(COLS_LEGACY)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (legacy.error) throw error;
  const rows = (legacy.data ?? []).map((r) => ({ ...r, purpose: 'integrated' as ModelPurpose }));
  return purpose && purpose !== 'integrated' ? [] : rows;
}

/** A single model by id (any purpose) — used by issue "위치 보기" to open the
 *  linked model even when it isn't in the current module's filtered list. */
export async function getModel(modelId: string): Promise<ModelRecord | null> {
  const { data, error } = await supabase.from('models').select(COLS).eq('id', modelId).single();
  if (!error) return data;
  const legacy = await supabase.from('models').select(COLS_LEGACY).eq('id', modelId).single();
  if (legacy.error) return null;
  return { ...legacy.data, purpose: 'integrated' as ModelPurpose };
}

/** Upload an IFC file to Storage and register it in the models table. */
export async function uploadModel(
  projectId: string,
  file: File,
  purpose: ModelPurpose = 'integrated',
): Promise<ModelRecord> {
  const modelId = crypto.randomUUID();
  const path = `${projectId}/${modelId}.ifc`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: 'application/octet-stream', upsert: false });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();
  const base = {
    id: modelId,
    project_id: projectId,
    name: file.name,
    storage_path: path,
    size_bytes: file.size,
    uploaded_by: userData.user?.id ?? null,
  };

  const { data, error } = await supabase
    .from('models')
    .insert({ ...base, purpose })
    .select(COLS)
    .single();
  if (!error) return data;

  // 0016 미적용 폴백: purpose 없이 등록(모두 통합모델로 취급).
  const legacy = await supabase.from('models').insert(base).select(COLS_LEGACY).single();
  if (legacy.error) {
    await supabase.storage.from(BUCKET).remove([path]); // 고아 오브젝트 정리
    throw legacy.error;
  }
  return { ...legacy.data, purpose: 'integrated' as ModelPurpose };
}

/**
 * Download the IFC bytes for a stored model (RLS-checked signed access).
 * `bucket` lets CDE-linked models read from the shared 'docs' bucket where
 * file versions live; legacy models stay in the 'models' bucket (default).
 */
export async function downloadModelBytes(
  storagePath: string,
  bucket: string = BUCKET,
): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}
