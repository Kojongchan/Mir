// =====================================================================
// 두 APS Viewer 카메라 동기화 — 4D 비교(뷰 분할, 상하 동일화면) 용.
// 한 뷰를 움직이면 다른 뷰도 같은 시점으로 따라오게 한다. 공개 navigation API
// (getPosition/getTarget/getCameraUpVector + setView)만 사용하고, CAMERA_CHANGE_EVENT
// 로 갱신을 전달한다. 되먹임(A→B→A…) 루프는 "억제 플래그 소비" 패턴으로 끊는다.
// =====================================================================

type ApsViewer = any;

/**
 * viewer a·b 의 카메라를 양방향 동기화. 반환한 함수를 호출하면 해제된다.
 * 초기 1회 a→b 로 정렬한다.
 */
export function linkViewerCameras(a: ApsViewer, b: ApsViewer): () => void {
  const Autodesk = (window as unknown as { Autodesk?: any }).Autodesk;
  const EV = Autodesk?.Viewing?.CAMERA_CHANGE_EVENT;
  if (!a || !b || !EV) return () => {};

  // 상대 뷰를 프로그램적으로 바꾼 직후 그쪽에서 올 이벤트 1건을 무시(루프 차단).
  let suppressA = false;
  let suppressB = false;

  const copyView = (from: ApsViewer, to: ApsViewer, markSuppressTarget: () => void) => {
    try {
      const nf = from.navigation;
      const nt = to.navigation;
      if (!nf || !nt) return;
      markSuppressTarget(); // to 뷰가 곧 낼 이벤트 1건을 무시하도록.
      nt.setView(nf.getPosition(), nf.getTarget());
      nt.setCameraUpVector(nf.getCameraUpVector());
      const fov = nf.getVerticalFov?.();
      if (fov != null && nt.setVerticalFov) nt.setVerticalFov(fov, false);
      to.impl?.invalidate?.(true, false, false);
    } catch {
      /* 일부 버전 미지원/실패 무시 */
    }
  };

  const onA = () => {
    if (suppressA) { suppressA = false; return; }
    copyView(a, b, () => { suppressB = true; });
  };
  const onB = () => {
    if (suppressB) { suppressB = false; return; }
    copyView(b, a, () => { suppressA = true; });
  };

  a.addEventListener(EV, onA);
  b.addEventListener(EV, onB);
  // 초기 정렬(a 기준).
  copyView(a, b, () => { suppressB = true; });

  return () => {
    try { a.removeEventListener(EV, onA); } catch { /* */ }
    try { b.removeEventListener(EV, onB); } catch { /* */ }
  };
}
