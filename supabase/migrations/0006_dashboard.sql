-- =====================================================================
-- MIR SMART — Phase 11: project management portal (사업개요 대시보드)
-- Editable project KPIs that power the "사업개요" dashboard, in the style of
-- a construction PMIS (PROJECT WORKS):
--   • project_info        — 1 row/project: 착공/준공 일자, 전체 진행률, 개요
--   • project_milestones  — 노반완료·궤도시스템·개통예정 등 마일스톤(+D-day)
--   • daily_logs          — 공사일보: 일자별 투입인력·장비·날씨·내용
--   • monthly_records     — 월별 계획/실적 진행률 + 기성 금액(기성 현황 차트)
-- Additive migration — does NOT modify 0001..0005.
-- Reuses public.is_member()/is_admin(); members may read & edit their project.
-- =====================================================================

-- ---------- project_info (1:1 with projects) -------------------------
create table if not exists public.project_info (
  project_id uuid primary key references public.projects on delete cascade,
  start_date date,                      -- 착공일
  end_date date,                        -- 준공(계약) 예정일
  progress_pct numeric(5,2) not null default 0,  -- 전체 진행률 (0~100)
  summary text,                         -- 사업 개요 메모
  updated_at timestamptz not null default now()
);

-- ---------- project_milestones ---------------------------------------
create table if not exists public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,                   -- e.g. '노반 완료', '궤도 시스템', '개통 예정'
  target_date date,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists milestones_project_idx on public.project_milestones (project_id, sort_order);

-- ---------- daily_logs (공사일보) -------------------------------------
create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  log_date date not null,
  manpower int not null default 0,      -- 투입 인력(명)
  equipment int not null default 0,     -- 투입 장비(대)
  weather text,
  content text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists daily_logs_project_idx on public.daily_logs (project_id, log_date desc);

-- ---------- monthly_records (월별 계획/실적 + 기성) -------------------
create table if not exists public.monthly_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  ym text not null,                     -- 'YYYY-MM'
  planned_pct numeric(5,2) not null default 0,
  actual_pct numeric(5,2) not null default 0,
  billing_amount numeric(16,2) not null default 0,  -- 기성 금액(원)
  unique (project_id, ym)
);
create index if not exists monthly_records_project_idx on public.monthly_records (project_id, ym);

-- ---------- row level security ---------------------------------------
-- Read for members; insert/update/delete for members or admins. (PMIS data
-- is maintained by the project team — same write scope as folders in 0005.)

alter table public.project_info enable row level security;
alter table public.project_milestones enable row level security;
alter table public.daily_logs enable row level security;
alter table public.monthly_records enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_info', 'project_milestones', 'daily_logs', 'monthly_records']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert with check (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update using (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete using (public.is_admin() or public.is_member(project_id))',
      t, t);
  end loop;
end $$;
