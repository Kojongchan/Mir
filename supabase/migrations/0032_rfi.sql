-- =====================================================================
-- MIR SMART — R1: RFI(정보요청서) 관리
-- 발주처·감리·설계사와 주고받는 정보요청서를 CDE 안에서 관리한다.
--   • rfi           — 요청서 본문(공종·상대처·담당·기한(SLA)·상태·응답·연결 부재/도면).
--   • rfi_comments  — 질의/응답 스레드(코멘트).
--   • rfi_events    — 상태 전이·담당 배정·응답 이력(활동 로그).
-- 재사용: attachments(0010, target_type='rfi') · notifications(0013) · APS GlobalId
--         앵커(0026 이슈 핀 인프라) · drawings/drawing_pins(0018).
-- 권한(RBAC 0023): 읽기 = is_member, 쓰기 = is_editor. 담당자 본인은 자기 RFI 수정 허용
-- (이슈 0013 관례 동일). 추가형 · 멱등 — 0001..0031 무수정. 미적용 시 앱 폴백(값 있을 때만 저장).
-- =====================================================================

-- ---------- rfi ------------------------------------------------------
create table if not exists public.rfi (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  rfi_no integer not null,                         -- 프로젝트별 시퀀스(트리거로 부여)
  title text not null,
  question text,
  discipline text,                                 -- 공종(건축/구조/기계/전기/토목…)
  from_party text,                                 -- 발주처 / 감리 / 설계 / 시공
  to_assignee uuid references auth.users on delete set null,  -- 담당자(응답자)
  to_assignee_name text,                           -- 담당자 표시명
  status text not null default 'open'
    check (status in ('open', 'answered', 'void', 'closed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  due_date date,                                   -- 응답 기한(SLA)
  answered_at timestamptz,
  answer text,
  global_id text,                                  -- 연결 부재(APS GlobalId), nullable
  drawing_id uuid references public.drawings on delete set null,  -- 도면 연결, nullable
  pin_x double precision,                           -- 도면 위 핀 정규화 좌표(0..1)
  pin_y double precision,
  pin_page integer,
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, rfi_no)
);
create index if not exists rfi_project_idx on public.rfi (project_id, created_at desc);
create index if not exists rfi_assignee_idx on public.rfi (to_assignee);
create index if not exists rfi_global_idx on public.rfi (project_id, global_id);

-- 프로젝트별 rfi_no 시퀀스: BEFORE INSERT 로 max+1 부여(미지정 시).
create or replace function public.rfi_assign_no()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rfi_no is null or new.rfi_no = 0 then
    select coalesce(max(rfi_no), 0) + 1 into new.rfi_no
    from public.rfi where project_id = new.project_id;
  end if;
  return new;
end;
$$;
drop trigger if exists rfi_no_trigger on public.rfi;
create trigger rfi_no_trigger before insert on public.rfi
  for each row execute function public.rfi_assign_no();

-- ---------- rfi_comments (질의/응답 스레드) --------------------------
create table if not exists public.rfi_comments (
  id uuid primary key default gen_random_uuid(),
  rfi_id uuid not null references public.rfi on delete cascade,
  body text not null,
  author uuid references auth.users,
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists rfi_comments_rfi_idx on public.rfi_comments (rfi_id, created_at);

-- ---------- rfi_events (활동 로그) -----------------------------------
create table if not exists public.rfi_events (
  id uuid primary key default gen_random_uuid(),
  rfi_id uuid not null references public.rfi on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  kind text not null check (kind in ('created', 'status', 'assign', 'answer')),
  from_value text,
  to_value text,
  actor uuid references auth.users,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists rfi_events_rfi_idx on public.rfi_events (rfi_id, created_at);

-- ---------- attachments 대상 확장(rfi/meeting/punch 공용) -------------
-- 0010 의 target_type 체크(daily_log/post/issue)에 R1~R3 대상 3종을 추가한다.
-- 드롭 후 재생성(멱등). 기존 값은 그대로 유효.
alter table public.attachments drop constraint if exists attachments_target_type_check;
alter table public.attachments
  add constraint attachments_target_type_check
  check (target_type in ('daily_log', 'post', 'issue', 'rfi', 'meeting', 'punch'));

-- ---------- row level security ---------------------------------------
alter table public.rfi enable row level security;
alter table public.rfi_comments enable row level security;
alter table public.rfi_events enable row level security;

-- rfi: 읽기 = 멤버, 쓰기 = 실무자(+담당자 본인 수정).
drop policy if exists rfi_select on public.rfi;
create policy rfi_select on public.rfi
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists rfi_insert on public.rfi;
create policy rfi_insert on public.rfi
  for insert with check (public.is_editor(project_id));
drop policy if exists rfi_update on public.rfi;
create policy rfi_update on public.rfi
  for update using (public.is_editor(project_id) or to_assignee = auth.uid());
drop policy if exists rfi_delete on public.rfi;
create policy rfi_delete on public.rfi
  for delete using (public.is_editor(project_id));

-- rfi_comments: 부모 rfi 의 프로젝트로 판정.
drop policy if exists rfi_comments_select on public.rfi_comments;
create policy rfi_comments_select on public.rfi_comments
  for select using (
    public.is_admin()
    or public.is_member((select project_id from public.rfi where id = rfi_id))
  );
drop policy if exists rfi_comments_insert on public.rfi_comments;
create policy rfi_comments_insert on public.rfi_comments
  for insert with check (
    public.is_member((select project_id from public.rfi where id = rfi_id))
  );
drop policy if exists rfi_comments_delete on public.rfi_comments;
create policy rfi_comments_delete on public.rfi_comments
  for delete using (
    public.is_editor((select project_id from public.rfi where id = rfi_id))
  );

-- rfi_events: 멤버 읽기, 멤버 쓰기(변경 주체가 이력 기록).
drop policy if exists rfi_events_select on public.rfi_events;
create policy rfi_events_select on public.rfi_events
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists rfi_events_insert on public.rfi_events;
create policy rfi_events_insert on public.rfi_events
  for insert with check (public.is_member(project_id));

notify pgrst, 'reload schema';
