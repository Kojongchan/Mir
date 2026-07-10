-- =====================================================================
-- MIR SMART — 협업 강화: 담당 배정 개방 + @멘션 + 읽음/안읽음
--
-- 사용자 요청:
--   • 담당자 배정은 뷰어를 뺀 모두(실무자·관리자)가 가능해야 한다.
--     → 권한(is_editor)은 이미 충족(0023)이나, 담당 후보 목록이 profiles RLS
--       (본인·시스템관리자만 SELECT, 0001)에 막혀 비-관리자에겐 비어 보였다.
--       같은 프로젝트 구성원끼리는 서로의 표시이름을 읽을 수 있게 연다(이름 공유).
--   • 이슈 코멘트 @멘션 + 읽음/안읽음 표시.
--
--   • profiles SELECT 확장 — 같은 프로젝트 멤버의 프로필(이름) 읽기 허용.
--   • issue_comments.mentions — @멘션 대상 사용자 id 배열.
--   • issue_read — 이슈별 사용자 마지막 열람 시각(안읽음 계산).
--
-- 추가형 · 멱등 — 0001..0032 무수정. 쓰기 = 실무자(is_editor). 읽기 = 멤버.
-- =====================================================================

-- ---------- 1) 같은 프로젝트 구성원끼리 프로필(이름) 읽기 -------------
-- SECURITY DEFINER 헬퍼(RLS 재귀 회피, is_member 패턴 동일). 대상 사용자와
-- 내가 하나라도 같은 프로젝트에 함께 속하면 true.
create or replace function public.shares_project(target uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.project_members me
    join public.project_members them on them.project_id = me.project_id
    where me.user_id = auth.uid() and them.user_id = target
  );
$$;

-- 0001 의 profiles_select(본인·시스템관리자)를 교체 — 같은 프로젝트 멤버 추가.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    id = auth.uid() or public.is_admin() or public.shares_project(id)
  );

-- project_members SELECT 확장 — 담당 배정·멘션 후보를 뽑으려면 실무자(비-관리자)도
-- 자기 프로젝트의 구성원 목록을 볼 수 있어야 한다. 0023 은 본인 행·프로젝트 관리자만
-- 허용했다 → 멤버 전체가 같은 프로젝트 구성원을 조회할 수 있게 연다(is_member 추가,
-- SECURITY DEFINER 라 재귀 없음). 역할 부여(insert/update/delete)는 0023 그대로 관리자만.
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or public.is_project_admin(project_id)
    or public.is_member(project_id)
  );

-- ---------- 2) 이슈 코멘트 @멘션 -----------------------------------
alter table public.issue_comments
  add column if not exists mentions uuid[] not null default '{}';

-- ---------- 3) 이슈 읽음 표시(사용자별 마지막 열람 시각) -------------
create table if not exists public.issue_read (
  issue_id     uuid not null references public.issues (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (issue_id, user_id)
);

alter table public.issue_read enable row level security;

drop policy if exists issue_read_select on public.issue_read;
create policy issue_read_select on public.issue_read
  for select using (user_id = auth.uid());

drop policy if exists issue_read_insert on public.issue_read;
create policy issue_read_insert on public.issue_read
  for insert with check (user_id = auth.uid());

drop policy if exists issue_read_update on public.issue_read;
create policy issue_read_update on public.issue_read
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists issue_read_delete on public.issue_read;
create policy issue_read_delete on public.issue_read
  for delete using (user_id = auth.uid());

notify pgrst, 'reload schema';
