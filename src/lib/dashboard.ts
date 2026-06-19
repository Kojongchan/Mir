import { supabase } from './supabase';

// =====================================================================
// 사업관리 포털 — 사업개요 대시보드 데이터층 (Phase 11 / S21).
// All figures are editable in-app and stored in Supabase (migration 0006).
// =====================================================================

export interface ProjectInfo {
  project_id: string;
  start_date: string | null;
  end_date: string | null;
  progress_pct: number;
  summary: string | null;
  updated_at: string;
}

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  sort_order: number;
}

export interface DailyLog {
  id: string;
  project_id: string;
  log_date: string;
  manpower: number;
  equipment: number;
  weather: string | null;
  content: string | null;
  created_at: string;
}

export interface MonthlyRecord {
  id: string;
  project_id: string;
  ym: string;
  planned_pct: number;
  actual_pct: number;
  billing_amount: number;
}

// ---------- project_info --------------------------------------------

export async function getProjectInfo(projectId: string): Promise<ProjectInfo | null> {
  const { data, error } = await supabase
    .from('project_info')
    .select('project_id, start_date, end_date, progress_pct, summary, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveProjectInfo(
  projectId: string,
  patch: Partial<Omit<ProjectInfo, 'project_id' | 'updated_at'>>,
): Promise<void> {
  const { error } = await supabase
    .from('project_info')
    .upsert(
      { project_id: projectId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'project_id' },
    );
  if (error) throw error;
}

// ---------- milestones ----------------------------------------------

export async function listMilestones(projectId: string): Promise<Milestone[]> {
  const { data, error } = await supabase
    .from('project_milestones')
    .select('id, project_id, name, target_date, sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('target_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function addMilestone(
  projectId: string,
  name: string,
  targetDate: string | null,
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase
    .from('project_milestones')
    .insert({ project_id: projectId, name, target_date: targetDate, sort_order: sortOrder });
  if (error) throw error;
}

export async function deleteMilestone(id: string): Promise<void> {
  const { error } = await supabase.from('project_milestones').delete().eq('id', id);
  if (error) throw error;
}

/** Persist a new ordering — sort_order becomes the array index. */
export async function reorderMilestones(orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, i) =>
      supabase.from('project_milestones').update({ sort_order: i }).eq('id', id),
    ),
  );
}

// ---------- daily_logs ----------------------------------------------

export async function listDailyLogs(projectId: string, limit = 60): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from('daily_logs')
    .select('id, project_id, log_date, manpower, equipment, weather, content, created_at')
    .eq('project_id', projectId)
    .order('log_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function addDailyLog(
  projectId: string,
  log: { log_date: string; manpower: number; equipment: number; weather?: string; content?: string },
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('daily_logs').insert({
    project_id: projectId,
    log_date: log.log_date,
    manpower: log.manpower,
    equipment: log.equipment,
    weather: log.weather ?? null,
    content: log.content ?? null,
    created_by: userData.user?.id ?? null,
  });
  if (error) throw error;
}

export async function deleteDailyLog(id: string): Promise<void> {
  const { error } = await supabase.from('daily_logs').delete().eq('id', id);
  if (error) throw error;
}

// ---------- monthly_records -----------------------------------------

export async function listMonthlyRecords(projectId: string): Promise<MonthlyRecord[]> {
  const { data, error } = await supabase
    .from('monthly_records')
    .select('id, project_id, ym, planned_pct, actual_pct, billing_amount')
    .eq('project_id', projectId)
    .order('ym', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function saveMonthlyRecord(
  projectId: string,
  ym: string,
  patch: { planned_pct: number; actual_pct: number; billing_amount: number },
): Promise<void> {
  const { error } = await supabase
    .from('monthly_records')
    .upsert({ project_id: projectId, ym, ...patch }, { onConflict: 'project_id,ym' });
  if (error) throw error;
}

export async function deleteMonthlyRecord(id: string): Promise<void> {
  const { error } = await supabase.from('monthly_records').delete().eq('id', id);
  if (error) throw error;
}

// ---------- date / format helpers -----------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `date` until today (positive = in the past). */
export function daysSince(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - d.getTime()) / DAY_MS);
}

/** Whole days from today until `date` (positive = in the future). */
export function daysUntil(date: string | null): number | null {
  const since = daysSince(date);
  return since === null ? null : -since;
}

/** D-day label, e.g. 'D-142' (future), 'D+30' (past), 'D-DAY' (today). */
export function ddayLabel(date: string | null): string {
  const until = daysUntil(date);
  if (until === null) return '—';
  if (until === 0) return 'D-DAY';
  return until > 0 ? `D-${until}` : `D+${-until}`;
}

export function formatDate(date: string | null): string {
  if (!date) return '미정';
  return new Date(date + 'T00:00:00').toLocaleDateString('ko-KR');
}

export function formatAmount(won: number): string {
  if (!won) return '0';
  if (won >= 1e8) return `${(won / 1e8).toFixed(1)}억`;
  if (won >= 1e4) return `${Math.round(won / 1e4).toLocaleString()}만`;
  return won.toLocaleString();
}

export function todayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
