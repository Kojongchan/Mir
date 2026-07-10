-- =====================================================================
-- MIR SMART — 간섭 코디네이션 룸 (Clash Coordination Room)
-- "플랫폼 내 완결": 간섭 항목별 담당 배정 · 기한 · 코멘트 스레드(@멘션·읽음) ·
-- 해소→검증 이력을 전부 우리 DB 에 남긴다(Navisworks/Solibri 왕복 불필요).
--
--   • clashes 확장   — assignee(담당자) · due_date(기한) · 해소/검증 감사(누가·언제).
--   • clash_comment  — 간섭별 코멘트 스레드(작성자·본문·@멘션 대상).
--   • clash_read     — 스레드 읽음 표시(사용자별 마지막 읽은 시각).
--   • notifications  — clash_id 추가(간섭 배정·코멘트·멘션 알림도 종에 뜨도록).
--
-- 추가형 · 멱등 — 0001..0031 무수정. 쓰기 = 실무자(is_editor, 0023). 읽기 = 멤버.
-- 부모 project 는 clashes → clash_tests.project_id 로 판정(0015/0023 패턴 동일).
-- =====================================================================

-- ---------- clashes: 담당 · 기한 · 해소/검증 감사 --------------------
alter table public.clashes
  add column if not exists assignee       uuid references auth.users (id) on delete set null,
  -- 관계사/역할 라벨(R12) — 표시용 자유 텍스트(예: '구조팀 / 협력사 A'). 담당자 FK 와 병행.
  add column if not exists assignee_label text,
  add column if not exists due_date       date,
  add column if not exists resolved_by    uuid references auth.users (id) on delete set null,
  add column if not exists resolved_at    timestamptz,
  add column if not exists verified_by    uuid references auth.users (id) on delete set null,
  add column if not exists verified_at    timestamptz;

create index if not exists clashes_assignee_idx on public.clashes (assignee);

-- ---------- 간섭 코멘트 스레드 --------------------------------------
create table if not exists public.clash_comment (
  id         uuid primary key default gen_random_uuid(),
  clash_id   uuid not null references public.clashes (id) on delete cascade,
  author     uuid references auth.users (id) on delete set null,
  author_name text,                    -- 표시용(profiles 조인 없이 스레드 렌더)
  body       text not null,
  -- @멘션 대상 사용자 id 배열(알림 발송·하이라이트용).
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists clash_comment_clash_idx on public.clash_comment (clash_id, created_at);

-- ---------- 스레드 읽음 표시(사용자별) ------------------------------
create table if not exists public.clash_read (
  clash_id     uuid not null references public.clashes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (clash_id, user_id)
);

-- ---------- notifications: 간섭 참조 추가 ---------------------------
alter table public.notifications
  add column if not exists clash_id uuid references public.clashes (id) on delete cascade;

-- ---------- row level security -------------------------------------
alter table public.clash_comment enable row level security;
alter table public.clash_read enable row level security;

-- 부모 clash 의 project 로 멤버/실무자 판정(clashes → clash_tests).
-- clash_comment: 멤버 읽기, 실무자 쓰기, 삭제 = 실무자 또는 작성자 본인.
drop policy if exists clash_comment_select on public.clash_comment;
create policy clash_comment_select on public.clash_comment
  for select using (
    exists (
      select 1 from public.clashes c
      join public.clash_tests t on t.id = c.test_id
      where c.id = clash_comment.clash_id
        and (public.is_admin() or public.is_member(t.project_id))
    )
  );

drop policy if exists clash_comment_insert on public.clash_comment;
create policy clash_comment_insert on public.clash_comment
  for insert with check (
    public.is_editor((
      select t.project_id from public.clashes c
      join public.clash_tests t on t.id = c.test_id
      where c.id = clash_comment.clash_id
    ))
  );

drop policy if exists clash_comment_delete on public.clash_comment;
create policy clash_comment_delete on public.clash_comment
  for delete using (
    author = auth.uid()
    or public.is_editor((
      select t.project_id from public.clashes c
      join public.clash_tests t on t.id = c.test_id
      where c.id = clash_comment.clash_id
    ))
  );

-- clash_read: 본인 것만 읽기/생성/수정/삭제.
drop policy if exists clash_read_select on public.clash_read;
create policy clash_read_select on public.clash_read
  for select using (user_id = auth.uid());

drop policy if exists clash_read_insert on public.clash_read;
create policy clash_read_insert on public.clash_read
  for insert with check (user_id = auth.uid());

drop policy if exists clash_read_update on public.clash_read;
create policy clash_read_update on public.clash_read
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists clash_read_delete on public.clash_read;
create policy clash_read_delete on public.clash_read
  for delete using (user_id = auth.uid());

notify pgrst, 'reload schema';
