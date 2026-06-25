import * as THREE from 'three';
import { computeDbIdWorldBox } from './apsClash';

// =====================================================================
// APS 간섭 시각화 — S49. 자체 IfcViewer.showClash(A 초록 / B 빨강 + 나머지 ghost +
// 간섭부 줌)를 APS Viewer 의 setThemingColor / isolate / fitBounds 로 재현한다.
// 모델간 간섭을 위해 A·B 가 서로 다른 모델일 수 있으므로 모델을 함께 받는다.
// 색은 showClash 와 동일(초록 0x16a34a / 빨강 0xdc2626) — 3D 머티리얼 hex 예외.
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

const GREEN = new THREE.Vector4(0x16 / 255, 0xa3 / 255, 0x4a / 255, 1); // A
const RED = new THREE.Vector4(0xdc / 255, 0x26 / 255, 0x26 / 255, 1); // B

/**
 * 간섭 한 건을 리뷰: 관여 모델만 A/B 요소로 격리(나머지 ghost), A=초록·B=빨강 칠한 뒤
 * 두 요소의 합집합 박스로 카메라를 맞춘다. 같은 모델이면 한 모델에 두 dbId 격리.
 */
export function showApsClash(
  viewer: ApsViewer,
  aModel: ApsModel,
  aDbId: number,
  bModel: ApsModel,
  bDbId: number,
): void {
  if (!viewer) return;
  try {
    viewer.clearThemingColors?.(aModel);
    viewer.clearThemingColors?.(bModel);
    // 모델별로 격리할 dbId 묶기(같은 모델이면 둘 다, 다르면 각자).
    const sameModel = aModel === bModel;
    if (sameModel) {
      const ids = [aDbId, bDbId].filter((d) => d >= 0);
      viewer.isolate?.(ids, aModel);
    } else {
      if (aDbId >= 0) viewer.isolate?.([aDbId], aModel);
      if (bDbId >= 0) viewer.isolate?.([bDbId], bModel);
    }
    if (aDbId >= 0) viewer.setThemingColor?.(aDbId, GREEN, aModel, true);
    if (bDbId >= 0) viewer.setThemingColor?.(bDbId, RED, bModel, true);

    // 합집합 박스로 줌(두 모델에 걸쳐도 정확).
    const box = new THREE.Box3();
    const ba = aDbId >= 0 ? computeDbIdWorldBox(aModel, aDbId) : null;
    const bb = bDbId >= 0 ? computeDbIdWorldBox(bModel, bDbId) : null;
    if (ba) box.union(ba);
    if (bb) box.union(bb);
    if (!box.isEmpty()) {
      if (viewer.navigation?.fitBounds) viewer.navigation.fitBounds(true, box);
      else viewer.fitToView?.([aDbId, bDbId].filter((d) => d >= 0), aModel);
    }
  } catch {
    /* 일부 뷰어 버전 시그니처 차이 무시 */
  }
}

/** showApsClash 가 바꾼 색/격리를 복원(관련 모델 전체 표시). */
export function clearApsClashView(viewer: ApsViewer, models: ApsModel[] = []): void {
  if (!viewer) return;
  try {
    for (const m of models) {
      viewer.clearThemingColors?.(m);
      viewer.isolate?.([], m);
    }
    viewer.clearThemingColors?.();
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
