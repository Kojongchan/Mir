// 사용자에게 보여줄 에러 메시지 정리. 특히 "테이블 없음/스키마 캐시" 류는
// DB 마이그레이션이 아직 적용되지 않은 상태이므로, 원시 메시지 대신 무엇을
// 해야 하는지 한국어로 안내한다.

const SETUP_HINT =
  'DB 설정이 필요합니다. 관리자가 Supabase SQL 에디터에서 supabase/setup_all.sql 을 ' +
  '실행해야 합니다(또는 실행 후 스키마 새로고침). 자세히는 docs/OPERATIONS.md 0-C/0-D.';

/** True if the error is "table/relation not found" or a stale PostgREST cache. */
export function isSetupError(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  const code = (e as { code?: string })?.code ?? '';
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    /schema cache|could not find the table|does not exist/i.test(msg)
  );
}

/** Friendly message for display. Falls back to the raw message. */
export function errMessage(e: unknown): string {
  if (isSetupError(e)) return SETUP_HINT;
  return (e as { message?: string })?.message ?? String(e);
}
