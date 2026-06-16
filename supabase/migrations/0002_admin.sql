-- =====================================================================
-- MIR_VDC — S2 admin console: write policies so an admin can manage
-- projects, memberships, and profile flags directly from the client
-- (authenticated as the admin user). User *creation* still needs the
-- service_role key and lives in a serverless function (api/admin.ts),
-- because creating auth.users is a privileged admin-API operation.
--
-- Additive migration — run AFTER 0001_init.sql. Re-runnable (idempotent).
-- =====================================================================

-- ---------- projects: admin can create / rename / delete -------------
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert with check (public.is_admin());

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete using (public.is_admin());

-- ---------- project_members: admin manages who is on what ------------
drop policy if exists members_insert on public.project_members;
create policy members_insert on public.project_members
  for insert with check (public.is_admin());

drop policy if exists members_update on public.project_members;
create policy members_update on public.project_members
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members
  for delete using (public.is_admin());

-- ---------- profiles: admin can edit display name / admin flag -------
-- (username changes also touch auth.users.email, so renaming a login id
--  stays a service_role operation — not exposed via this policy.)
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());
