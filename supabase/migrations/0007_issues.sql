-- =====================================================================
-- MIR SMART — Phase 12: 협업 · 이슈/지적 관리 (Issues)
-- Lightweight construction/BIM issue tracker (RFI·지적사항·검토의견):
--   • issues          — 제목·내용·상태·우선순위·담당자·기한
--   • issue_comments  — 이슈별 코멘트 스레드
-- Additive migration — does NOT modify 0001..0006. Reuses is_member()/is_admin().
-- Actor display names are stored as text (created_by_name / author_name) because
-- profiles RLS only exposes the caller's own row; the uid is kept for audit.
-- =====================================================================

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_name text,                  -- 담당자(표시용 텍스트)
  due_date date,
  file_id uuid references public.files on delete set null,  -- 선택: 관련 문서
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists issues_project_idx on public.issues (project_id, created_at desc);

create table if not exists public.issue_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues on delete cascade,
  body text not null,
  author uuid references auth.users,
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists issue_comments_issue_idx on public.issue_comments (issue_id, created_at);

-- ---------- row level security ---------------------------------------

alter table public.issues enable row level security;
alter table public.issue_comments enable row level security;

-- issues: members of the project read & write (admins all).
drop policy if exists issues_select on public.issues;
create policy issues_select on public.issues
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_insert on public.issues;
create policy issues_insert on public.issues
  for insert with check (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues
  for update using (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_delete on public.issues;
create policy issues_delete on public.issues
  for delete using (public.is_admin() or public.is_member(project_id));

-- issue_comments: membership derived from the parent issue's project.
drop policy if exists issue_comments_select on public.issue_comments;
create policy issue_comments_select on public.issue_comments
  for select using (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );

drop policy if exists issue_comments_insert on public.issue_comments;
create policy issue_comments_insert on public.issue_comments
  for insert with check (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );

drop policy if exists issue_comments_delete on public.issue_comments;
create policy issue_comments_delete on public.issue_comments
  for delete using (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );
