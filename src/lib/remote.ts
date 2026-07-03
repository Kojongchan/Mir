import { supabase } from './supabase';

// =====================================================================
// R11 — 원격지원 세션 아카이브 데이터층. 링크 + 캡처(attachments) 저장·조회.
// RLS 쓰기 = is_editor.
// =====================================================================

export interface RemoteSession {
  id: string;
  project_id: string;
  title: string;
  link: string | null;
  platform: string | null;
  held_at: string;
  participants: string | null;
  summary: string | null;
  created_by_name: string | null;
  created_at: string;
}

const COLS =
  'id, project_id, title, link, platform, held_at, participants, summary, created_by_name, created_at';

export async function listRemoteSessions(projectId: string): Promise<RemoteSession[]> {
  const { data, error } = await supabase
    .from('remote_session')
    .select(COLS)
    .eq('project_id', projectId)
    .order('held_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as RemoteSession[];
}

export interface RemoteSessionInput {
  title: string;
  link?: string | null;
  platform?: string | null;
  held_at?: string | null;
  participants?: string | null;
  summary?: string | null;
}

export async function createRemoteSession(projectId: string, input: RemoteSessionInput, authorName: string | null): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('remote_session')
    .insert({
      project_id: projectId,
      title: input.title,
      link: input.link || null,
      platform: input.platform || null,
      held_at: input.held_at || new Date().toISOString(),
      participants: input.participants || null,
      summary: input.summary || null,
      created_by: userData.user?.id ?? null,
      created_by_name: authorName,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function deleteRemoteSession(id: string): Promise<void> {
  const { error } = await supabase.from('remote_session').delete().eq('id', id);
  if (error) throw error;
}
