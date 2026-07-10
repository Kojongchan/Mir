-- =====================================================================
-- MIR SMART — 협업·이슈 고도화: 이슈 타입 분화 + 타입별 필드 + 3D 뷰포인트/마크업
--
-- 목표: 지적·RFI·안전점검·품질을 등록→협의→닫음까지 플랫폼 안에서 완결.
--   • issues.type — general(일반)·rfi(RFI)·punch(하자/지적)·safety(안전)·quality(품질).
--   • issues.meta — 타입별 전용 필드(jsonb): RFI=상대처·응답기한·답변,
--     Punch=위치·협력사·심각도, Safety=위험요소·조치, Quality=관련기준·부적합.
--     현장 등록 GPS/촬영시각(meta.site)도 여기 담는다(컬럼 증식 방지).
--   • issue_viewpoints — 이슈에 첨부하는 3D 뷰포인트/마크업(카메라 state JSON +
--     정규화 마크업 도형 + 스냅샷 데이터URL). 협의 근거 화면을 이슈에 잔존시킨다.
--   • issue_events.kind 확장 — meta(타입 필드 변경)·viewpoint_add/viewpoint_del.
--
-- 추가형 · 멱등 — 0001..0037 무수정. RLS: 읽기 = 멤버, 쓰기 = 실무자(is_editor).
-- =====================================================================

-- ---------- 1) 이슈 타입 + 타입별 필드(meta jsonb) --------------------
alter table public.issues
  add column if not exists type text not null default 'general';

alter table public.issues drop constraint if exists issues_type_check;
alter table public.issues
  add constraint issues_type_check
  check (type in ('general', 'rfi', 'punch', 'safety', 'quality'));

alter table public.issues
  add column if not exists meta jsonb not null default '{}'::jsonb;

create index if not exists issues_type_idx on public.issues (project_id, type);

-- ---------- 2) 이슈 3D 뷰포인트/마크업 첨부 ---------------------------
create table if not exists public.issue_viewpoints (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.issues (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  title         text,
  -- Autodesk.Viewing.Viewer3D#getState() 결과(JSON). restoreState 로 복원.
  camera_state  jsonb,
  -- 정규화(0..1) 마크업 도형 배열(MarkupShape[], 0017 과 동일 포맷).
  markup        jsonb not null default '[]'::jsonb,
  -- 다운스케일 JPEG 데이터URL 스냅샷(목록 썸네일·양식 출력용).
  snapshot      text,
  created_by      uuid references auth.users (id) on delete set null,
  created_by_name text,
  created_at    timestamptz not null default now()
);
create index if not exists issue_viewpoints_issue_idx
  on public.issue_viewpoints (issue_id, created_at);

alter table public.issue_viewpoints enable row level security;

drop policy if exists issue_viewpoints_select on public.issue_viewpoints;
create policy issue_viewpoints_select on public.issue_viewpoints
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issue_viewpoints_insert on public.issue_viewpoints;
create policy issue_viewpoints_insert on public.issue_viewpoints
  for insert with check (public.is_editor(project_id));

drop policy if exists issue_viewpoints_update on public.issue_viewpoints;
create policy issue_viewpoints_update on public.issue_viewpoints
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));

drop policy if exists issue_viewpoints_delete on public.issue_viewpoints;
create policy issue_viewpoints_delete on public.issue_viewpoints
  for delete using (public.is_editor(project_id));

-- ---------- 3) 변경이력 kind 확장 ------------------------------------
alter table public.issue_events drop constraint if exists issue_events_kind_check;
alter table public.issue_events
  add constraint issue_events_kind_check
  check (kind in (
    'created', 'status', 'assign',
    'content', 'priority', 'due', 'file_add', 'file_download', 'comment',
    'meta', 'viewpoint_add', 'viewpoint_del'
  ));

notify pgrst, 'reload schema';
