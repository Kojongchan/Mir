// =====================================================================
// MIR SMART — APS(ACC) 뷰어 전용 홈뷰·관측점(시점 북마크) — S52.
// IFC 뷰어(Workspace)의 홈뷰/뷰포인트 기능을 APS 통합모델(3D) 뷰로 이식한다.
// APS 뷰어는 카메라·표시상태를 viewer.getState()/restoreState() 한 덩어리 JSON
// 으로 다룬다. DB 스키마 변경 없이(추가형 마이그레이션 불필요) localStorage 에
// 프로젝트별로 보관한다(IFC 홈뷰가 쓰던 방식과 동일).
// =====================================================================

export interface ApsViewpoint {
  id: string;
  name: string;
  /** Autodesk.Viewing.Viewer3D#getState() 결과(JSON). restoreState 로 복원. */
  state: unknown;
  /** 데이터URL 썸네일(없을 수 있음). */
  thumbnail: string | null;
  created_at: string;
}

const HOME_KEY = (projectId: string) => `mir.aps.homeview.${projectId}`;
const VP_KEY = (projectId: string) => `mir.aps.viewpoints.${projectId}`;

// ---- 홈뷰 -----------------------------------------------------------
export function saveApsHomeView(projectId: string, state: unknown): void {
  try {
    localStorage.setItem(HOME_KEY(projectId), JSON.stringify(state));
  } catch {
    /* 용량 초과 등 무시 */
  }
}

export function loadApsHomeView(projectId: string): unknown | null {
  try {
    const raw = localStorage.getItem(HOME_KEY(projectId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearApsHomeView(projectId: string): void {
  try {
    localStorage.removeItem(HOME_KEY(projectId));
  } catch {
    /* 무시 */
  }
}

// ---- 관측점(시점 북마크) --------------------------------------------
export function listApsViewpoints(projectId: string): ApsViewpoint[] {
  try {
    const raw = localStorage.getItem(VP_KEY(projectId));
    const arr = raw ? (JSON.parse(raw) as ApsViewpoint[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeApsViewpoints(projectId: string, list: ApsViewpoint[]): void {
  localStorage.setItem(VP_KEY(projectId), JSON.stringify(list));
}

export function addApsViewpoint(
  projectId: string,
  vp: { name: string; state: unknown; thumbnail: string | null },
): ApsViewpoint {
  const list = listApsViewpoints(projectId);
  const item: ApsViewpoint = {
    id: `vp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: vp.name,
    state: vp.state,
    thumbnail: vp.thumbnail,
    created_at: new Date().toISOString(),
  };
  // 최신순(앞에 추가).
  writeApsViewpoints(projectId, [item, ...list]);
  return item;
}

export function deleteApsViewpoint(projectId: string, id: string): void {
  writeApsViewpoints(
    projectId,
    listApsViewpoints(projectId).filter((v) => v.id !== id),
  );
}
