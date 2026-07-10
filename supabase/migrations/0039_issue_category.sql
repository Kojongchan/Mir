-- =====================================================================
-- MIR SMART — 이슈 항목(공종·대상 분류): 보고서·토공·교량·터널·가시설·도면·문서·시뮬레이션 …
--
-- 사용자 요청: 각 이슈가 어떤 '항목'에 해당하는지 지정할 수 있게 한다.
-- 유형(type: RFI/하자/안전/품질)이 "업무 성격"이라면, 항목(category)은
-- "대상 공종/분야"다. 현장마다 공종 구성이 달라 하드코딩하지 않고
-- 프로젝트별 항목 테이블로 관리한다(기본 세트는 앱에서 원클릭 생성).
--
--   • issue_category — 프로젝트별 항목 목록(이름·정렬 순서).
--   • issues.category_id — 이슈 → 항목 연결(항목 삭제 시 미지정으로).
--   • issue_events.kind 에 'category' 추가(항목 변경 이력).
--
-- 추가형 · 멱등 — 0001..0038 무수정. RLS: 읽기 = 멤버, 쓰기 = 실무자(is_editor).
-- =====================================================================

create table if not exists public.issue_category (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name       text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);
create index if not exists issue_category_project_idx
  on public.issue_category (project_id, sort_order, name);

alter table public.issues
  add column if not exists category_id uuid references public.issue_category (id) on delete set null;

create index if not exists issues_category_idx on public.issues (project_id, category_id);

-- ---------- row level security --------------------------------------
alter table public.issue_category enable row level security;

drop policy if exists issue_category_select on public.issue_category;
create policy issue_category_select on public.issue_category
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issue_category_insert on public.issue_category;
create policy issue_category_insert on public.issue_category
  for insert with check (public.is_editor(project_id));

drop policy if exists issue_category_update on public.issue_category;
create policy issue_category_update on public.issue_category
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));

drop policy if exists issue_category_delete on public.issue_category;
create policy issue_category_delete on public.issue_category
  for delete using (public.is_editor(project_id));

-- ---------- 변경이력 kind 확장 ---------------------------------------
alter table public.issue_events drop constraint if exists issue_events_kind_check;
alter table public.issue_events
  add constraint issue_events_kind_check
  check (kind in (
    'created', 'status', 'assign',
    'content', 'priority', 'due', 'file_add', 'file_download', 'comment',
    'meta', 'viewpoint_add', 'viewpoint_del',
    'category'
  ));

notify pgrst, 'reload schema';
