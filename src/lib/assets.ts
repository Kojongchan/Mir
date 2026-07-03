import { supabase } from './supabase';

// =====================================================================
// R10 — QR 자재·자산 태깅 데이터층.
// 자재/자산 CRUD + QR 페이로드(딥링크) 생성/파싱. QR 이미지는 qrcode(무료),
// 스캔은 브라우저 native BarcodeDetector(무비용). 시험성적서는 attachments 재사용.
// =====================================================================

export type AssetStatus = 'received' | 'installed' | 'inspected' | 'defect';
export const ASSET_STATUSES: AssetStatus[] = ['received', 'installed', 'inspected', 'defect'];
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  received: '반입',
  installed: '설치',
  inspected: '검사완료',
  defect: '불량',
};

export interface Asset {
  id: string;
  project_id: string;
  asset_no: number;
  name: string;
  category: string | null;
  manufacturer: string | null;
  spec: string | null;
  received_at: string | null;
  install_location: string | null;
  status: AssetStatus;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  'id, project_id, asset_no, name, category, manufacturer, spec, received_at, install_location, status, note, created_by_name, created_at, updated_at';

export async function listAssets(projectId: string): Promise<Asset[]> {
  const { data, error } = await supabase
    .from('asset')
    .select(COLS)
    .eq('project_id', projectId)
    .order('asset_no', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Asset[];
}

export async function getAsset(id: string): Promise<Asset | null> {
  const { data, error } = await supabase.from('asset').select(COLS).eq('id', id).maybeSingle();
  if (error) return null;
  return (data as Asset) ?? null;
}

export interface AssetInput {
  name: string;
  category?: string | null;
  manufacturer?: string | null;
  spec?: string | null;
  received_at?: string | null;
  install_location?: string | null;
  status?: AssetStatus;
  note?: string | null;
}

export async function createAsset(projectId: string, input: AssetInput, authorName: string | null): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('asset')
    .insert({
      project_id: projectId,
      name: input.name,
      category: input.category || null,
      manufacturer: input.manufacturer || null,
      spec: input.spec || null,
      received_at: input.received_at || null,
      install_location: input.install_location || null,
      status: input.status ?? 'received',
      note: input.note || null,
      created_by: userData.user?.id ?? null,
      created_by_name: authorName,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateAsset(id: string, patch: Partial<AssetInput>): Promise<void> {
  const { error } = await supabase.from('asset').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function deleteAsset(id: string): Promise<void> {
  const { error } = await supabase.from('asset').delete().eq('id', id);
  if (error) throw error;
}

// ---------- QR 페이로드 (딥링크) -------------------------------------

/** QR 에 인코딩할 URL — 스캔 시 이 자산 상세로 이동. */
export function assetQrPayload(projectId: string, assetId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/project/${projectId}/assets?asset=${assetId}`;
}

/** 스캔된 텍스트에서 assetId 추출(URL 또는 원시 UUID 모두 허용). */
export function parseAssetScan(text: string): string | null {
  try {
    const u = new URL(text);
    const a = u.searchParams.get('asset');
    if (a) return a;
    const m = u.pathname.match(/assets?\/?([0-9a-f-]{36})/i);
    if (m) return m[1];
  } catch {
    /* URL 아님 — 원시 UUID 시도 */
  }
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : null;
}
