import * as THREE from 'three';

// =====================================================================
// APS 간섭 시각화 — S49. 자체 IfcViewer.showClash(A 초록 / B 빨강 + 나머지 ghost +
// 간섭부 줌)를 APS Viewer 의 setThemingColor / isolate / fitToView 로 1:1 재현한다.
// 색은 showClash 와 동일(초록 0x16a34a / 빨강 0xdc2626) — 3D 머티리얼 hex 예외.
// 모듈은 뷰어를 직접 조작(렌더 레이어) — 호출측에서 dbId 두 개를 넘긴다.
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

const GREEN = new THREE.Vector4(0x16 / 255, 0xa3 / 255, 0x4a / 255, 1); // A
const RED = new THREE.Vector4(0xdc / 255, 0x26 / 255, 0x26 / 255, 1); // B

/**
 * 간섭 한 건을 리뷰: 두 요소만 남기고(나머지 ghost) A=초록·B=빨강 으로 칠한 뒤
 * 그 쌍에 카메라를 맞춘다. 다음 호출/clearApsClashView 때 복원.
 */
export function showApsClash(
  viewer: ApsViewer,
  model: ApsModel,
  aDbId: number,
  bDbId: number,
): void {
  if (!viewer) return;
  const ids = [aDbId, bDbId].filter((d) => typeof d === 'number' && d >= 0);
  try {
    viewer.clearThemingColors?.(model);
    // isolate = 지정 요소만 강조하고 나머지는 ghost 처리(Navisworks "기타 흐리게").
    viewer.isolate?.(ids, model);
    if (aDbId >= 0) viewer.setThemingColor?.(aDbId, GREEN, model, true);
    if (bDbId >= 0) viewer.setThemingColor?.(bDbId, RED, model, true);
    if (ids.length) viewer.fitToView?.(ids, model);
  } catch {
    /* 일부 뷰어 버전 시그니처 차이 무시 */
  }
}

/** showApsClash 가 바꾼 색/격리를 복원(전체 표시). */
export function clearApsClashView(viewer: ApsViewer, model?: ApsModel): void {
  if (!viewer) return;
  try {
    viewer.clearThemingColors?.(model);
    viewer.isolate?.([], model);
    viewer.showAll?.();
  } catch {
    /* 무시 */
  }
}

/** GlobalId 한 개(이슈 위치보기 등)에 카메라를 맞추고 격리(나머지 ghost). */
export function isolateAndFit(viewer: ApsViewer, model: ApsModel, dbId: number): void {
  if (!viewer || typeof dbId !== 'number' || dbId < 0) return;
  try {
    viewer.clearThemingColors?.(model);
    viewer.isolate?.([dbId], model);
    viewer.fitToView?.([dbId], model);
  } catch {
    /* 무시 */
  }
}
