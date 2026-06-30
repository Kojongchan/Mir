-- =====================================================================
-- MIR SMART — 5D 원가·단가(공종별 산출기준·단가·수동물량) cost_rates — S54.
--
-- 적산(물량 산출, QTO) 화면에서 공종(IFC 카테고리)별로 다음을 저장한다:
--   · qty_basis  : 금액 산출 기준 물량(길이/면적/체적/중량/개수)
--   · unit_price : 복합단가(₩/단위) — 재료+노무+장비 합산값(분해는 다음 스텝)
--   · manual_qty : 모델에서 물량이 안 잡히는 공종(토공 등)의 수동 입력 물량(없으면 NULL)
--
-- 금액(물량×단가)·기성(일정 결합)은 저장하지 않고 런타임에 계산한다(초안 단순화).
-- 프로젝트 단위로 공종마다 1행 — PK(project_id, category).
-- 추가형·멱등: 0001..0031 변경 없음. 읽기=멤버, 쓰기=실무자(is_editor, 0023 RBAC).
-- =====================================================================

create table if not exists public.cost_rates (
  project_id uuid not null references public.projects on delete cascade,
  category text not null,                              -- 공종(IFC 카테고리)
  qty_basis text not null default 'volume'             -- 산출기준
    check (qty_basis in ('length', 'area', 'volume', 'weight', 'count')),
  unit_price numeric(16,2) not null default 0,         -- 복합단가(₩/단위)
  manual_qty numeric(20,4),                            -- 수동 물량(없으면 모델 산출값 사용)
  note text,
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, category)
);

alter table public.cost_rates enable row level security;

-- 읽기 = 프로젝트 멤버(또는 시스템 관리자).
drop policy if exists cost_rates_select on public.cost_rates;
create policy cost_rates_select on public.cost_rates
  for select using (public.is_admin() or public.is_member(project_id));

-- 쓰기 = 실무자(editor) 이상 — 0023 RBAC 패턴 재사용.
drop policy if exists cost_rates_insert on public.cost_rates;
create policy cost_rates_insert on public.cost_rates
  for insert with check (public.is_editor(project_id));

drop policy if exists cost_rates_update on public.cost_rates;
create policy cost_rates_update on public.cost_rates
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));

drop policy if exists cost_rates_delete on public.cost_rates;
create policy cost_rates_delete on public.cost_rates
  for delete using (public.is_editor(project_id));
