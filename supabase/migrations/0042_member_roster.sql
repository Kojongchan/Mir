-- =====================================================================
-- MIR SMART — 구성원 로스터 열람 확장 (R12 후속)
-- 관계사·역할 관리는 프로젝트 관리자가 하되, 실무자·뷰어도 "이 프로젝트에 누가
-- 어떤 소속·역할로 있는지" 열람할 수 있어야 한다. 이를 위해:
--   ① project_members SELECT 를 같은 프로젝트 멤버 전체로 확장(기존 own/admin 유지).
--   ② profiles SELECT 에 "같은 프로젝트 구성원 표시명 읽기" 정책 추가(union).
-- 쓰기 권한은 그대로(0023). SECURITY DEFINER 헬퍼로 RLS 재귀를 회피한다.
-- 추가형 · 멱등 — 기존 정책은 교체/추가만.
-- =====================================================================

-- 두 사용자가 같은 프로젝트에 함께 속해 있는지(정의자 권한 — 재귀 회피).
create or replace function public.shares_project(target uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.project_members m1
    join public.project_members m2 on m1.project_id = m2.project_id
    where m1.user_id = auth.uid() and m2.user_id = target
  );
$$;

-- project_members: 같은 프로젝트 멤버 목록 열람 허용(기존 own/admin/project_admin 유지 + is_member).
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or public.is_project_admin(project_id)
    or public.is_member(project_id)
  );

-- profiles: 같은 프로젝트 구성원끼리 표시명 읽기(기존 own+admin 정책과 OR union).
drop policy if exists profiles_comembers on public.profiles;
create policy profiles_comembers on public.profiles
  for select using (public.shares_project(id));

notify pgrst, 'reload schema';
