-- =====================================================================
-- MIR SMART — R12: 구성원·역할·관계사 고도화
--   • company        — 관계사(발주처/감리/시공/설계/협력사…) 정보.
--   • project_members.company_id — 구성원의 소속 회사.
--   • member_role    — 구성원의 다중 도메인 역할 태그(1인 N역할).
-- 접근권한(project_members.role: viewer/editor/admin, 0023)은 그대로 유지하고,
-- "도메인 역할"(현장대리인·안전·품질·공무 등)은 태그로 분리한다.
-- RLS 쓰기 = is_project_admin(D22), 시스템관리자 보호(D21) 유지. 추가형 · 멱등.
-- =====================================================================

create table if not exists public.company (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,
  role_type text not null default '협력사'
    check (role_type in ('발주처', '감리', '시공', '설계', '협력사', '기타')),
  phone text,
  manager text,                                    -- 담당자명
  active boolean not null default true,            -- 사업개요 표시 토글
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists company_project_idx on public.company (project_id, sort_order);

-- 구성원 소속 회사(방어적 add — project_members 는 0001 부터 존재).
alter table public.project_members add column if not exists company_id uuid references public.company on delete set null;

create table if not exists public.member_role (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role_tag text not null,                          -- 예: 현장대리인·안전관리자·품질·공무
  created_at timestamptz not null default now(),
  unique (project_id, user_id, role_tag)
);
create index if not exists member_role_idx on public.member_role (project_id, user_id);

-- ---------- row level security ---------------------------------------
alter table public.company enable row level security;
alter table public.member_role enable row level security;

-- company: 멤버 읽기, 프로젝트 관리자 쓰기.
drop policy if exists company_select on public.company;
create policy company_select on public.company
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists company_insert on public.company;
create policy company_insert on public.company
  for insert with check (public.is_project_admin(project_id));
drop policy if exists company_update on public.company;
create policy company_update on public.company
  for update using (public.is_project_admin(project_id)) with check (public.is_project_admin(project_id));
drop policy if exists company_delete on public.company;
create policy company_delete on public.company
  for delete using (public.is_project_admin(project_id));

-- member_role: 멤버 읽기, 프로젝트 관리자 쓰기(시스템 관리자 멤버 보호).
drop policy if exists member_role_select on public.member_role;
create policy member_role_select on public.member_role
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists member_role_insert on public.member_role;
create policy member_role_insert on public.member_role
  for insert with check (
    public.is_project_admin(project_id) and not public.user_is_system_admin(user_id)
  );
drop policy if exists member_role_delete on public.member_role;
create policy member_role_delete on public.member_role
  for delete using (
    public.is_project_admin(project_id) and not public.user_is_system_admin(user_id)
  );

notify pgrst, 'reload schema';
