-- =====================================================================
-- MIR SMART — Phase 7: CDE (Common Data Environment, ISO 19650) foundation
-- Builds on 0004 (`files` table + private `docs` bucket) by adding:
--   • folders            — project folder tree
--   • file_versions      — multiple versions per file
--   • activity_log       — audit trail of CDE actions
--   • files.folder_id / files.status / files.current_version_id columns
-- Additive migration — does NOT modify 0001..0004.
-- Reuses the existing membership helpers public.is_member()/is_admin().
-- =====================================================================

-- ---------- folders ---------------------------------------------------

-- A project's folder tree. parent_id NULL = root-level folder.
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  parent_id uuid references public.folders on delete cascade,
  name text not null,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create index if not exists folders_project_idx on public.folders (project_id);
create index if not exists folders_parent_idx on public.folders (parent_id);

-- ---------- file status enum -----------------------------------------
-- ISO 19650 lifecycle: WIP → Shared → Published → Archived.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'file_status') then
    create type public.file_status as enum ('WIP', 'Shared', 'Published', 'Archived');
  end if;
end $$;

-- ---------- extend files ---------------------------------------------
-- Files gain a home folder, a lifecycle status and a pointer to the
-- current version. on delete set null for folder_id so removing a folder
-- never deletes the documents inside it (they fall back to "unfiled").
alter table public.files
  add column if not exists folder_id uuid references public.folders on delete set null;
alter table public.files
  add column if not exists status public.file_status not null default 'WIP';
alter table public.files
  add column if not exists current_version_id uuid;

create index if not exists files_folder_idx on public.files (folder_id);

-- ---------- file_versions --------------------------------------------
-- Each upload of a file is a version. The binary lives in the same private
-- `docs` bucket under '<project_id>/<file_id>/v<n>.<ext>' so the existing
-- storage policies (keyed on the leading project_id segment) already apply.
create table if not exists public.file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files on delete cascade,
  version_no int not null,
  storage_path text not null,
  size_bytes bigint,
  mime_type text,
  note text,
  uploaded_by uuid references auth.users,
  created_at timestamptz not null default now(),
  unique (file_id, version_no)
);

create index if not exists file_versions_file_idx on public.file_versions (file_id);

-- files.current_version_id → file_versions.id (added after the table exists).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_current_version_fk'
  ) then
    alter table public.files
      add constraint files_current_version_fk
      foreign key (current_version_id)
      references public.file_versions (id) on delete set null;
  end if;
end $$;

-- ---------- activity_log ---------------------------------------------
-- Append-only audit trail. action e.g. 'file.upload', 'file.version',
-- 'file.status', 'folder.create'. target_type 'file' | 'folder'.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  actor uuid references auth.users,
  action text not null,
  target_type text,
  target_id uuid,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_project_idx
  on public.activity_log (project_id, created_at desc);

-- ---------- backfill existing files as version 1 ----------------------
-- Files created by 0004/S13 have no version row yet — give each one a v1
-- pointing at its current storage object, then set current_version_id.
insert into public.file_versions (file_id, version_no, storage_path, size_bytes, mime_type, uploaded_by, created_at)
select f.id, 1, f.storage_path, f.size_bytes, f.mime_type, f.uploaded_by, f.created_at
from public.files f
where not exists (select 1 from public.file_versions v where v.file_id = f.id);

update public.files f
set current_version_id = v.id
from public.file_versions v
where v.file_id = f.id and v.version_no = 1 and f.current_version_id is null;

-- ---------- row level security ---------------------------------------

alter table public.folders enable row level security;
alter table public.file_versions enable row level security;
alter table public.activity_log enable row level security;

-- folders: members read/write their project's tree (admins all).
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_insert on public.folders;
create policy folders_insert on public.folders
  for insert with check (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_update on public.folders;
create policy folders_update on public.folders
  for update using (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_delete on public.folders;
create policy folders_delete on public.folders
  for delete using (public.is_admin() or public.is_member(project_id));

-- file_versions: membership is derived from the parent file's project.
drop policy if exists file_versions_select on public.file_versions;
create policy file_versions_select on public.file_versions
  for select using (
    public.is_admin()
    or public.is_member((select project_id from public.files where id = file_id))
  );

drop policy if exists file_versions_insert on public.file_versions;
create policy file_versions_insert on public.file_versions
  for insert with check (
    public.is_admin()
    or public.is_member((select project_id from public.files where id = file_id))
  );

-- activity_log: members read & append their project's trail (no edit/delete).
drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log
  for insert with check (public.is_admin() or public.is_member(project_id));

-- Allow members to update files (folder move / status change) — 0004 only
-- granted select/insert/delete. Status transitions are a core CDE action.
drop policy if exists files_update on public.files;
create policy files_update on public.files
  for update using (public.is_admin() or public.is_member(project_id));
