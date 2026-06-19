-- =====================================================================
-- MIR SMART — Phase 13: 포털 모듈 확장 (게시판 · 기성 · 하도급)
--   • posts          — 게시판/공지
--   • subcontracts   — 하도급(협력사) 내역
--   • project_info.contract_amount — 도급액(기성률 계산용)
-- Additive migration — does NOT modify 0001..0007. Reuses is_member()/is_admin().
-- =====================================================================

-- 도급액(계약금액). 기성내역에서 기성률 = 누적기성 / 도급액.
alter table public.project_info
  add column if not exists contract_amount numeric(16,2) not null default 0;

-- ---------- 게시판 / 공지 --------------------------------------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  body text,
  pinned boolean not null default false,
  author_name text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists posts_project_idx on public.posts (project_id, pinned desc, created_at desc);

-- ---------- 하도급(협력사) 내역 --------------------------------------
create table if not exists public.subcontracts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  company text not null,                 -- 협력사명
  trade text,                            -- 공종
  contract_amount numeric(16,2) not null default 0,  -- 계약금액
  paid_amount numeric(16,2) not null default 0,      -- 기지급액
  start_date date,
  end_date date,
  status text not null default 'active'
    check (status in ('active', 'done', 'terminated')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists subcontracts_project_idx on public.subcontracts (project_id);

-- ---------- RLS (멤버 읽기/쓰기) -------------------------------------
alter table public.posts enable row level security;
alter table public.subcontracts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['posts', 'subcontracts']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_admin() or public.is_member(project_id))', t, t);
  end loop;
end $$;
