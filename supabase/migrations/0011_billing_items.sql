-- =====================================================================
-- MIR SMART — 기성 공종별 상세 (billing detail by work category)
-- 공종(토공·구조물공·포장공 등)별로 도급액 / 전월 누계 기성 / 당월 기성을
-- 관리한다. 누계 = 전월 + 당월, 기성률 = 누계 / 도급액.
-- Additive — 0001..0010 변경 없음. 읽기=멤버, 쓰기=관리자(D11).
-- =====================================================================

create table if not exists public.billing_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  category text not null,                          -- 공종
  contract_amount numeric(16,2) not null default 0, -- 공종 도급액
  prev_amount numeric(16,2) not null default 0,     -- 전월까지 누계 기성
  current_amount numeric(16,2) not null default 0,  -- 당월 기성
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists billing_items_project_idx on public.billing_items (project_id, sort_order);

alter table public.billing_items enable row level security;

drop policy if exists billing_items_select on public.billing_items;
create policy billing_items_select on public.billing_items
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists billing_items_insert on public.billing_items;
create policy billing_items_insert on public.billing_items
  for insert with check (public.is_admin());

drop policy if exists billing_items_update on public.billing_items;
create policy billing_items_update on public.billing_items
  for update using (public.is_admin());

drop policy if exists billing_items_delete on public.billing_items;
create policy billing_items_delete on public.billing_items
  for delete using (public.is_admin());
