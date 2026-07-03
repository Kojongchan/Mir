-- =====================================================================
-- MIR SMART — R11: 원격지원 세션 아카이브
--   • remote_session — 원격지원(Teams/Meet 링크 + 화면캡처 첨부) 아카이브.
-- 재사용: attachments(target_type='remote', 캡처·자료 — 0039 에서 제약 확장 완료).
-- RLS 쓰기 = is_editor. 추가형 · 멱등 — 0001..0039 무수정.
-- (글래스/스마트글래스 도입 시 확장 여지 — 현재는 링크·캡처 아카이브.)
-- =====================================================================

create table if not exists public.remote_session (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  link text,                                       -- Teams/Meet/Zoom 링크
  platform text,                                   -- Teams / Meet / Zoom / 기타
  held_at timestamptz not null default now(),
  participants text,                               -- 참여자(자유서술)
  summary text,                                    -- 세션 요약
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists remote_session_project_idx on public.remote_session (project_id, held_at desc);

alter table public.remote_session enable row level security;
drop policy if exists remote_session_select on public.remote_session;
create policy remote_session_select on public.remote_session
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists remote_session_insert on public.remote_session;
create policy remote_session_insert on public.remote_session
  for insert with check (public.is_editor(project_id));
drop policy if exists remote_session_update on public.remote_session;
create policy remote_session_update on public.remote_session
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));
drop policy if exists remote_session_delete on public.remote_session;
create policy remote_session_delete on public.remote_session
  for delete using (public.is_editor(project_id));

notify pgrst, 'reload schema';
