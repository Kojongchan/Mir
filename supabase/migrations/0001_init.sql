-- =====================================================================
-- MIR_VDC — Phase 0 schema: users, projects, per-project access, models
-- Run in Supabase SQL editor (or via the Supabase CLI).
-- =====================================================================

-- ---------- tables ----------------------------------------------------

-- 1:1 with auth.users. Holds the login username and global admin flag.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,                 -- e.g. '평택-오송 5공구'
  code text,                          -- e.g. '5공구'
  created_at timestamptz not null default now()
);

-- which user can access which project, and with what role
create table if not exists public.project_members (
  project_id uuid not null references public.projects on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- BIM models (IFC files) belonging to a project. Binary lives in Storage.
create table if not exists public.models (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,
  storage_path text not null,         -- '<project_id>/<model_id>.ifc'
  size_bytes bigint,
  uploaded_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create index if not exists models_project_idx on public.models (project_id);
create index if not exists members_user_idx on public.project_members (user_id);

-- ---------- helper functions (SECURITY DEFINER avoids RLS recursion) ---

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_member(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members
    where project_id = p and user_id = auth.uid()
  );
$$;

-- auto-create a profile whenever an auth user is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'full_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------------------------------------

alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.models          enable row level security;

-- profiles: see your own row; admins see all
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- projects: see projects you're a member of (admins see all)
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select using (public.is_admin() or public.is_member(id));

-- project_members: see your own memberships (admins see all)
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (user_id = auth.uid() or public.is_admin());

-- models: read if you're a member of the project (admins all)
drop policy if exists models_select on public.models;
create policy models_select on public.models
  for select using (public.is_admin() or public.is_member(project_id));

-- models: insert if you're a member of the project
drop policy if exists models_insert on public.models;
create policy models_insert on public.models
  for insert with check (public.is_admin() or public.is_member(project_id));

-- models: delete if admin (refine to editor/admin role later)
drop policy if exists models_delete on public.models;
create policy models_delete on public.models
  for delete using (public.is_admin());

-- ---------- storage bucket + policies ---------------------------------
-- Create a PRIVATE bucket named 'models' in the Supabase dashboard first,
-- or uncomment the insert below.
-- insert into storage.buckets (id, name, public) values ('models', 'models', false)
--   on conflict (id) do nothing;

-- Object path convention: '<project_id>/<model_id>.ifc'
drop policy if exists storage_models_read on storage.objects;
create policy storage_models_read on storage.objects
  for select using (
    bucket_id = 'models'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );

drop policy if exists storage_models_write on storage.objects;
create policy storage_models_write on storage.objects
  for insert with check (
    bucket_id = 'models'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );
