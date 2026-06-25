import * as THREE from 'three';
import { computeDbIdWorldBox } from './apsClash';
import { topLevelAncestor } from './apsTree';

// =====================================================================
// APS 간섭 시각화 — S49. 자체 IfcViewer.showClash(A 초록 / B 빨강 + 나머지 ghost +
// 간섭부 줌)를 APS Viewer 의 isolate / setThemingColor / fitBounds 로 재현한다.
// 결과 리뷰 시 **간섭한 두 부재의 상위 파일만** 격리(나머지 반투명) + 부재 A초록/B빨강
// + 그 쌍으로 줌. 모델간이면 A·B 가 서로 다른 모델일 수 있어 모델을 함께 받는다.
// 색은 showClash 와 동일(초록 0x16a34a / 빨강 0xdc2626) — 3D 머티리얼 hex 예외.
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

const GREEN = new THREE.Vector4(0x16 / 255, 0xa3 / 255, 0x4a / 255, 1); // A
const RED = new THREE.Vector4(0xdc / 255, 0x26 / 255, 0x26 / 255, 1); // B

/**
 * 간섭 한 건을 리뷰: 간섭 부재의 **상위 파일** 노드만 격리(그 외 반투명), A=초록·
 * B=빨강 으로 부재를 칠하고, 두 부재의 합집합 박스로 카메라를 맞춘다.
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

    // 격리 대상 = 각 부재의 최상위 파일 조상(문맥 유지, 나머지 ghost).
    const sameModel = aModel === bModel;
    const ancA = aDbId >= 0 ? topLevelAncestor(aModel, aDbId) : -1;
    const ancB = bDbId >= 0 ? topLevelAncestor(bModel, bDbId) : -1;
    if (sameModel) {
      const ids = [ancA, ancB].filter((d) => d >= 0);
      viewer.isolate?.(ids.length ? ids : [], aModel);
    } else {
      if (ancA >= 0) viewer.isolate?.([ancA], aModel);
      if (ancB >= 0) viewer.isolate?.([ancB], bModel);
    }
    if (aDbId >= 0) viewer.setThemingColor?.(aDbId, GREEN, aModel, true);
    if (bDbId >= 0) viewer.setThemingColor?.(bDbId, RED, bModel, true);

    // 두 부재의 합집합 박스로 줌(두 모델에 걸쳐도 정확).
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

/** 전체 표시(초기화) — 격리/색을 풀고 모든 부재를 솔리드로. */
export function showAllAps(viewer: ApsViewer, models: ApsModel[] = []): void {
  if (!viewer) return;
  try {
    for (const m of models) {
      viewer.clearThemingColors?.(m);
      viewer.isolate?.([], m);
    }
    viewer.clearThemingColors?.();
    viewer.isolate?.([]);
    viewer.showAll?.();
  } catch {
    /* 무시 */
  }
}

/** 반투명 겹쳐보기 — 지정 노드만 솔리드로 격리하고 나머지는 반투명(APS ghost). */
export function showContextAps(viewer: ApsViewer, model: ApsModel, dbIds: number[]): void {
  if (!viewer) return;
  try {
    viewer.clearThemingColors?.(model);
    viewer.isolate?.(dbIds.filter((d) => d >= 0), model);
  } catch {
    /* 무시 */
  }
}

/** showApsClash 가 바꾼 색/격리를 복원(관련 모델 전체 표시). */
export function clearApsClashView(viewer: ApsViewer, models: ApsModel[] = []): void {
  showAllAps(viewer, models);
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

