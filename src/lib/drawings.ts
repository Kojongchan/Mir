import { supabase } from './supabase';
import { extensionOf } from './files';

// =====================================================================
// 2D 도면(PDF/DXF) + 이슈 핀 데이터층 — Phase 11 / S41 (0018_drawings.sql).
// 바이너리는 'docs' 버킷의 '<project_id>/drawings/<id>.<ext>' 에 저장(0004 정책).
// 핀 좌표는 페이지/도면 정규화(0..1, 좌상단 원점)로 저장 → 해상도·줌과 무관(D16 동일 원칙).
// 쓰기는 admin(D11). DWG 직접열기는 변환 필요 → S17(APS)로 분리.
// =====================================================================

const BUCKET = 'docs';

export type DrawingKind = 'pdf' | 'dxf';

export interface Drawing {
  id: string;
  project_id: string;
  name: string;
  kind: DrawingKind;
  storage_path: string;
  page_count: number;
  created_by: string | null;
  created_at: string;
}

export interface DrawingPin {
  id: string;
  drawing_id: string;
  project_id: string;
  page: number;
  /** 정규화 좌표(0..1, 좌상단 원점). */
  x: number;
  y: number;
  label: string | null;
  issue_id: string | null;
  created_by: string | null;
  created_at: string;
}

const DRAWING_COLS = 'id, project_id, name, kind, storage_path, page_count, created_by, created_at';
const PIN_COLS = 'id, drawing_id, project_id, page, x, y, label, issue_id, created_by, created_at';

/** 도면 종류 추정(확장자). 지원 외는 null. */
export function drawingKindOf(fileName: string): DrawingKind | null {
  const ext = extensionOf(fileName).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'dxf') return 'dxf';
  return null;
}

export async function listDrawings(projectId: string): Promise<Drawing[]> {
  const { data, error } = await supabase
    .from('drawings')
    .select(DRAWING_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Drawing[];
}

/** 도면 파일 업로드 + 메타 등록. pageCount 는 호출측에서 계산(PDF=numPages, DXF=1). */
export async function createDrawing(input: {
  projectId: string;
  name: string;
  kind: DrawingKind;
  file: File;
  pageCount: number;
}): Promise<Drawing> {
  const id = crypto.randomUUID();
  const ext = extensionOf(input.file.name) || input.kind;
  const path = `${input.projectId}/drawings/${id}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, input.file, {
      contentType: input.file.type || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) throw upErr;

  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('drawings')
    .insert({
      id,
      project_id: input.projectId,
      name: input.name,
      kind: input.kind,
      storage_path: path,
      page_count: Math.max(1, input.pageCount),
      created_by: userData.user?.id ?? null,
    })
    .select(DRAWING_COLS)
    .single();
  if (error) {
    // 메타 등록 실패 시 고아 오브젝트 정리.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  return data as Drawing;
}

export async function deleteDrawing(d: Drawing): Promise<void> {
  await supabase.storage.from(BUCKET).remove([d.storage_path]);
  const { error } = await supabase.from('drawings').delete().eq('id', d.id);
  if (error) throw error;
}

/** 도면 파일 다운로드용 서명 URL(10분). pdf.js/DXF fetch 에 사용. */
export async function drawingFileUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  if (error) throw error;
  return data.signedUrl;
}

export async function listPins(drawingId: string): Promise<DrawingPin[]> {
  const { data, error } = await supabase
    .from('drawing_pins')
    .select(PIN_COLS)
    .eq('drawing_id', drawingId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DrawingPin[];
}

/** 프로젝트 전체에서 이슈가 연결된 도면 핀 목록(이슈 핀 뷰·상호 점프용). */
export interface IssuePinRef extends DrawingPin {
  drawing_name: string;
}

export async function listIssuePins(projectId: string): Promise<IssuePinRef[]> {
  const { data, error } = await supabase
    .from('drawing_pins')
    .select(`${PIN_COLS}, drawings(name)`)
    .eq('project_id', projectId)
    .not('issue_id', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as Array<DrawingPin & { drawings: { name: string } | null }>).map(
    (r) => ({ ...r, drawing_name: r.drawings?.name ?? '도면' }),
  );
}

/** 특정 이슈에 연결된 도면 핀(이슈 상세 → 도면 점프). */
export async function listPinsForIssue(issueId: string): Promise<IssuePinRef[]> {
  const { data, error } = await supabase
    .from('drawing_pins')
    .select(`${PIN_COLS}, drawings(name)`)
    .eq('issue_id', issueId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as Array<DrawingPin & { drawings: { name: string } | null }>).map(
    (r) => ({ ...r, drawing_name: r.drawings?.name ?? '도면' }),
  );
}

export async function createPin(input: {
  drawingId: string;
  projectId: string;
  page: number;
  x: number;
  y: number;
  label?: string | null;
  issueId?: string | null;
}): Promise<DrawingPin> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('drawing_pins')
    .insert({
      drawing_id: input.drawingId,
      project_id: input.projectId,
      page: input.page,
      x: input.x,
      y: input.y,
      label: input.label ?? null,
      issue_id: input.issueId ?? null,
      created_by: userData.user?.id ?? null,
    })
    .select(PIN_COLS)
    .single();
  if (error) throw error;
  return data as DrawingPin;
}

/** 핀의 라벨/이슈연결 갱신. */
export async function updatePin(
  id: string,
  patch: { label?: string | null; issue_id?: string | null },
): Promise<void> {
  const { error } = await supabase.from('drawing_pins').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deletePin(id: string): Promise<void> {
  const { error } = await supabase.from('drawing_pins').delete().eq('id', id);
  if (error) throw error;
}
