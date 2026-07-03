import { supabase } from './supabase';

// =====================================================================
// R12 — 관계사(company) + 구성원 다중역할(member_role) 데이터층.
// 접근권한(project_members.role)과 도메인 역할(태그)을 분리 관리한다.
// RLS 쓰기 = is_project_admin.
// =====================================================================

export type CompanyRoleType = '발주처' | '감리' | '시공' | '설계' | '협력사' | '기타';
export const COMPANY_ROLE_TYPES: CompanyRoleType[] = ['발주처', '감리', '시공', '설계', '협력사', '기타'];

export interface Company {
  id: string;
  project_id: string;
  name: string;
  role_type: CompanyRoleType;
  phone: string | null;
  manager: string | null;
  active: boolean;
  sort_order: number;
}

const COMPANY_COLS = 'id, project_id, name, role_type, phone, manager, active, sort_order';

export async function listCompanies(projectId: string): Promise<Company[]> {
  const { data, error } = await supabase
    .from('company')
    .select(COMPANY_COLS)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Company[];
}

export interface CompanyInput {
  name: string;
  role_type: CompanyRoleType;
  phone?: string | null;
  manager?: string | null;
  active?: boolean;
  sort_order?: number;
}

export async function saveCompany(projectId: string, id: string | null, input: CompanyInput): Promise<void> {
  const payload = {
    project_id: projectId,
    name: input.name,
    role_type: input.role_type,
    phone: input.phone || null,
    manager: input.manager || null,
    active: input.active ?? true,
    sort_order: input.sort_order ?? 0,
    updated_at: new Date().toISOString(),
  };
  if (id) {
    const { error } = await supabase.from('company').update(payload).eq('id', id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('company').insert(payload);
    if (error) throw error;
  }
}

export async function deleteCompany(id: string): Promise<void> {
  const { error } = await supabase.from('company').delete().eq('id', id);
  if (error) throw error;
}

// ---------- member_role (다중 도메인 역할 태그) ----------------------

export interface MemberRoleTag {
  id: string;
  user_id: string;
  role_tag: string;
}

/** 프로젝트의 도메인 역할 태그를 user_id 별로 묶어 반환. */
export async function listMemberRoles(projectId: string): Promise<Map<string, MemberRoleTag[]>> {
  const { data, error } = await supabase
    .from('member_role')
    .select('id, user_id, role_tag')
    .eq('project_id', projectId);
  if (error) throw error;
  const map = new Map<string, MemberRoleTag[]>();
  for (const r of data ?? []) {
    const arr = map.get(r.user_id) ?? [];
    arr.push(r as MemberRoleTag);
    map.set(r.user_id, arr);
  }
  return map;
}

export async function addMemberRole(projectId: string, userId: string, tag: string): Promise<void> {
  const { error } = await supabase.from('member_role').insert({ project_id: projectId, user_id: userId, role_tag: tag });
  if (error) throw error;
}

export async function removeMemberRole(id: string): Promise<void> {
  const { error } = await supabase.from('member_role').delete().eq('id', id);
  if (error) throw error;
}

/** 구성원 소속 회사 지정(project_members.company_id). */
export async function setMemberCompany(projectId: string, userId: string, companyId: string | null): Promise<void> {
  const { error } = await supabase
    .from('project_members')
    .update({ company_id: companyId })
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (error) throw error;
}

/** 구성원별 소속 회사 id 조회(user_id → company_id). */
export async function listMemberCompanies(projectId: string): Promise<Map<string, string | null>> {
  const { data, error } = await supabase
    .from('project_members')
    .select('user_id, company_id')
    .eq('project_id', projectId);
  if (error) throw error;
  const map = new Map<string, string | null>();
  for (const r of data ?? []) map.set(r.user_id, (r.company_id as string | null) ?? null);
  return map;
}

/** 자주 쓰는 도메인 역할 프리셋(자유 입력도 가능). */
export const ROLE_TAG_PRESETS = ['현장대리인', '안전관리자', '품질관리', '공무', '공사', '설계담당', '감리원', '발주담당'];

// ---------- 구성원 로스터(열람 전용) ---------------------------------
// 0042 로 project_members·profiles 를 같은 프로젝트 멤버가 읽을 수 있게 확장한
// 뒤라, 실무자·뷰어도 이 로스터를 볼 수 있다(쓰기는 여전히 프로젝트 관리자).

export type AccessRole = 'viewer' | 'editor' | 'admin';
export interface RosterEntry {
  user_id: string;
  name: string;
  role: AccessRole;
  company_id: string | null;
  company_name: string | null;
  tags: string[];
}

export async function listProjectRoster(projectId: string): Promise<RosterEntry[]> {
  const [{ data: members }, companies, roleMap] = await Promise.all([
    supabase.from('project_members').select('user_id, role, company_id').eq('project_id', projectId),
    listCompanies(projectId).catch(() => [] as Company[]),
    listMemberRoles(projectId).catch(() => new Map<string, MemberRoleTag[]>()),
  ]);
  const rows = members ?? [];
  const ids = rows.map((m) => m.user_id as string);
  const nameById = new Map<string, string>();
  if (ids.length) {
    const { data: profs } = await supabase.from('profiles').select('id, username, full_name').in('id', ids);
    for (const p of profs ?? []) nameById.set(p.id as string, (p.full_name as string) || (p.username as string) || '—');
  }
  const companyById = new Map(companies.map((c) => [c.id, c.name]));
  return rows
    .map((m) => ({
      user_id: m.user_id as string,
      name: nameById.get(m.user_id as string) ?? (m.user_id as string).slice(0, 8),
      role: (m.role as AccessRole) ?? 'viewer',
      company_id: (m.company_id as string | null) ?? null,
      company_name: m.company_id ? companyById.get(m.company_id as string) ?? null : null,
      tags: (roleMap.get(m.user_id as string) ?? []).map((t) => t.role_tag),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
