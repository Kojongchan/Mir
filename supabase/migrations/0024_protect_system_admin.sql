-- 0024_protect_system_admin.sql — 시스템 관리자(is_admin) 앱 변경 차단 (추가형·멱등).
--
-- 보안 결정: '시스템 관리자' 계정은 최상위 권한이므로 앱(관리자 콘솔) 안에서
-- 부여/해제할 수 없어야 한다. 문제가 생기면 Supabase(대시보드 SQL 또는 service
-- role)에서만 변경한다. 아래 트리거는 profiles.is_admin 값이 바뀌는 UPDATE 를
-- 일반 앱 역할(authenticated/anon)에서 막고, Supabase 운영 역할(postgres/
-- service_role/supabase_admin)에서만 허용한다.
--
-- 참고: 트리거 함수는 SECURITY DEFINER 가 아니어야 current_user 가 '호출 역할'
-- (PostgREST 의 authenticated 등)을 가리킨다. service_role 키로 호출하면
-- current_user = 'service_role' 이라 통과한다(서버리스 api/admin 은 별도 가드).

create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  if new.is_admin is distinct from old.is_admin
     and current_user not in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    raise exception '시스템 관리자(is_admin)는 앱에서 변경할 수 없습니다. Supabase에서만 관리하세요.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_is_admin on public.profiles;
create trigger trg_guard_is_admin
  before update on public.profiles
  for each row execute function public.guard_is_admin();

notify pgrst, 'reload schema';
