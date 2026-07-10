import { createIssue, logIssueEvent } from './issues';
import type { IssuePriority } from './issues';
import type { IssueType, SiteTag } from './issueTypes';
import { uploadAttachment } from './attachments';

// =====================================================================
// 현장(모바일) 이슈 등록 — 오프라인 초안 큐 + 온라인 동기화.
// 네트워크가 없거나 등록이 실패하면 초안(사진 데이터URL 포함)을 localStorage 에
// 보관했다가, 온라인 복귀/페이지 진입 시 순서대로 서버에 올린다.
// 사진에는 GPS·촬영시각 태그(meta.site)를 함께 저장한다.
// =====================================================================

export interface IssueDraft {
  id: string;
  project_id: string;
  title: string;
  description: string;
  type: IssueType;
  priority: IssuePriority;
  meta: Record<string, unknown>;
  site: SiteTag | null;
  /** 사진 데이터URL(다운스케일 JPEG) — 용량 보호를 위해 축소 저장. */
  photo: string | null;
  photo_name: string | null;
  created_at: string;
}

const KEY = (projectId: string) => `mir.issue.drafts.${projectId}`;

export function listDrafts(projectId: string): IssueDraft[] {
  try {
    const raw = localStorage.getItem(KEY(projectId));
    const arr = raw ? (JSON.parse(raw) as IssueDraft[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeDrafts(projectId: string, drafts: IssueDraft[]): void {
  try {
    if (drafts.length === 0) localStorage.removeItem(KEY(projectId));
    else localStorage.setItem(KEY(projectId), JSON.stringify(drafts));
  } catch {
    /* 용량 초과 등 — 초안 저장은 편의 레이어 */
  }
}

export function saveDraft(projectId: string, draft: Omit<IssueDraft, 'id' | 'created_at'>): IssueDraft {
  const item: IssueDraft = {
    ...draft,
    id: `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
  };
  writeDrafts(projectId, [...listDrafts(projectId), item]);
  return item;
}

export function removeDraft(projectId: string, id: string): void {
  writeDrafts(projectId, listDrafts(projectId).filter((d) => d.id !== id));
}

/** 데이터URL → File (첨부 업로드용). */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:(.*?);/.exec(head)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/** 사진 파일을 최대 변 maxDim 으로 다운스케일한 JPEG 데이터URL 로 변환. */
export async function photoToDataUrl(file: File, maxDim = 1280, quality = 0.8): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('이미지를 읽을 수 없습니다'));
      el.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 현재 위치(GPS) — 실패/거부 시 null (현장 태깅은 선택 정보). */
export function getSiteTag(timeoutMs = 5000): Promise<SiteTag | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          taken_at: new Date().toISOString(),
        }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** 초안 1건을 서버에 등록(이슈 생성 + 사진 첨부). 성공 시 큐에서 제거. */
async function syncOne(draft: IssueDraft, authorName: string | null): Promise<void> {
  const meta = { ...draft.meta };
  if (draft.site) meta.site = draft.site;
  const issueId = await createIssue(
    draft.project_id,
    {
      title: draft.title,
      description: draft.description || undefined,
      type: draft.type,
      meta,
      priority: draft.priority,
    },
    authorName,
  );
  if (draft.photo) {
    const file = dataUrlToFile(draft.photo, draft.photo_name || `site_${Date.now()}.jpg`);
    await uploadAttachment(draft.project_id, 'issue', issueId, file);
    await logIssueEvent(issueId, draft.project_id, 'file_add', file.name, authorName);
  }
  removeDraft(draft.project_id, draft.id);
}

/** 보관된 초안 전부 동기화 시도. 성공 건수를 돌려준다(실패 건은 큐에 남음). */
export async function syncDrafts(projectId: string, authorName: string | null): Promise<number> {
  if (!navigator.onLine) return 0;
  let ok = 0;
  for (const d of listDrafts(projectId)) {
    try {
      await syncOne(d, authorName);
      ok++;
    } catch {
      break; // 네트워크 등 공통 원인일 가능성 — 다음 기회에 재시도
    }
  }
  return ok;
}
