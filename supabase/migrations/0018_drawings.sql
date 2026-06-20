-- =====================================================================
-- MIR SMART — Phase 11: 2D 도면(PDF/DXF) + 이슈 핀 — S41.
-- 현장 2D 도면을 업로드(PDF/DXF)해 브라우저에서 열람하고, 도면 위에 좌표를
-- 찍어(정규화 0..1) 이슈와 연계한다. DWG 직접열기는 변환이 필요해 S17(APS)로
-- 분리(D: A안 — PDF/DXF 우선, 무료·순수 프론트).
--   • drawings      — 한 장의 도면(파일 메타 + 종류 + 저장경로 + 페이지수).
--   • drawing_pins  — 도면 위 핀(페이지·정규화 좌표 + 라벨 + 이슈 연결).
-- 바이너리는 기존 'docs' 버킷에 '<project_id>/drawings/<id>.<ext>' 로 저장 →
-- 0004 의 storage_docs_read/write 정책(첫 경로=멤버 프로젝트)으로 커버.
-- 쓰기 권한: D11(admin 전용). 읽기: 프로젝트 멤버. 추가형·멱등(0001..0017 무수정).
-- 0001_init 의 projects / is_member(uuid) / is_admin() · 0007 issues 선행 가정.
-- =====================================================================

create table if not exists public.drawings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('pdf', 'dxf')),
  storage_path text not null,                 -- '<project_id>/drawings/<id>.<ext>'
  page_count   int  not null default 1,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists drawings_project_idx
  on public.drawings (project_id, created_at desc);

create table if not exists public.drawing_pins (
  id          uuid primary key default gen_random_uuid(),
  drawing_id  uuid not null references public.drawings (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  page        int  not null default 1,        -- PDF 페이지(1-base). DXF=1.
  -- 정규화 좌표(페이지/도면 기준 0..1). 좌상단 원점.
  x           double precision not null,
  y           double precision not null,
  label       text,
  issue_id    uuid references public.issues (id) on delete set null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists drawing_pins_drawing_idx on public.drawing_pins (drawing_id);
create index if not exists drawing_pins_project_idx on public.drawing_pins (project_id);

-- ---------- row level security --------------------------------------
alter table public.drawings enable row level security;
alter table public.drawing_pins enable row level security;

-- drawings: 멤버 읽기, admin 쓰기(D11).
drop policy if exists drawings_select on public.drawings;
create policy drawings_select on public.drawings
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists drawings_insert on public.drawings;
create policy drawings_insert on public.drawings
  for insert with check (public.is_admin());
drop policy if exists drawings_delete on public.drawings;
create policy drawings_delete on public.drawings
  for delete using (public.is_admin());

-- drawing_pins: 멤버 읽기, admin 쓰기(D11).
drop policy if exists drawing_pins_select on public.drawing_pins;
create policy drawing_pins_select on public.drawing_pins
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists drawing_pins_insert on public.drawing_pins;
create policy drawing_pins_insert on public.drawing_pins
  for insert with check (public.is_admin());
drop policy if exists drawing_pins_update on public.drawing_pins;
create policy drawing_pins_update on public.drawing_pins
  for update using (public.is_admin());
drop policy if exists drawing_pins_delete on public.drawing_pins;
create policy drawing_pins_delete on public.drawing_pins
  for delete using (public.is_admin());

notify pgrst, 'reload schema';
