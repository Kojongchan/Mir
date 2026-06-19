-- =====================================================================
-- MIR SMART — Phase 4: 충돌검사 (Clash Detection) — S32 / D13.
-- 로드된 IFC 요소 간 간섭 검출 결과를 영속화한다(저장/불러오기 + CSV 내보내기).
--   • clash_tests — 한 번의 간섭 테스트(대상 집합 A/B 라벨·허용오차·유형).
--   • clashes     — 그 테스트가 찾은 개별 간섭(요소 A↔B·간섭점·관통깊이·상태·이슈연결).
-- 쓰기 권한: D11(admin 전용). 읽기: 프로젝트 멤버. 추가형·멱등(0001..0014 무수정).
-- 0001_init 의 projects / models / is_member(uuid) / is_admin() 선행 가정.
-- =====================================================================

-- ---------- 간섭 테스트(설정 + 실행 1회) ----------------------------
create table if not exists public.clash_tests (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  name        text not null,
  -- 대상 집합 라벨(예: '모델: 구조', '카테고리: IFCWALL', '전체'). 표시용.
  set_a       text,
  set_b       text,
  -- 'hard' | 'clearance'
  type        text not null default 'hard',
  tolerance   numeric not null default 0,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists clash_tests_project_idx on public.clash_tests (project_id, created_at desc);

-- ---------- 개별 간섭 ------------------------------------------------
create table if not exists public.clashes (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid not null references public.clash_tests (id) on delete cascade,
  -- 요소 A: 어느 DB 모델(있으면)·런타임 expressID·표시 이름/카테고리.
  model_a     uuid references public.models (id) on delete set null,
  express_a   integer,
  name_a      text,
  category_a  text,
  -- 요소 B.
  model_b     uuid references public.models (id) on delete set null,
  express_b   integer,
  name_b      text,
  category_b  text,
  -- 간섭 지점(월드 좌표) + 근사 관통깊이/이격(m).
  point_x     double precision,
  point_y     double precision,
  point_z     double precision,
  depth       double precision,
  -- 'new' | 'reviewing' | 'resolved' | 'approved'
  status      text not null default 'new',
  -- 간섭 → 이슈 전환 시 연결(0007 issues).
  issue_id    uuid references public.issues (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists clashes_test_idx on public.clashes (test_id);

-- ---------- row level security --------------------------------------
alter table public.clash_tests enable row level security;
alter table public.clashes enable row level security;

-- clash_tests: 멤버 읽기, admin 쓰기(D11).
drop policy if exists clash_tests_select on public.clash_tests;
create policy clash_tests_select on public.clash_tests
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists clash_tests_insert on public.clash_tests;
create policy clash_tests_insert on public.clash_tests
  for insert with check (public.is_admin());

drop policy if exists clash_tests_update on public.clash_tests;
create policy clash_tests_update on public.clash_tests
  for update using (public.is_admin());

drop policy if exists clash_tests_delete on public.clash_tests;
create policy clash_tests_delete on public.clash_tests
  for delete using (public.is_admin());

-- clashes: 멤버 읽기, admin 쓰기. 멤버십은 부모 테스트의 project 로 판정.
drop policy if exists clashes_select on public.clashes;
create policy clashes_select on public.clashes
  for select using (
    exists (
      select 1 from public.clash_tests t
      where t.id = clashes.test_id
        and (public.is_admin() or public.is_member(t.project_id))
    )
  );

drop policy if exists clashes_insert on public.clashes;
create policy clashes_insert on public.clashes
  for insert with check (public.is_admin());

drop policy if exists clashes_update on public.clashes;
create policy clashes_update on public.clashes
  for update using (public.is_admin());

drop policy if exists clashes_delete on public.clashes;
create policy clashes_delete on public.clashes
  for delete using (public.is_admin());

notify pgrst, 'reload schema';
