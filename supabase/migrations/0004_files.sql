-- =====================================================================
-- MIR SMART — Phase 8: project documents & media (files table + bucket)
-- Adds a general-purpose file repository alongside IFC `models`, so a
-- project can also hold drawings, PDFs, videos, spreadsheets, docs, …
-- previewed in the in-app viewer (/view/:fileId).
-- Additive migration — does NOT modify 0001/0002/0003.
-- =====================================================================

-- ---------- table -----------------------------------------------------

-- Generic project files (binary lives in the private 'docs' Storage bucket).
-- Path convention mirrors models so the same membership check applies:
--   '<project_id>/<file_id>.<ext>'
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,                 -- original filename (with extension)
  storage_path text not null,         -- '<project_id>/<file_id>.<ext>'
  mime_type text,                     -- best-effort browser MIME at upload
  size_bytes bigint,
  uploaded_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create index if not exists files_project_idx on public.files (project_id);

-- ---------- row level security (mirrors public.models) ----------------

alter table public.files enable row level security;

-- read if you're a member of the project (admins all)
drop policy if exists files_select on public.files;
create policy files_select on public.files
  for select using (public.is_admin() or public.is_member(project_id));

-- insert if you're a member of the project
drop policy if exists files_insert on public.files;
create policy files_insert on public.files
  for insert with check (public.is_admin() or public.is_member(project_id));

-- delete if admin (refine to editor/admin role later)
drop policy if exists files_delete on public.files;
create policy files_delete on public.files
  for delete using (public.is_admin());

-- ---------- storage bucket + policies ---------------------------------
-- Create a PRIVATE bucket named 'docs' in the Supabase dashboard first,
-- or uncomment the insert below.
-- insert into storage.buckets (id, name, public) values ('docs', 'docs', false)
--   on conflict (id) do nothing;

-- Object path convention: '<project_id>/<file_id>.<ext>'
-- Read is gated by project membership; signed URLs are minted client-side
-- (createSignedUrl), which is authorised by this SELECT policy.
drop policy if exists storage_docs_read on storage.objects;
create policy storage_docs_read on storage.objects
  for select using (
    bucket_id = 'docs'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );

drop policy if exists storage_docs_write on storage.objects;
create policy storage_docs_write on storage.objects
  for insert with check (
    bucket_id = 'docs'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );
