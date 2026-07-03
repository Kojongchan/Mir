-- =====================================================================
-- MIR SMART — R6: EVM 원가관리 (5D 정식화)
--   • cost_rates — 공종(카테고리)별 단가·물량 → 예산(BAC = unit_price × qty).
--   • evm_actual — 기준일(as_of_date)별 PV(계획)·EV(획득)·AC(실제원가) 스냅샷.
-- CPI = EV/AC · SPI = EV/PV · EAC = BAC/CPI. 3선 S-curve·공종별 지표·기성 대사(0011).
-- 재사용: QTO(물량)·4D(진도)·기성내역(billing_items)·Recharts. RLS 쓰기 = is_editor.
-- 추가형 · 멱등 — 0001..0035 무수정.
-- =====================================================================

-- ---------- cost_rates (공종별 단가·물량 = 예산) ---------------------
create table if not exists public.cost_rates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  category text not null,                          -- 공종
  qty_basis text,                                  -- 물량 근거(m³·m²·식 등)
  unit_price numeric(16, 2) not null default 0,    -- 단가
  manual_qty numeric(16, 3) not null default 0,    -- 물량(QTO 연동 전 수동)
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cost_rates_project_idx on public.cost_rates (project_id, sort_order);

-- ---------- evm_actual (기준일별 PV·EV·AC 스냅샷) --------------------
create table if not exists public.evm_actual (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  category text,                                   -- null = 프로젝트 전체 합산 스냅샷
  as_of_date date not null,
  pv_amount numeric(16, 2) not null default 0,     -- 계획가치(Planned Value)
  ev_amount numeric(16, 2) not null default 0,     -- 획득가치(Earned Value)
  ac_amount numeric(16, 2) not null default 0,     -- 실제원가(Actual Cost)
  note text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists evm_actual_project_idx on public.evm_actual (project_id, as_of_date);

-- ---------- row level security ---------------------------------------
alter table public.cost_rates enable row level security;
alter table public.evm_actual enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cost_rates', 'evm_actual'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.is_editor(project_id))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_editor(project_id)) with check (public.is_editor(project_id))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_editor(project_id))', t, t);
  end loop;
end $$;

notify pgrst, 'reload schema';
