import { supabase } from './supabase';
import type { CameraState } from '../viewer/IfcViewer';

// =====================================================================
// 저장 뷰포인트 + 마크업(redline) 데이터층 — Phase 9 / S37 (0017_viewpoints.sql).
// 현재 카메라·표시상태·2D 마크업을 이름 붙여 저장/재호출/공유한다. 쓰기는 admin(D11).
// 마크업은 좌표(JSON, 뷰포트 정규화 0..1)로 저장(편집·재렌더 가능, D16). 썸네일은
// 패널 미리보기용 다운스케일 JPEG. 이슈 첨부 시에만 마크업을 이미지로 굽는다.
// =====================================================================

/** redline 색 토큰 키(실제 색은 index.css 의 --redline-* 토큰). */
export type RedlineColor = 'red' | 'blue' | 'yellow' | 'green' | 'white';
export const REDLINE_COLORS: RedlineColor[] = ['red', 'blue', 'yellow', 'green', 'white'];

/** 마크업 도형. 좌표는 뷰포트 기준 정규화(0..1)라 해상도와 무관하게 재현된다. */
export type MarkupShape =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: RedlineColor }
  | { kind: 'rect'; x1: number; y1: number; x2: number; y2: number; color: RedlineColor }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: RedlineColor }
  | { kind: 'text'; x1: number; y1: number; text: string; color: RedlineColor };

/** 뷰어로 복원할 표시상태(모델/카테고리 숨김 + 단면). */
export interface DisplayState {
  hiddenModels: string[]; // DB 모델 uuid
  hiddenCats: string[];
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean };
}

export interface Viewpoint {
  id: string;
  project_id: string;
  model_id: string | null;
  name: string;
  camera: CameraState;
  display: DisplayState | null;
  markup: MarkupShape[];
  thumbnail: string | null;
  created_by_name?: string | null;
  created_at: string;
}

const COLS = 'id, project_id, model_id, name, camera, display, markup, thumbnail, created_at';

export async function listViewpoints(projectId: string): Promise<Viewpoint[]> {
  const { data, error } = await supabase
    .from('viewpoints')
    .select(COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(normalize);
}

export async function getViewpoint(id: string): Promise<Viewpoint | null> {
  const { data, error } = await supabase.from('viewpoints').select(COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? normalize(data) : null;
}

export async function createViewpoint(input: {
  projectId: string;
  modelId: string | null;
  name: string;
  camera: CameraState;
  display: DisplayState;
  markup: MarkupShape[];
  thumbnail: string | null;
}): Promise<Viewpoint> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('viewpoints')
    .insert({
      project_id: input.projectId,
      model_id: input.modelId,
      name: input.name,
      camera: input.camera,
      display: input.display,
      markup: input.markup,
      thumbnail: input.thumbnail,
      created_by: userData.user?.id ?? null,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return normalize(data);
}

export async function deleteViewpoint(id: string): Promise<void> {
  const { error } = await supabase.from('viewpoints').delete().eq('id', id);
  if (error) throw error;
}

function normalize(row: Record<string, unknown>): Viewpoint {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    model_id: (row.model_id as string) ?? null,
    name: row.name as string,
    camera: (row.camera as CameraState) ?? ({} as CameraState),
    display: (row.display as DisplayState) ?? null,
    markup: Array.isArray(row.markup) ? (row.markup as MarkupShape[]) : [],
    thumbnail: (row.thumbnail as string) ?? null,
    created_at: row.created_at as string,
  };
}

// ---------- 색 토큰 해석 + 마크업 굽기 --------------------------------

/** redline 토큰 키 → 실제 색 값(index.css --redline-* 를 런타임 해석). */
export function resolveRedline(color: RedlineColor): string {
  if (typeof window === 'undefined') return '#dc2626';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(`--redline-${color}`)
    .trim();
  return v || '#dc2626';
}

/**
 * 베이스 이미지(data URL) 위에 마크업 도형을 그려 합성 PNG data URL 을 만든다.
 * 이슈 첨부처럼 "주석이 박힌 한 장"이 필요할 때만 사용(저장 자체는 좌표·D16).
 */
export function bakeMarkup(baseDataUrl: string, shapes: MarkupShape[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(baseDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0);
      drawShapes(ctx, shapes, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = baseDataUrl;
  });
}

/** 정규화 도형을 2D 컨텍스트에 그린다(굽기용). */
function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: MarkupShape[],
  w: number,
  h: number,
): void {
  const lw = Math.max(2, Math.round(w * 0.004));
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.font = `bold ${Math.max(14, Math.round(w * 0.022))}px sans-serif`;
  ctx.textBaseline = 'top';
  for (const s of shapes) {
    const col = resolveRedline(s.color);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    if (s.kind === 'text') {
      ctx.fillText(s.text, s.x1 * w, s.y1 * h);
      continue;
    }
    const x1 = s.x1 * w;
    const y1 = s.y1 * h;
    const x2 = s.x2 * w;
    const y2 = s.y2 * h;
    if (s.kind === 'rect') {
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (s.kind === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = lw * 4;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
      }
    }
  }
}

/** data URL → File(첨부 업로드용). */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}
