-- =====================================================================
-- MIR SMART — AI 연결(MCP) 기록과 유사 사례 (D32, 시험 구성)
--
-- 사용자가 자기 Claude/ChatGPT 구독에서 플랫폼을 커넥터(MCP)로 불러 쓴다(api/mcp/[key].ts).
--   ai_tool_log  : 도구 호출 한 번 = 한 줄(누가·어느 프로젝트·어느 대상·무슨 도구·요약·성공 여부·시간). 감사 기록.
--   sim45d_cases : 저장된 판단(단위공기와 근거, 설계현황 요약, 크리티컬 포인트, 실적 공기, 배운 점)을
--                  프로젝트를 넘어 다음 유사 구조물에서 찾아 쓰는 사례.
-- 쓰기는 서버(service role)만 한다. 읽기: 기록 = 프로젝트 멤버, 사례 = 로그인 사용자 전체(시험 구성 —
-- 다른 프로젝트 자료가 보이므로 운영 전 익명화·권한 범위를 다시 정한다, docs/IPS_4D5D.md 12절).
--
-- 추가형 · 멱등 — 0001..0040 무수정.
-- =====================================================================

create table if not exists public.ai_tool_log (
  id         bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  setup_id   uuid references public.sim45d_setup (id) on delete set null,
  user_id    uuid,
  via        text not null default 'mcp',
  tool       text not null,
  args       jsonb not null default '{}'::jsonb,
  result     text not null default '',
  ok         boolean not null default true,
  ms         integer,
  created_at timestamptz not null default now()
);
create index if not exists ai_tool_log_project_idx on public.ai_tool_log (project_id, created_at desc);

create table if not exists public.sim45d_cases (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  setup_id       uuid references public.sim45d_setup (id) on delete set null,
  structure_kind text not null default 'bridge',
  structure      text not null,
  kind           text not null check (kind in ('rates', 'design', 'critical', 'actuals', 'lesson', 'links')),
  title          text not null,
  body           jsonb not null default '{}'::jsonb,
  source         text not null default '',
  tags           text[] not null default '{}',
  via            text not null default 'mcp',
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists sim45d_cases_kind_idx on public.sim45d_cases (structure_kind, kind, created_at desc);

alter table public.ai_tool_log enable row level security;
alter table public.sim45d_cases enable row level security;

drop policy if exists ai_tool_log_select on public.ai_tool_log;
create policy ai_tool_log_select on public.ai_tool_log
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists sim45d_cases_select on public.sim45d_cases;
create policy sim45d_cases_select on public.sim45d_cases
  for select using (auth.uid() is not null);

notify pgrst, 'reload schema';
