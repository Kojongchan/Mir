import { supabase } from './supabase';

export interface Project {
  id: string;
  name: string;
  code: string | null;
}

/** 프로젝트별 ACC(Autodesk) 고정 매핑 (0020). 미적용 시 전부 null 폴백. */
export interface ProjectAcc {
  acc_hub_id: string | null;
  acc_project_id: string | null;
  acc_default_urn: string | null;
  acc_default_name: string | null;
  acc_root_folder_id: string | null;
  acc_root_folder_name: string | null;
}

const EMPTY_ACC: ProjectAcc = {
  acc_hub_id: null,
  acc_project_id: null,
  acc_default_urn: null,
  acc_default_name: null,
  acc_root_folder_id: null,
  acc_root_folder_name: null,
};

/** 관리자가 고정한 ACC 허브/프로젝트/시작폴더/기본모델을 읽는다(미적용 시 null). */
export async function getProjectAcc(projectId: string): Promise<ProjectAcc> {
  const { data, error } = await supabase
    .from('projects')
    .select('acc_hub_id, acc_project_id, acc_default_urn, acc_default_name, acc_root_folder_id, acc_root_folder_name')
    .eq('id', projectId)
    .single();
  if (error || !data) return EMPTY_ACC; // 0020 미적용 폴백
  return { ...EMPTY_ACC, ...(data as Partial<ProjectAcc>) };
}

/** ACC 매핑 저장(관리자만 — projects update RLS). */
export async function setProjectAcc(projectId: string, fields: Partial<ProjectAcc>): Promise<void> {
  const { error } = await supabase.from('projects').update(fields).eq('id', projectId);
  if (error) throw error;
}

export type ModelPurpose = 'integrated' | '4d' | 'clash';

export interface ModelRecord {
  id: string;
  project_id: string;
  name: string;
  storage_path: string;
  size_bytes: number | null;
  purpose: ModelPurpose;
  /** Storage bucket holding the IFC bytes: 'models' (legacy) or 'docs' (CDE-linked). */
  bucket: string;
  /** When set, this model is mirrored from a CDE BIM file (S45 Phase B). */
  file_id: string | null;
  version_id: string | null;
  created_at: string;
}

const BUCKET = 'models';

/** Fill in 0019 columns when a fallback query couldn't select them. */
function normalizeModel(r: Record<string, unknown>): ModelRecord {
  return {
    bucket: 'models',
    file_id: null,
    version_id: null,
    purpose: 'integrated',
    ...r,
  } as ModelRecord;
}

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
const COLS =
  'id, project_id, name, storage_path, size_bytes, purpose, bucket, file_id, version_id, created_at';
const COLS_PURPOSE = 'id, project_id, name, storage_path, size_bytes, purpose, created_at';
const COLS_LEGACY = 'id, project_id, name, storage_path, size_bytes, created_at';

export async function listModels(projectId: string, purpose?: ModelPurpose): Promise<ModelRecord[]> {
  let query = supabase.from('models').select(COLS).eq('project_id', projectId);
  if (purpose) query = query.eq('purpose', purpose);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (!error) return (data ?? []).map((r) => normalizeModel(r));

  // 0019 미적용(bucket/file_id 등 컬럼 없음) → purpose 만으로 폴백.
  let q2 = supabase.from('models').select(COLS_PURPOSE).eq('project_id', projectId);
  if (purpose) q2 = q2.eq('purpose', purpose);
  const r2 = await q2.order('created_at', { ascending: false });
  if (!r2.error) return (r2.data ?? []).map((r) => normalizeModel(r));

  // 0016 미적용(purpose 컬럼 없음) → 레거시 조회로 폴백: 모든 모델을
  // 'integrated' 로 간주. 통합모델은 그대로 보이고, 4d/clash 는 빈 목록.
  const legacy = await supabase
    .from('models')
    .select(COLS_LEGACY)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (legacy.error) throw error;
  const rows = (legacy.data ?? []).map((r) => normalizeModel(r));
  return purpose && purpose !== 'integrated' ? [] : rows;
}

/** A single model by id (any purpose) — used by issue "위치 보기" to open the
 *  linked model even when it isn't in the current module's filtered list. */
export async function getModel(modelId: string): Promise<ModelRecord | null> {
  const { data, error } = await supabase.from('models').select(COLS).eq('id', modelId).single();
  if (!error) return normalizeModel(data);
  const p = await supabase.from('models').select(COLS_PURPOSE).eq('id', modelId).single();
  if (!p.error) return normalizeModel(p.data);
  const legacy = await supabase.from('models').select(COLS_LEGACY).eq('id', modelId).single();
  if (legacy.error) return null;
  return normalizeModel(legacy.data);
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
  if (!error) return normalizeModel(data);

  // 0016 미적용 폴백: purpose 없이 등록(모두 통합모델로 취급).
  const legacy = await supabase.from('models').insert(base).select(COLS_LEGACY).single();
  if (legacy.error) {
    await supabase.storage.from(BUCKET).remove([path]); // 고아 오브젝트 정리
    throw legacy.error;
  }
  return normalizeModel(legacy.data);
}

// --------------------------------------------------------------------------
// CDE BIM ↔ 통합모델 연동 (S45 Phase B)
// BIM 폴더에 올린 IFC 는 docs 버킷에 버전과 함께 저장되고, 그 파일을 가리키는
// models 행(purpose='integrated', bucket='docs')을 하나 둔다 → 기존 통합모델/
// 4D/간섭/이슈 파이프라인(models.id 참조)을 그대로 재사용. 별도 업로드 불필요.
// --------------------------------------------------------------------------

interface BimFileLike {
  id: string;
  project_id: string;
  name: string;
  // CDE 파일은 ACC 일원화 후 storage_path 가 nullable 이지만, BIM IFC 연동은
  // 항상 docs 버킷 경로를 가진 supabase 파일에서만 호출된다(null 아님).
  storage_path: string | null;
  size_bytes: number | null;
  current_version_id: string | null;
}

/**
 * Create/refresh the integrated `models` row mirroring a CDE BIM file's current
 * version. Idempotent per file_id: a new CDE version just repoints the row so the
 * 3D viewer shows the latest on next load. Returns the synced model row.
 */
export async function syncBimModel(file: BimFileLike): Promise<ModelRecord> {
  const { data: existing } = await supabase
    .from('models')
    .select('id')
    .eq('file_id', file.id)
    .maybeSingle();

  const fields = {
    project_id: file.project_id,
    name: file.name,
    storage_path: file.storage_path,
    size_bytes: file.size_bytes,
    purpose: 'integrated' as ModelPurpose,
    bucket: 'docs',
    file_id: file.id,
    version_id: file.current_version_id,
  };

  if (existing) {
    const { data, error } = await supabase
      .from('models')
      .update(fields)
      .eq('id', existing.id)
      .select(COLS)
      .single();
    if (error) throw error;
    return normalizeModel(data);
  }
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('models')
    .insert({ ...fields, uploaded_by: userData.user?.id ?? null })
    .select(COLS)
    .single();
  if (error) throw error;
  return normalizeModel(data);
}

/** Remove the integrated model row mirroring a CDE BIM file (file deleted). */
export async function deleteBimModel(fileId: string): Promise<void> {
  await supabase.from('models').delete().eq('file_id', fileId);
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
