-- =====================================================================
-- MIR SMART — 공정·공사비(4D/5D) 단계형 진행 상태 (D30)
--
-- 「공정·공사비 (4D/5D)」 메뉴는 대상(구조물)마다 단계(대상 → 자료 → 설계현황 → AI 개략 IPS →
-- P6 보완 → BIM 연결 → 모델 반영 → 4D/5D → 검증)를 밟는다. 이 표는 대상별 진행 상태를 둔다.
-- 자료 파일은 자료관리(ACC)에 있고, data 에는 어느 ACC 항목을 골랐는지만 적는다
-- (구조: src/lib/sim45d/setup.ts SetupData).
--
-- 추가형 · 멱등 — 0001..0039 무수정. RLS: 읽기 = 멤버, 쓰기 = 실무자(is_editor).
-- =====================================================================

create table if not exists public.sim45d_setup (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (project_id, name)
);
create index if not exists sim45d_setup_project_idx
  on public.sim45d_setup (project_id, updated_at desc);

-- ---------- row level security --------------------------------------
alter table public.sim45d_setup enable row level security;

drop policy if exists sim45d_setup_select on public.sim45d_setup;
create policy sim45d_setup_select on public.sim45d_setup
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists sim45d_setup_insert on public.sim45d_setup;
create policy sim45d_setup_insert on public.sim45d_setup
  for insert with check (public.is_editor(project_id));

drop policy if exists sim45d_setup_update on public.sim45d_setup;
create policy sim45d_setup_update on public.sim45d_setup
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));

drop policy if exists sim45d_setup_delete on public.sim45d_setup;
create policy sim45d_setup_delete on public.sim45d_setup
  for delete using (public.is_editor(project_id));

notify pgrst, 'reload schema';
