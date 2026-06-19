import { supabase } from './supabase';

// =====================================================================
// 프로젝트 구성원 조회 (담당자 배정용). profiles RLS = 본인 + admin 이므로
// 전체 목록은 관리자만 받을 수 있다(담당자 배정은 admin 전용이라 충분).
// =====================================================================

export interface ProjectMember {
  id: string;
  name: string; // full_name ?? username
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const { data: members, error: mErr } = await supabase
    .from('project_members')
    .select('user_id')
    .eq('project_id', projectId);
  if (mErr) throw mErr;
  const ids = (members ?? []).map((m) => m.user_id as string);
  if (ids.length === 0) return [];

  const { data: profs, error: pErr } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .in('id', ids);
  if (pErr) throw pErr;

  return (profs ?? [])
    .map((p) => ({ id: p.id as string, name: (p.full_name as string) || (p.username as string) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
