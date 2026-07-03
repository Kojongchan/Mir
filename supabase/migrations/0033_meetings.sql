-- =====================================================================
-- MIR SMART — R2: 회의록 · 의사결정 로그 (기존 게시판 보완/대체)
--   • meeting          — 회의록(제목·일자·참석자·본문 md).
--   • meeting_decision — 회의에서 확정된 의사결정(유형별).
--   • action_item      — 결정에서 파생된 액션아이템(담당·기한·상태·이슈 연결).
-- 재사용: attachments(target_type='meeting') · issues(액션아이템 → 이슈 승격) ·
--         notifications(액션 담당 배정 알림).
-- 권한(RBAC 0023): 읽기 = is_member, 쓰기 = is_editor. 추가형 · 멱등 — 0001..0032 무수정.
-- 세 테이블 모두 project_id 를 직접 보유해 RLS 를 단순화한다(is_member/is_editor 직접 판정).
-- =====================================================================

-- ---------- meeting --------------------------------------------------
create table if not exists public.meeting (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  meeting_date date not null default current_date,
  attendees jsonb not null default '[]'::jsonb,   -- 참석자 이름 배열
  body text,                                        -- 본문(마크다운)
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meeting_project_idx on public.meeting (project_id, meeting_date desc);

-- ---------- meeting_decision (의사결정) ------------------------------
create table if not exists public.meeting_decision (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meeting on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  text text not null,
  decision_type text not null default 'decision'
    check (decision_type in ('decision', 'agreement', 'pending', 'info')),
  created_at timestamptz not null default now()
);
create index if not exists meeting_decision_meeting_idx on public.meeting_decision (meeting_id, created_at);
create index if not exists meeting_decision_project_idx on public.meeting_decision (project_id);

-- ---------- action_item (액션아이템) ---------------------------------
create table if not exists public.action_item (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meeting on delete cascade,
  decision_id uuid references public.meeting_decision on delete set null,
  project_id uuid not null references public.projects on delete cascade,
  text text not null,
  assignee uuid references auth.users on delete set null,
  assignee_name text,
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  linked_issue_id uuid references public.issues on delete set null,   -- 이슈로 승격 시 연결
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists action_item_meeting_idx on public.action_item (meeting_id, created_at);
create index if not exists action_item_project_idx on public.action_item (project_id);
create index if not exists action_item_assignee_idx on public.action_item (assignee);

-- ---------- row level security ---------------------------------------
alter table public.meeting enable row level security;
alter table public.meeting_decision enable row level security;
alter table public.action_item enable row level security;

do $$
declare t text;
begin
  foreach t in array array['meeting', 'meeting_decision', 'action_item'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.is_editor(project_id))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_editor(project_id)) with check (public.is_editor(project_id))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_editor(project_id))', t, t);
  end loop;
end $$;

notify pgrst, 'reload schema';
