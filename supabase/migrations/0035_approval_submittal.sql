-- =====================================================================
-- MIR SMART — R4+R5: ISO 19650 승인 워크플로우 + Submittals(제출물)
--   • approval_flow — 모든 상태전환의 append-only 감사로그(누가·언제·왜).
--   • submittal     — 제출물(ball-in-court·리비전·상태머신·연결 파일).
--
-- ★ 핵심 원칙(수주 결정요인): 상태전환 로직은 전부 SERVER-SIDE(SECURITY DEFINER
--   RPC) 에서 검증한다. 클라이언트는 status 를 직접 UPDATE 할 수 없다(RLS 로 차단).
--   전환은 오직 rpc_submittal_transition / rpc_file_status_transition 만이 수행하며,
--   ① 전환 합법성(상태머신) ② 호출자 권한(승인단계별) 을 모두 통과해야 한다.
--   무단/불법 전환은 RAISE EXCEPTION 으로 거부된다.
--
-- 재사용: files/file_versions(0004/0005)·activity_log(0005)·notifications(0013)·
--         RBAC(0023 is_editor/is_project_admin/is_member).
-- 추가형 · 멱등 — 0001..0034 무수정.
-- =====================================================================

-- ---------- approval_flow (감사로그) ---------------------------------
create table if not exists public.approval_flow (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  target_type text not null check (target_type in ('file', 'model', 'submittal')),
  target_id uuid not null,
  from_state text,
  to_state text not null,
  approver uuid references auth.users,            -- 전환을 수행한 행위자
  approver_name text,
  decision text not null
    check (decision in ('approved', 'conditional', 'rejected', 'resubmit', 'transition')),
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists approval_flow_target_idx on public.approval_flow (target_type, target_id, created_at);
create index if not exists approval_flow_project_idx on public.approval_flow (project_id, created_at desc);

-- ---------- submittal ------------------------------------------------
create table if not exists public.submittal (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  submittal_no integer not null,
  title text not null,
  type text,                                       -- shop drawing / material / sample …
  spec_section text,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'under_review', 'approved', 'conditional', 'rejected', 'closed')),
  revision_no integer not null default 0,
  current_holder uuid references auth.users on delete set null,   -- ball-in-court
  current_holder_name text,
  file_id uuid references public.files on delete set null,
  due_date date,
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ball-in-court 지연 계산용: 현 상태 진입 시각.
  held_since timestamptz not null default now(),
  unique (project_id, submittal_no)
);
create index if not exists submittal_project_idx on public.submittal (project_id, created_at desc);
create index if not exists submittal_holder_idx on public.submittal (current_holder);

-- 프로젝트별 submittal_no 시퀀스(BEFORE INSERT).
create or replace function public.submittal_assign_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.submittal_no is null or new.submittal_no = 0 then
    select coalesce(max(submittal_no), 0) + 1 into new.submittal_no
    from public.submittal where project_id = new.project_id;
  end if;
  return new;
end;
$$;
drop trigger if exists submittal_no_trigger on public.submittal;
create trigger submittal_no_trigger before insert on public.submittal
  for each row execute function public.submittal_assign_no();

-- ---------- row level security ---------------------------------------
alter table public.approval_flow enable row level security;
alter table public.submittal enable row level security;

-- approval_flow: 멤버 읽기. INSERT 는 RPC(SECURITY DEFINER) 만 — 직접 삽입 차단(감사 무결성).
drop policy if exists approval_flow_select on public.approval_flow;
create policy approval_flow_select on public.approval_flow
  for select using (public.is_admin() or public.is_member(project_id));
-- (INSERT/UPDATE/DELETE 정책 없음 → 일반 사용자 직접 쓰기 불가. RPC 가 소유자 권한으로 기록.)

-- submittal: 멤버 읽기. 생성 = 실무자. ★ status/current_holder 는 직접 UPDATE 금지 —
-- 메타(제목·유형·기한·파일)만 실무자가 수정 가능하고 상태는 RPC 로만 전환한다.
drop policy if exists submittal_select on public.submittal;
create policy submittal_select on public.submittal
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists submittal_insert on public.submittal;
create policy submittal_insert on public.submittal
  for insert with check (public.is_editor(project_id) and status = 'draft' and revision_no = 0);
-- 실무자는 메타(제목·유형·기한·파일)만 수정 가능. status/current_holder/revision_no 변경은
-- 아래 가드 트리거가 RPC 컨텍스트가 아니면 거부한다(서버측 상태머신 강제).
drop policy if exists submittal_update on public.submittal;
create policy submittal_update on public.submittal
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));
drop policy if exists submittal_delete on public.submittal;
create policy submittal_delete on public.submittal
  for delete using (public.is_editor(project_id));

-- ★ 가드 트리거: status/current_holder/revision_no 를 직접 UPDATE 로 바꾸는 것을 차단.
--   전환은 오직 rpc_submittal_transition 만 허용(세션 플래그 app.submittal_bypass='on').
create or replace function public.submittal_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.submittal_bypass', true) is distinct from 'on' then
    if new.status is distinct from old.status
       or new.current_holder is distinct from old.current_holder
       or new.revision_no is distinct from old.revision_no then
      raise exception 'submittal state can only change via rpc_submittal_transition (server-side state machine)';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists submittal_guard_trigger on public.submittal;
create trigger submittal_guard_trigger before update on public.submittal
  for each row execute function public.submittal_guard();

-- ---------------------------------------------------------------------
-- 공용: 감사로그 기록 헬퍼(SECURITY DEFINER 컨텍스트에서 호출).
-- ---------------------------------------------------------------------
create or replace function public._approval_log(
  p_project uuid, p_type text, p_target uuid, p_from text, p_to text,
  p_decision text, p_comment text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select coalesce(full_name, username) into v_name from public.profiles where id = auth.uid();
  insert into public.approval_flow(project_id, target_type, target_id, from_state, to_state,
    approver, approver_name, decision, comment)
  values (p_project, p_type, p_target, p_from, p_to, auth.uid(), v_name, p_decision, p_comment);
end;
$$;

-- ---------------------------------------------------------------------
-- ★ Submittal 상태전환 RPC — 서버측 상태머신 + 승인단계별 권한.
--   p_action: 'submit' | 'start_review' | 'approve' | 'conditional' |
--             'reject' | 'resubmit' | 'close'
--   반환: 새 status. 불법 전환·권한 부족은 예외.
-- ---------------------------------------------------------------------
create or replace function public.rpc_submittal_transition(
  p_id uuid,
  p_action text,
  p_comment text default null,
  p_next_holder uuid default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.submittal%rowtype;
  v_from text;
  v_to text;
  v_decision text;
  v_new_holder uuid;
  v_new_rev integer;
  v_is_admin boolean;
  v_is_editor boolean;
  v_holder_name text;
begin
  select * into s from public.submittal where id = p_id;
  if not found then raise exception 'submittal not found'; end if;

  -- 최소: 프로젝트 멤버여야 함.
  if not public.is_member(s.project_id) then
    raise exception 'forbidden: not a project member';
  end if;
  v_is_admin  := public.is_project_admin(s.project_id);
  v_is_editor := public.is_editor(s.project_id);
  v_from := s.status;
  v_new_rev := s.revision_no;
  v_new_holder := s.current_holder;

  -- 상태머신: (현재상태, 액션) → (다음상태, decision). 불법 조합은 예외.
  if p_action = 'submit' then
    if v_from <> 'draft' then raise exception 'illegal transition: submit from %', v_from; end if;
    if not v_is_editor then raise exception 'forbidden: submit requires editor'; end if;
    v_to := 'submitted'; v_decision := 'transition';
    v_new_holder := coalesce(p_next_holder, s.current_holder);  -- 리뷰어(승인권자)

  elsif p_action = 'start_review' then
    if v_from <> 'submitted' then raise exception 'illegal transition: start_review from %', v_from; end if;
    -- 리뷰 착수 = 승인권자(프로젝트 관리자) 또는 현재 볼 보유자.
    if not (v_is_admin or s.current_holder = auth.uid()) then
      raise exception 'forbidden: review requires approver or ball-in-court holder';
    end if;
    v_to := 'under_review'; v_decision := 'transition';

  elsif p_action in ('approve', 'conditional', 'reject') then
    if v_from <> 'under_review' then raise exception 'illegal transition: % from %', p_action, v_from; end if;
    -- ★ 승인 결정 = 승인권자(프로젝트 관리자) 또는 지정된 볼 보유자만.
    if not (v_is_admin or s.current_holder = auth.uid()) then
      raise exception 'forbidden: decision requires approver or designated holder';
    end if;
    v_to := case p_action when 'approve' then 'approved'
                          when 'conditional' then 'conditional'
                          else 'rejected' end;
    v_decision := p_action;
    v_new_holder := coalesce(p_next_holder, s.created_by);  -- 결과 통보 → 제출자에게 볼 넘김

  elsif p_action = 'resubmit' then
    if v_from not in ('conditional', 'rejected') then
      raise exception 'illegal transition: resubmit from %', v_from;
    end if;
    if not v_is_editor then raise exception 'forbidden: resubmit requires editor'; end if;
    v_to := 'submitted'; v_decision := 'resubmit';
    v_new_rev := s.revision_no + 1;                          -- 리비전 증가
    v_new_holder := coalesce(p_next_holder, s.current_holder);

  elsif p_action = 'close' then
    if v_from not in ('approved', 'conditional') then
      raise exception 'illegal transition: close from %', v_from;
    end if;
    if not v_is_editor then raise exception 'forbidden: close requires editor'; end if;
    v_to := 'closed'; v_decision := 'transition';
    v_new_holder := null;

  else
    raise exception 'unknown action: %', p_action;
  end if;

  select coalesce(full_name, username) into v_holder_name from public.profiles where id = v_new_holder;

  -- 가드 트리거 우회(이 RPC 만 상태전환 허용). 트랜잭션 로컬(true).
  perform set_config('app.submittal_bypass', 'on', true);
  update public.submittal
     set status = v_to,
         revision_no = v_new_rev,
         current_holder = v_new_holder,
         current_holder_name = v_holder_name,
         held_since = now(),
         updated_at = now()
   where id = p_id;
  perform set_config('app.submittal_bypass', 'off', true);

  perform public._approval_log(s.project_id, 'submittal', p_id, v_from, v_to, v_decision, p_comment);
  return v_to;
end;
$$;

-- ---------------------------------------------------------------------
-- ★ 파일/모델 ISO19650 라이프사이클 전환 RPC(WIP→Shared→Published→Archived).
--   승인 게이트: Published 이상으로의 승격은 프로젝트 관리자만. 그 외 실무자.
-- ---------------------------------------------------------------------
create or replace function public.rpc_file_status_transition(
  p_file_id uuid,
  p_to text,
  p_comment text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_from text;
  v_is_admin boolean;
  v_is_editor boolean;
  v_order int;
  v_from_ord int;
  v_to_ord int;
begin
  select project_id, status into v_project, v_from from public.files where id = p_file_id;
  if v_project is null then raise exception 'file not found'; end if;
  if not public.is_member(v_project) then raise exception 'forbidden: not a member'; end if;
  v_is_admin := public.is_project_admin(v_project);
  v_is_editor := public.is_editor(v_project);
  if not v_is_editor then raise exception 'forbidden: requires editor'; end if;

  if p_to not in ('WIP', 'Shared', 'Published', 'Archived') then
    raise exception 'illegal state: %', p_to;
  end if;
  -- 라이프사이클 순서.
  v_from_ord := case v_from when 'WIP' then 1 when 'Shared' then 2 when 'Published' then 3 else 4 end;
  v_to_ord   := case p_to   when 'WIP' then 1 when 'Shared' then 2 when 'Published' then 3 else 4 end;

  -- Published(3)·Archived(4) 로 올리거나, 뒤로 되돌리는 전환은 승인권자만.
  if (v_to_ord >= 3 and v_to_ord > v_from_ord) or (v_to_ord < v_from_ord) then
    if not v_is_admin then
      raise exception 'forbidden: % requires project admin approval', p_to;
    end if;
  end if;

  update public.files set status = p_to where id = p_file_id;
  perform public._approval_log(v_project, 'file', p_file_id, v_from, p_to,
    case when v_to_ord < v_from_ord then 'resubmit' else 'transition' end, p_comment);
  return p_to;
end;
$$;

notify pgrst, 'reload schema';
