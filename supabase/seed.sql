-- =====================================================================
-- MIR_VDC — seed helper (S1). Run in Supabase SQL Editor AFTER 0001_init.sql.
-- This is NOT a migration; it is a manual, idempotent setup template you
-- edit and run once to bootstrap the first admin, a project, and access.
--
-- Prereqs (do these in the dashboard first):
--   1) SQL Editor → run supabase/migrations/0001_init.sql
--   2) Storage → create a PRIVATE bucket named 'models'
--   3) Authentication → Users → Add user (one per person):
--        Email:    <username>@mir.local      (e.g. admin@mir.local)
--        Password: <set one>                 + check "Auto Confirm User"
--        User Metadata (JSON):  { "username": "admin", "full_name": "관리자" }
--      The handle_new_user() trigger auto-creates the matching profiles row.
-- =====================================================================

-- ---- 1) promote the first admin -------------------------------------
-- Edit the username to match the admin you created above.
update public.profiles
   set is_admin = true
 where username = 'admin';

-- ---- 2) create a project (idempotent on code) -----------------------
insert into public.projects (name, code)
select '평택-오송 5공구', '5공구'
where not exists (select 1 from public.projects where code = '5공구');

-- ---- 3) assign users to the project ---------------------------------
-- Adds every listed username as a member of the project with a role.
-- Edit the (username, role) pairs as needed. Roles: viewer | editor | admin.
with proj as (
  select id from public.projects where code = '5공구'
),
assignments(username, role) as (
  values
    ('admin', 'admin'),
    ('tester', 'editor')
)
insert into public.project_members (project_id, user_id, role)
select proj.id, p.id, a.role
  from assignments a
  join public.profiles p on p.username = a.username
  cross join proj
on conflict (project_id, user_id) do update set role = excluded.role;

-- ---- 4) sanity check ------------------------------------------------
select pr.username, pr.is_admin, pj.name as project, pm.role
  from public.project_members pm
  join public.profiles pr on pr.id = pm.user_id
  join public.projects pj on pj.id = pm.project_id
 order by pj.name, pr.username;
