-- =====================================================================
-- MIR SMART — Phase 12+: 이슈 워크플로우 (Issue Workflow) — S30
-- 기존 협업/이슈 트래커(0007)를 워크플로우로 확장한다:
--   • issues.assignee_id   — 담당자(사용자 FK). 텍스트 assignee_name 은 표시용으로 유지.
--   • issues.status        — '보류(on_hold)' 상태 추가 (신규 open → 진행 in_progress
--                            → 완료 resolved/closed → 보류 on_hold).
--   • issue_events         — 상태 전이·담당자 배정 변경 이력(감사 로그).
--   • notifications        — 인앱 알림(상태 변경·배정·코멘트 시 수신자에게).
-- Additive · 멱등 — 0001..0012 의 테이블 구조는 변경하지 않는다(컬럼/제약/정책만 보강).
-- 쓰기 권한: D11(admin) 유지 + 예외 = "담당자 본인은 자기 이슈 상태 변경 허용"
-- (사용자 결정, S30). 컬럼 단위 제한은 RLS 로 불가하므로 행 단위 허용 + UI 가드.
-- =====================================================================

-- ---------- issues: 담당자 FK + 보류 상태 ----------------------------
alter table public.issues
  add column if not exists assignee_id uuid references auth.users on delete set null;

-- 상태 체크 제약에 'on_hold'(보류) 추가. 0007 의 인라인 제약명(issues_status_check)을
-- 교체한다(멱등: 있으면 드롭 후 재생성).
alter table public.issues drop constraint if exists issues_status_check;
alter table public.issues
  add constraint issues_status_check
  check (status in ('open', 'in_progress', 'resolved', 'closed', 'on_hold'));

create index if not exists issues_assignee_idx on public.issues (assignee_id);

-- ---------- 이슈 변경 이력(상태 전이·배정) ---------------------------
create table if not exists public.issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  -- 'created' | 'status' | 'assign'
  kind text not null check (kind in ('created', 'status', 'assign')),
  from_value text,                     -- 이전 상태/담당자(표시용)
  to_value text,                       -- 이후 상태/담당자(표시용)
  actor uuid references auth.users,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists issue_events_issue_idx on public.issue_events (issue_id, created_at);

-- ---------- 인앱 알림 ------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  user_id uuid not null references auth.users on delete cascade,  -- 수신자
  -- 'issue_status' | 'issue_assigned' | 'issue_comment'
  type text not null,
  title text not null,
  body text,
  issue_id uuid references public.issues on delete cascade,
  actor_name text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx
  on public.notifications (user_id, is_read, created_at desc);

-- ---------- row level security --------------------------------------
alter table public.issue_events enable row level security;
alter table public.notifications enable row level security;

-- issues UPDATE: 관리자 전체 + 담당자 본인(자기 이슈). 0009(admin-only)을 교체.
drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues
  for update using (public.is_admin() or assignee_id = auth.uid());

-- issue_events: 프로젝트 멤버 읽기. 쓰기는 이슈를 변경할 수 있는 사람
-- (관리자 또는 담당자 본인)이 이력을 남긴다.
drop policy if exists issue_events_select on public.issue_events;
create policy issue_events_select on public.issue_events
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issue_events_insert on public.issue_events;
create policy issue_events_insert on public.issue_events
  for insert with check (public.is_admin() or public.is_member(project_id));

-- notifications: 본인 것만 읽기/표시변경/삭제. 생성은 프로젝트 멤버
-- (행위자가 다른 멤버에게 알림을 만든다).
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert with check (public.is_admin() or public.is_member(project_id));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update using (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete using (user_id = auth.uid() or public.is_admin());

notify pgrst, 'reload schema';
