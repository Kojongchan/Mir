-- =====================================================================
-- MIR SMART — R3: Punch List (하자 · 미완료 지적)
--   • punch — 하자/미완료 항목(위치·부재·도면 핀·상태·심각도·담당 협력사·담당자).
-- 재사용: attachments(target_type='punch', before/after 사진) · APS GlobalId 앵커
--         (0026 이슈 핀 인프라) · notifications(담당 배정·상태 알림) · drawings(0018).
-- 준공률 위젯 = closed / total. 상태: open → in_progress → verified → closed.
-- 권한(RBAC 0023): 읽기 = is_member, 쓰기 = is_editor(+담당자 본인 수정). 추가형 · 멱등.
-- =====================================================================

create table if not exists public.punch (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  punch_no integer not null,                       -- 프로젝트별 시퀀스(트리거)
  title text not null,
  description text,
  location_desc text,                              -- 위치 설명(층·공구 등 자유서술)
  global_id text,                                  -- 연결 부재(APS GlobalId), nullable
  drawing_id uuid references public.drawings on delete set null,
  pin_x double precision,
  pin_y double precision,
  pin_page integer,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'verified', 'closed')),
  severity text not null default 'normal'
    check (severity in ('low', 'normal', 'high', 'critical')),
  assignee_company text,                           -- 담당 협력사
  assignee uuid references auth.users on delete set null,
  assignee_name text,
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, punch_no)
);
create index if not exists punch_project_idx on public.punch (project_id, created_at desc);
create index if not exists punch_assignee_idx on public.punch (assignee);
create index if not exists punch_status_idx on public.punch (project_id, status);

-- 프로젝트별 punch_no 시퀀스(BEFORE INSERT, max+1).
create or replace function public.punch_assign_no()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.punch_no is null or new.punch_no = 0 then
    select coalesce(max(punch_no), 0) + 1 into new.punch_no
    from public.punch where project_id = new.project_id;
  end if;
  return new;
end;
$$;
drop trigger if exists punch_no_trigger on public.punch;
create trigger punch_no_trigger before insert on public.punch
  for each row execute function public.punch_assign_no();

-- ---------- row level security ---------------------------------------
alter table public.punch enable row level security;

drop policy if exists punch_select on public.punch;
create policy punch_select on public.punch
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists punch_insert on public.punch;
create policy punch_insert on public.punch
  for insert with check (public.is_editor(project_id));
drop policy if exists punch_update on public.punch;
create policy punch_update on public.punch
  for update using (public.is_editor(project_id) or assignee = auth.uid());
drop policy if exists punch_delete on public.punch;
create policy punch_delete on public.punch
  for delete using (public.is_editor(project_id));

notify pgrst, 'reload schema';
