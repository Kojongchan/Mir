-- 0003_schedule.sql — 4D 시공 시뮬레이션 스키마 (설계 1차, 추가형)
--
-- S4(Phase 2)의 4D 기능은 현재 프론트엔드 로컬 상태 + CSV 임포트로 동작한다.
-- 이 마이그레이션은 추후 일정/매핑을 서버에 영속화하기 위한 스키마 "설계"이며,
-- models 테이블과 동일한 RLS(프로젝트 멤버십) 패턴을 따른다.
--
-- 적용은 4D 영속화 단계에서 진행한다(지금 당장 실행해도 안전: 추가형, 멱등).
-- 0001_init.sql 의 projects / models / project_members / is_member(uuid) /
-- is_admin() 가 선행 존재한다고 가정한다.

-- 공정표(스케줄) — 한 프로젝트에 여러 개(원본 CSV 버전/시나리오)를 둘 수 있다.
create table if not exists public.schedules (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  -- 어떤 모델에 대한 일정인지(선택). null 이면 프로젝트 공용.
  model_id    uuid references public.models (id) on delete set null,
  name        text not null,
  -- 원본 포맷: 'navisworks' | 'fuzor' | 'generic'
  source      text not null default 'generic',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 작업(태스크) — 이름/유형/계획 시작·종료.
create table if not exists public.schedule_tasks (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references public.schedules (id) on delete cascade,
  -- 원본 파일의 작업 식별자(ID/GUID 등). 매핑 갱신 시 매칭에 사용.
  external_id  text,
  name         text not null,
  -- 정규화 유형: 'construct' | 'demolish' | 'equipment' | 'temporary' | 'other'
  kind         text not null default 'other',
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  sort_order   int
);

create index if not exists schedule_tasks_schedule_idx
  on public.schedule_tasks (schedule_id);

-- 작업 ↔ IFC 객체 매핑. 한 작업이 여러 expressID 를, 한 객체가 여러 작업을
-- 가질 수 있어(예: 시공 후 철거) 다대다.
create table if not exists public.task_elements (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.schedule_tasks (id) on delete cascade,
  model_id    uuid not null references public.models (id) on delete cascade,
  -- web-ifc expressID (모델 내 요소 식별자)
  express_id  bigint not null,
  unique (task_id, model_id, express_id)
);

create index if not exists task_elements_task_idx on public.task_elements (task_id);

-- RLS: models 와 동일하게 "프로젝트 멤버(또는 admin)만" 접근.
alter table public.schedules enable row level security;
alter table public.schedule_tasks enable row level security;
alter table public.task_elements enable row level security;

-- schedules: 프로젝트 멤버는 조회/쓰기 가능.
drop policy if exists schedules_member_rw on public.schedules;
create policy schedules_member_rw on public.schedules
  for all
  using (public.is_admin() or public.is_member(project_id))
  with check (public.is_admin() or public.is_member(project_id));

-- schedule_tasks: 소속 schedule 의 프로젝트 멤버십으로 판정.
drop policy if exists schedule_tasks_member_rw on public.schedule_tasks;
create policy schedule_tasks_member_rw on public.schedule_tasks
  for all
  using (
    public.is_admin() or exists (
      select 1 from public.schedules s
      where s.id = schedule_tasks.schedule_id
        and public.is_member(s.project_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.schedules s
      where s.id = schedule_tasks.schedule_id
        and public.is_member(s.project_id)
    )
  );

-- task_elements: 소속 task→schedule→project 멤버십으로 판정.
drop policy if exists task_elements_member_rw on public.task_elements;
create policy task_elements_member_rw on public.task_elements
  for all
  using (
    public.is_admin() or exists (
      select 1
      from public.schedule_tasks t
      join public.schedules s on s.id = t.schedule_id
      where t.id = task_elements.task_id
        and public.is_member(s.project_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1
      from public.schedule_tasks t
      join public.schedules s on s.id = t.schedule_id
      where t.id = task_elements.task_id
        and public.is_member(s.project_id)
    )
  );
