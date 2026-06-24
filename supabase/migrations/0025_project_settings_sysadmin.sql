-- 0025_project_settings_sysadmin.sql — 프로젝트 설정은 시스템 관리자 전용 (추가형·멱등).
--
-- 사용자 결정: 프로젝트 셋팅(이름 변경·ACC 고정 등)은 '시스템 관리자'만. 프로젝트
-- 관리자는 멤버·역할 배정까지만(프로젝트 설정 X). 0023 은 projects update 를
-- 프로젝트 관리자(is_project_admin)에게 열어줬으나, 이를 시스템 관리자(is_admin)
-- 전용으로 되돌린다. 멤버/역할(project_members) 정책은 0023 그대로(프로젝트 관리자 허용).

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';
