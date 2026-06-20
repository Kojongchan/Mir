-- =====================================================================
-- MIR SMART — Phase 9: 저장 뷰포인트 + 마크업(redline) — S37.
-- Navisworks "Saved Viewpoints / Redline" 의 웹 버전. 현재 카메라(위치/타깃/
-- 시야)·표시상태(모델/카테고리 숨김·단면)·2D 마크업(선/사각형/화살표/텍스트)을
-- 이름 붙여 저장·재호출·공유한다. 썸네일(다운스케일 JPEG)은 패널 미리보기용.
--   • viewpoints — 한 개의 저장 뷰(카메라 json + 표시상태 json + 마크업 json + 썸네일).
-- 쓰기 권한: D11(admin 전용). 읽기: 프로젝트 멤버. 추가형·멱등(0001..0016 무수정).
-- 0001_init 의 projects / models / is_member(uuid) / is_admin() · 0007 issues 선행 가정.
-- =====================================================================

create table if not exists public.viewpoints (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  -- 어느 모델 컨텍스트에서 저장됐는지(있으면). 장면 전체 뷰면 null.
  model_id    uuid references public.models (id) on delete set null,
  name        text not null,
  -- 카메라 상태: { position:[x,y,z], target:[x,y,z], up:[x,y,z], fov, near, far }.
  camera      jsonb not null default '{}'::jsonb,
  -- 표시상태: { hiddenModels:[uuid], hiddenCats:[text], section:{enabled,axis,offset,flip} }.
  display     jsonb not null default '{}'::jsonb,
  -- 마크업(redline) 도형 배열(좌표는 뷰포트 정규화 0..1).
  markup      jsonb not null default '[]'::jsonb,
  -- 패널 미리보기용 썸네일(다운스케일 data URL). 선택적.
  thumbnail   text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists viewpoints_project_idx
  on public.viewpoints (project_id, created_at desc);

-- 이슈 ↔ 뷰포인트 연결(이슈에서 저장 뷰 열기). 0007 issues 에 컬럼 추가(멱등).
alter table public.issues
  add column if not exists viewpoint_id uuid references public.viewpoints (id) on delete set null;

-- ---------- row level security --------------------------------------
alter table public.viewpoints enable row level security;

-- viewpoints: 멤버 읽기, admin 쓰기(D11).
drop policy if exists viewpoints_select on public.viewpoints;
create policy viewpoints_select on public.viewpoints
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists viewpoints_insert on public.viewpoints;
create policy viewpoints_insert on public.viewpoints
  for insert with check (public.is_admin());

drop policy if exists viewpoints_update on public.viewpoints;
create policy viewpoints_update on public.viewpoints
  for update using (public.is_admin());

drop policy if exists viewpoints_delete on public.viewpoints;
create policy viewpoints_delete on public.viewpoints
  for delete using (public.is_admin());

notify pgrst, 'reload schema';
