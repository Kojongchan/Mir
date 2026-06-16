// =====================================================================
// MIR_VDC — S2 admin console data layer.
//
// Project & membership management run straight against Supabase: RLS
// (0002_admin.sql) lets the authenticated admin write these tables.
// User creation / deletion / password reset need the service_role key,
// so they go through the serverless function at /api/admin instead.
// =====================================================================
import { supabase } from './supabase';
import type { Project } from './api';

export type MemberRole = 'viewer' | 'editor' | 'admin';
export const MEMBER_ROLES: MemberRole[] = ['viewer', 'editor', 'admin'];

export interface ProfileRow {
  id: string;
  username: string;
  full_name: string | null;
  is_admin: boolean;
}

export interface MemberRow {
  user_id: string;
  role: MemberRole;
}

// ---------- profiles (users) -----------------------------------------

/** All user profiles (admins see every row via RLS). */
export async function listProfiles(): Promise<ProfileRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, full_name, is_admin')
    .order('username');
  if (error) throw error;
  return data ?? [];
}

/** Toggle the global admin flag for a user. */
export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  const { error } = await supabase.from('profiles').update({ is_admin: isAdmin }).eq('id', userId);
  if (error) throw error;
}

// ---------- projects --------------------------------------------------

export async function createProject(name: string, code: string | null): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name, code: code || null })
    .select('id, name, code')
    .single();
  if (error) throw error;
  return data;
}

export async function updateProject(
  id: string,
  fields: { name: string; code: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ name: fields.name, code: fields.code || null })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

// ---------- memberships ----------------------------------------------

export async function listMembers(projectId: string): Promise<MemberRow[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select('user_id, role')
    .eq('project_id', projectId);
  if (error) throw error;
  return (data ?? []) as MemberRow[];
}

/** Add a user to a project, or update their role if already a member. */
export async function setMember(
  projectId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const { error } = await supabase
    .from('project_members')
    .upsert({ project_id: projectId, user_id: userId, role }, { onConflict: 'project_id,user_id' });
  if (error) throw error;
}

export async function removeMember(projectId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ---------- privileged user ops (serverless /api/admin) --------------

async function adminFn<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('로그인이 필요합니다.');

  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });

  let out: { error?: string } & Record<string, unknown> = {};
  try {
    out = await res.json();
  } catch {
    /* non-JSON (e.g. 404 when running `vite` without the function) */
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('사용자 관리 API(/api/admin)를 찾을 수 없습니다. 배포 환경(Vercel) 또는 `vercel dev`에서 사용하세요.');
    }
    throw new Error(out.error || `요청 실패 (${res.status})`);
  }
  return out as T;
}

export function createUserAccount(
  username: string,
  password: string,
  fullName: string,
  isAdmin: boolean,
): Promise<{ ok: true; user: ProfileRow }> {
  return adminFn('createUser', { username, password, fullName, isAdmin });
}

export function deleteUserAccount(userId: string): Promise<{ ok: true }> {
  return adminFn('deleteUser', { userId });
}

export function resetUserPassword(userId: string, password: string): Promise<{ ok: true }> {
  return adminFn('resetPassword', { userId, password });
}
