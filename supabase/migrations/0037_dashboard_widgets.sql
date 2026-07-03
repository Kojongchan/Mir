-- =====================================================================
-- MIR SMART — R7: HIBoard 실시간 위젯 대시보드
--   • dashboard_widget — 프로젝트별 위젯 배치(type·position·config jsonb).
-- 재사용: U2 Bento(.bento-*)·Recharts·KPI Card·Supabase Realtime(postgres_changes).
-- RLS: 읽기 = is_member, 쓰기 = is_project_admin(프로젝트 관리자 커스터마이즈).
-- 추가형 · 멱등 — 0001..0036 무수정.
-- =====================================================================

create table if not exists public.dashboard_widget (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  type text not null,                              -- 위젯 종류(카탈로그 키)
  position integer not null default 0,             -- 배치 순서
  config jsonb not null default '{}'::jsonb,        -- span·제목 등
  created_at timestamptz not null default now()
);
create index if not exists dashboard_widget_project_idx on public.dashboard_widget (project_id, position);

alter table public.dashboard_widget enable row level security;

drop policy if exists dashboard_widget_select on public.dashboard_widget;
create policy dashboard_widget_select on public.dashboard_widget
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists dashboard_widget_insert on public.dashboard_widget;
create policy dashboard_widget_insert on public.dashboard_widget
  for insert with check (public.is_project_admin(project_id));
drop policy if exists dashboard_widget_update on public.dashboard_widget;
create policy dashboard_widget_update on public.dashboard_widget
  for update using (public.is_project_admin(project_id)) with check (public.is_project_admin(project_id));
drop policy if exists dashboard_widget_delete on public.dashboard_widget;
create policy dashboard_widget_delete on public.dashboard_widget
  for delete using (public.is_project_admin(project_id));

-- ---------------------------------------------------------------------
-- Realtime 발행 등록: 위젯이 구독하는 소스 테이블을 supabase_realtime
-- publication 에 추가(이미 있으면 무시). 이게 있어야 postgres_changes 가 흐른다.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array['issues', 'rfi', 'punch', 'billing_items', 'daily_logs', 'submittal', 'dashboard_widget'];
begin
  -- publication 이 없으면 만들지 않음(Supabase 는 기본 존재). 존재할 때만 add.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array tables loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception
        when duplicate_object then null;   -- 이미 등록됨
        when undefined_table then null;    -- 해당 테이블 없음(폴백)
      end;
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
