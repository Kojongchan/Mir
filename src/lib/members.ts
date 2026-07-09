import { supabase } from './supabase';

// =====================================================================
// 프로젝트 구성원 조회 (담당자 배정용). profiles RLS = 본인 + admin 이므로
// 전체 목록은 관리자만 받을 수 있다(담당자 배정은 admin 전용이라 충분).
// =====================================================================

export interface ProjectMember {
  id: string;
  name: string; // full_name ?? username
  company: string | null; // 소속(발주처/감리단/시공사/BIM 협력업체 …), 0034
  duty: string | null; // 담당업무(현장 공무팀/BIM 관리자 …), 0034
}

/** 드롭다운 표기: "표시이름 - 소속 - 담당업무"(있는 것만). */
export function memberLabel(m: ProjectMember): string {
  return [m.name, m.company, m.duty].filter(Boolean).join(' - ');
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  // 0034(company/duty) 미적용 환경에서도 동작하도록 폴백.
  type MemberOrgRow = { user_id: string; company?: string | null; duty?: string | null };
  let rows: MemberOrgRow[] = [];
  const withOrg = await supabase
    .from('project_members')
    .select('user_id, company, duty')
    .eq('project_id', projectId);
  if (withOrg.error) {
    const base = await supabase.from('project_members').select('user_id').eq('project_id', projectId);
    if (base.error) throw base.error;
    rows = (base.data ?? []) as MemberOrgRow[];
  } else {
    rows = (withOrg.data ?? []) as MemberOrgRow[];
  }
  const ids = rows.map((m) => m.user_id);
  if (ids.length === 0) return [];
  const orgById = new Map(rows.map((m) => [m.user_id, m]));

  const { data: profs, error: pErr } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .in('id', ids);
  if (pErr) throw pErr;

  return (profs ?? [])
    .map((p) => ({
      id: p.id as string,
      name: (p.full_name as string) || (p.username as string),
      company: orgById.get(p.id as string)?.company ?? null,
      duty: orgById.get(p.id as string)?.duty ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
