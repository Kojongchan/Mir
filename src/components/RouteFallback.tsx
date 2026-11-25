/** 지연 로드 라우트의 로딩 자리표시(Suspense fallback): 앱 전체와 ProjectShell 본문 영역에서 쓴다. */
export function RouteFallback() {
  return (
    <div className="route-loading" aria-busy="true" aria-live="polite">
      <span className="sr-only">불러오는 중…</span>
      <div className="skeleton skeleton--block" style={{ height: 40, maxWidth: 320 }} />
    </div>
  );
}
