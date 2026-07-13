import { supabase } from './supabase';
import type { MarkupShape } from './viewpoints';

// =====================================================================
// 이슈 3D 뷰포인트/마크업 첨부 데이터층 (0038 issue_viewpoints).
// APS 뷰어의 카메라 state(getState JSON) + 정규화 마크업 도형 + 스냅샷(데이터URL)
// 을 이슈에 저장해 협의 근거 화면이 이슈에 잔존한다. 열람 시 restoreState 로 복원.
// RLS: 읽기 = 멤버, 쓰기 = 실무자(is_editor). 0038 미적용이면 목록은 빈 배열.
// =====================================================================

export interface IssueViewpoint {
  id: string;
  issue_id: string;
  project_id: string;
  title: string | null;
  camera_state: unknown | null;
  markup: MarkupShape[];
  snapshot: string | null;
  created_by_name: string | null;
  created_at: string;
}

const COLS = 'id, issue_id, project_id, title, camera_state, markup, snapshot, created_by_name, created_at';

export async function listIssueViewpoints(issueId: string): Promise<IssueViewpoint[]> {
  const { data, error } = await supabase
    .from('issue_viewpoints')
    .select(COLS)
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) return []; // 0038 미적용 폴백 — 뷰포인트 섹션만 비어 보인다.
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as IssueViewpoint),
    markup: Array.isArray(r.markup) ? (r.markup as MarkupShape[]) : [],
  }));
}

export async function addIssueViewpoint(input: {
  issueId: string;
  projectId: string;
  title?: string | null;
  cameraState: unknown | null;
  markup?: MarkupShape[];
  snapshot?: string | null;
  authorName?: string | null;
}): Promise<IssueViewpoint> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('issue_viewpoints')
    .insert({
      issue_id: input.issueId,
      project_id: input.projectId,
      title: input.title ?? null,
      camera_state: input.cameraState ?? null,
      markup: input.markup ?? [],
      snapshot: input.snapshot ?? null,
      created_by: userData.user?.id ?? null,
      created_by_name: input.authorName ?? null,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return data as unknown as IssueViewpoint;
}

export async function removeIssueViewpoint(id: string): Promise<void> {
  const { error } = await supabase.from('issue_viewpoints').delete().eq('id', id);
  if (error) throw error;
}

/** 뷰포인트의 마크업(도형)만 갱신 — 이슈 상세에서 스냅샷 위에 그린다. */
export async function updateIssueViewpointMarkup(id: string, markup: MarkupShape[]): Promise<void> {
  const { error } = await supabase.from('issue_viewpoints').update({ markup }).eq('id', id);
  if (error) throw error;
}

/**
 * APS 뷰어 현재 화면을 다운스케일 JPEG 데이터URL 로 캡처(getScreenShot).
 * 실패하면 null — 스냅샷은 편의 레이어라 뷰포인트 저장 자체는 계속된다.
 */
export function captureApsSnapshot(viewer: unknown, w = 640, h = 360): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      (viewer as { getScreenShot: (w: number, h: number, cb: (blobUrl: string) => void) => void }).getScreenShot(
        w,
        h,
        (blobUrl: string) => {
          const img = new Image();
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              canvas.getContext('2d')!.drawImage(img, 0, 0);
              resolve(canvas.toDataURL('image/jpeg', 0.75));
            } catch {
              resolve(null);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          };
          img.onerror = () => resolve(null);
          img.src = blobUrl;
        },
      );
    } catch {
      resolve(null);
    }
  });
}
