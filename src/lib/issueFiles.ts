import { supabase } from './supabase';
import { logIssueEvent } from './issues';

// =====================================================================
// 이슈 첨부 = 자료관리(ACC) 파일 링크 (migration 0035_issue_file_link.sql).
// 개인 파일 직접 업로드 대신 ACC 에 있는 파일만 링크한다. 폴더 경로(조상 id/이름
// 체인)를 함께 저장해 자료관리 해당 폴더로 딥링크 이동한다.
// =====================================================================

export interface IssueFileLink {
  id: string;
  issue_id: string;
  acc_project_id: string;
  acc_item_id: string;
  acc_urn: string | null;
  name: string;
  folder_id: string | null;
  folder_ids: string[];
  folder_names: string[];
  added_by_name: string | null;
  created_at: string;
}

const COLS =
  'id, issue_id, acc_project_id, acc_item_id, acc_urn, name, folder_id, folder_ids, folder_names, added_by_name, created_at';

export async function listIssueFiles(issueId: string): Promise<IssueFileLink[]> {
  const { data, error } = await supabase
    .from('issue_file_link')
    .select(COLS)
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ...r,
    folder_ids: (r.folder_ids as string[]) ?? [],
    folder_names: (r.folder_names as string[]) ?? [],
  })) as IssueFileLink[];
}

export interface AddIssueFileInput {
  projectId: string;
  issueId: string;
  accProjectId: string;
  accItemId: string;
  accUrn?: string | null;
  name: string;
  folderId?: string | null;
  folderIds: string[];
  folderNames: string[];
  addedByName?: string | null;
}

export async function addIssueFile(input: AddIssueFileInput): Promise<IssueFileLink> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('issue_file_link')
    .insert({
      project_id: input.projectId,
      issue_id: input.issueId,
      acc_project_id: input.accProjectId,
      acc_item_id: input.accItemId,
      acc_urn: input.accUrn ?? null,
      name: input.name,
      folder_id: input.folderId ?? null,
      folder_ids: input.folderIds,
      folder_names: input.folderNames,
      added_by: userData.user?.id ?? null,
      added_by_name: input.addedByName ?? null,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  await logIssueEvent(input.issueId, input.projectId, 'file_add', input.name, input.addedByName ?? null);
  return {
    ...(data as IssueFileLink),
    folder_ids: (data.folder_ids as string[]) ?? [],
    folder_names: (data.folder_names as string[]) ?? [],
  };
}

export async function removeIssueFile(id: string): Promise<void> {
  const { error } = await supabase.from('issue_file_link').delete().eq('id', id);
  if (error) throw error;
}
