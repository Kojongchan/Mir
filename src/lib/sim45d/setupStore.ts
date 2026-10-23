import { supabase } from '../supabase';
import { isSetupError } from '../errors';
import { normalizeSetup, type SetupData } from './setup';

/**
 * 공정·공사비 단계형 진행 상태 저장(0040 sim45d_setup). 마이그레이션이 아직 적용되지 않았으면
 * 이 브라우저에만 저장하고(where = 'local') 화면에 알린다.
 */
export interface SetupRecord {
  id: string;
  name: string;
  data: SetupData;
  updatedAt: string;
}
export type SetupWhere = 'db' | 'local';

const TABLE = 'sim45d_setup';
const localKey = (projectId: string) => `mir.sim45d.setups.${projectId}`;

function readLocal(projectId: string): SetupRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(localKey(projectId)) ?? '[]');
    return Array.isArray(v)
      ? v.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string')
        .map(r => ({ id: r.id, name: r.name, data: normalizeSetup(r.data), updatedAt: String(r.updatedAt ?? '') }))
      : [];
  } catch { return []; }
}
function writeLocal(projectId: string, records: SetupRecord[]) {
  try { localStorage.setItem(localKey(projectId), JSON.stringify(records)); } catch { /* 비공개 창 등 */ }
}

const byRecent = (a: SetupRecord, b: SetupRecord) => b.updatedAt.localeCompare(a.updatedAt);

export async function listSetups(projectId: string): Promise<{ records: SetupRecord[]; where: SetupWhere }> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, name, data, updated_at')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false });
  if (error) {
    if (isSetupError(error)) return { records: readLocal(projectId).sort(byRecent), where: 'local' };
    throw error;
  }
  return {
    records: (data ?? []).map(r => ({ id: r.id as string, name: r.name as string, data: normalizeSetup(r.data), updatedAt: r.updated_at as string })),
    where: 'db',
  };
}

export async function createSetup(projectId: string, name: string, data: SetupData, where: SetupWhere): Promise<SetupRecord> {
  const now = new Date().toISOString();
  if (where === 'local') {
    const rec = { id: `local-${Date.now().toString(36)}`, name: name.trim(), data, updatedAt: now };
    writeLocal(projectId, [rec, ...readLocal(projectId)]);
    return rec;
  }
  const { data: row, error } = await supabase
    .from(TABLE)
    .insert({ project_id: projectId, name: name.trim(), data })
    .select('id, name, data, updated_at')
    .single();
  if (error) throw error.code === '23505' ? new Error(`같은 이름의 대상이 이미 있습니다: ${name.trim()}`) : error;
  return { id: row.id, name: row.name, data: normalizeSetup(row.data), updatedAt: row.updated_at };
}

export async function saveSetup(projectId: string, rec: SetupRecord, where: SetupWhere): Promise<SetupRecord> {
  const now = new Date().toISOString();
  if (where === 'local') {
    const next = { ...rec, updatedAt: now };
    writeLocal(projectId, [next, ...readLocal(projectId).filter(r => r.id !== rec.id)]);
    return next;
  }
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from(TABLE)
    .update({ name: rec.name.trim(), data: rec.data, updated_at: now, updated_by: userData.user?.id ?? null })
    .eq('id', rec.id);
  if (error) throw error;
  return { ...rec, updatedAt: now };
}

export async function deleteSetup(projectId: string, id: string, where: SetupWhere): Promise<void> {
  if (where === 'local') {
    writeLocal(projectId, readLocal(projectId).filter(r => r.id !== id));
    return;
  }
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}
