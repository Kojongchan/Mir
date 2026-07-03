-- =====================================================================
-- MIR SMART — R9: 기상알림 자동화
--   • weather_alert_rule — 기상 임계치 규칙(강수·풍속·기온·적설) + 담당자.
--   • weather_alert_log  — 임계치 초과 발생 이력(발송 기록).
-- 무비용 원칙: 기상 데이터는 open-meteo(무료·API키 불필요·CORS 허용)로 클라이언트에서
-- 조회하고, 초과 시 인앱 알림(notifications)을 생성한다. Vercel Cron/카카오 알림톡은
-- 배포 인프라·키가 필요해 후속(현재는 대시보드 진입/수동 "지금 점검"으로 트리거).
-- RLS 쓰기 = is_editor. 추가형 · 멱등 — 0001..0037 무수정.
-- =====================================================================

create table if not exists public.weather_alert_rule (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  metric text not null check (metric in ('precip', 'wind', 'temp_high', 'temp_low', 'snow')),
  comparator text not null default 'gte' check (comparator in ('gte', 'lte')),
  threshold numeric(10, 2) not null,
  lat double precision,
  lon double precision,
  location_name text,
  assignee uuid references auth.users on delete set null,
  assignee_name text,
  active boolean not null default true,
  last_triggered_at timestamptz,
  last_value numeric(10, 2),
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists weather_rule_project_idx on public.weather_alert_rule (project_id);

create table if not exists public.weather_alert_log (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid references public.weather_alert_rule on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  metric text not null,
  value numeric(10, 2) not null,
  threshold numeric(10, 2) not null,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists weather_log_project_idx on public.weather_alert_log (project_id, created_at desc);

alter table public.weather_alert_rule enable row level security;
alter table public.weather_alert_log enable row level security;

drop policy if exists weather_rule_select on public.weather_alert_rule;
create policy weather_rule_select on public.weather_alert_rule
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists weather_rule_insert on public.weather_alert_rule;
create policy weather_rule_insert on public.weather_alert_rule
  for insert with check (public.is_editor(project_id));
drop policy if exists weather_rule_update on public.weather_alert_rule;
create policy weather_rule_update on public.weather_alert_rule
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));
drop policy if exists weather_rule_delete on public.weather_alert_rule;
create policy weather_rule_delete on public.weather_alert_rule
  for delete using (public.is_editor(project_id));

drop policy if exists weather_log_select on public.weather_alert_log;
create policy weather_log_select on public.weather_alert_log
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists weather_log_insert on public.weather_alert_log;
create policy weather_log_insert on public.weather_alert_log
  for insert with check (public.is_member(project_id));

notify pgrst, 'reload schema';
