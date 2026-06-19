import { supabase } from './supabase';

// =====================================================================
// 포털 모듈 확장 데이터층 (Phase 13 / S23): 게시판 · 하도급 · 기성(도급액).
// 기성 월별 데이터는 lib/dashboard.ts 의 monthly_records 를 재사용한다.
// =====================================================================

// ---------- 게시판 / 공지 --------------------------------------------

export interface Post {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  pinned: boolean;
  author_name: string | null;
  created_at: string;
}

export async function listPosts(projectId: string): Promise<Post[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('id, project_id, title, body, pinned, author_name, created_at')
    .eq('project_id', projectId)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createPost(
  projectId: string,
  input: { title: string; body?: string; pinned?: boolean },
  authorName: string | null,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from('posts').insert({
    project_id: projectId,
    title: input.title,
    body: input.body ?? null,
    pinned: input.pinned ?? false,
    author_name: authorName,
    created_by: userData.user?.id ?? null,
  });
  if (error) throw error;
}

export async function deletePost(id: string): Promise<void> {
  const { error } = await supabase.from('posts').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 하도급(협력사) -------------------------------------------

export type SubStatus = 'active' | 'done' | 'terminated';
export const SUB_STATUS_LABEL: Record<SubStatus, string> = {
  active: '진행중',
  done: '완료',
  terminated: '해지',
};

export interface Subcontract {
  id: string;
  project_id: string;
  company: string;
  trade: string | null;
  contract_amount: number;
  paid_amount: number;
  start_date: string | null;
  end_date: string | null;
  status: SubStatus;
  note: string | null;
}

export async function listSubcontracts(projectId: string): Promise<Subcontract[]> {
  const { data, error } = await supabase
    .from('subcontracts')
    .select('id, project_id, company, trade, contract_amount, paid_amount, start_date, end_date, status, note')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Subcontract[];
}

export async function createSubcontract(
  projectId: string,
  input: Omit<Subcontract, 'id' | 'project_id'>,
): Promise<void> {
  const { error } = await supabase.from('subcontracts').insert({ project_id: projectId, ...input });
  if (error) throw error;
}

export async function deleteSubcontract(id: string): Promise<void> {
  const { error } = await supabase.from('subcontracts').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 도급액(기성률 계산) --------------------------------------
// project_info 의 contract_amount 만 따로 읽고/저장한다(대시보드 select 와 분리해
// 0008 미적용 환경에서도 대시보드가 깨지지 않도록 한다).

export async function getContractAmount(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from('project_info')
    .select('contract_amount')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.contract_amount) : 0;
}

export async function saveContractAmount(projectId: string, amount: number): Promise<void> {
  const { error } = await supabase
    .from('project_info')
    .upsert(
      { project_id: projectId, contract_amount: amount, updated_at: new Date().toISOString() },
      { onConflict: 'project_id' },
    );
  if (error) throw error;
}
