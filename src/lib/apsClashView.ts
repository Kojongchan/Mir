import * as THREE from 'three';
import { computeDbIdWorldBox } from './apsClash';
import { topLevelAncestor } from './apsTree';

// =====================================================================
// APS 간섭 시각화 — S49. 결과 리뷰의 3가지 표시 상태:
//   기본(결과 클릭)  : 간섭 두 부재의 **상위 파일만** 남기고 다른 파일은 뷰에서 숨김.
//                      A초록/B빨강 + 그 외(두 파일 내부)는 반투명(ghost) + 줌.  (#8)
//   전체 표시        : 모든 파일 솔리드로 표시(색은 유지).                     (#6)
//   반투명           : 간섭 부재만 솔리드, 나머지 전부 반투명(파일 숨김 없이).  (#7)
// 색은 showClash 와 동일(초록 0x16a34a / 빨강 0xdc2626) — 3D 머티리얼 hex 예외.
// 단일 통합모델(nwd) 전제 — A·B 는 같은 model 의 dbId(leaf).
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

const GREEN = new THREE.Vector4(0x16 / 255, 0xa3 / 255, 0x4a / 255, 1); // A
const RED = new THREE.Vector4(0xdc / 255, 0x26 / 255, 0x26 / 255, 1); // B

function paint(viewer: ApsViewer, model: ApsModel, aDbId: number, bDbId: number) {
  if (aDbId >= 0) viewer.setThemingColor?.(aDbId, GREEN, model, true);
  if (bDbId >= 0) viewer.setThemingColor?.(bDbId, RED, model, true);
}

function fitPair(viewer: ApsViewer, model: ApsModel, aDbId: number, bDbId: number) {
  const box = new THREE.Box3();
  const ba = aDbId >= 0 ? computeDbIdWorldBox(model, aDbId) : null;
  const bb = bDbId >= 0 ? computeDbIdWorldBox(model, bDbId) : null;
  if (ba) box.union(ba);
  if (bb) box.union(bb);
  if (!box.isEmpty()) {
    if (viewer.navigation?.fitBounds) viewer.navigation.fitBounds(true, box);
    else viewer.fitToView?.([aDbId, bDbId].filter((d) => d >= 0), model);
  }
}

/**
 * 기본(결과 클릭): 간섭 부재의 **상위 파일만 보이고 나머지는 완전 숨김**(반투명 아님).
 * 핵심: setGhosting(false) 면 격리 시 비격리 객체가 ghost 가 아니라 **invisible** 이 된다.
 * 상위 파일은 솔리드, 그 안의 간섭 부재는 A초록/B빨강. 두 부재로 줌.
 */
export function showApsClash(
  viewer: ApsViewer,
  model: ApsModel,
  aDbId: number,
  bDbId: number,
): void {
  if (!viewer) return;
  try {
    viewer.clearThemingColors?.(model);
    viewer.setGhosting?.(false); // 비격리 = 완전 숨김(반투명 X)
    const ancA = aDbId >= 0 ? topLevelAncestor(model, aDbId) : -1;
    const ancB = bDbId >= 0 ? topLevelAncestor(model, bDbId) : -1;
    const keep = [...new Set([ancA, ancB].filter((d) => d >= 0))];
    if (keep.length) viewer.isolate?.(keep, model); // 상위 파일만 표시, 나머지 숨김
    else viewer.showAll?.();
    paint(viewer, model, aDbId, bDbId);
    fitPair(viewer, model, aDbId, bDbId);
  } catch {
    /* 무시 */
  }
}

/** 전체 표시(#6): 모든 파일 솔리드(숨김·격리 해제, 색 유지). */
export function showAllWithColors(viewer: ApsViewer): void {
  if (!viewer) return;
  try {
    viewer.setGhosting?.(true);
    viewer.showAll?.(); // 숨김/격리 해제(전체 솔리드로 복원)
  } catch {
    /* 무시 */
  }
}

/** 반투명(#7): 간섭 부재만 솔리드, 나머지 전부 반투명(색 유지). */
export function showTranslucentClash(
  viewer: ApsViewer,
  model: ApsModel,
  aDbId: number,
  bDbId: number,
): void {
  if (!viewer) return;
  try {
    viewer.setGhosting?.(true); // 비격리 = 반투명(ghost)
    viewer.showAll?.();
    const ids = [aDbId, bDbId].filter((d) => d >= 0);
    if (ids.length) viewer.isolate?.(ids, model);
  } catch {
    /* 무시 */
  }
}

/** 전체 초기화(패널 닫기/언마운트) — 색·격리·숨김 모두 해제. */
export function clearApsClashView(viewer: ApsViewer, model?: ApsModel): void {
  if (!viewer) return;
  try {
    viewer.setGhosting?.(true);
    viewer.clearThemingColors?.(model);
    viewer.clearThemingColors?.();
    viewer.showAll?.();
  } catch {
    /* 무시 */
  }
}

/** GlobalId 한 개(이슈 위치보기 등)에 카메라를 맞추고 격리(나머지 숨김). */
export function isolateAndFit(viewer: ApsViewer, model: ApsModel, dbId: number): void {
  if (!viewer || typeof dbId !== 'number' || dbId < 0) return;
  try {
    viewer.clearThemingColors?.(model);
    viewer.setGhosting?.(false);
    viewer.isolate?.([dbId], model);
    viewer.fitToView?.([dbId], model);
  } catch {
    /* 무시 */
  }
}
