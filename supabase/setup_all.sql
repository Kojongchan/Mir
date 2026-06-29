-- =====================================================================
-- MIR SMART — 통합 셋업 SQL (0003~0023 한 번에 실행)
-- Supabase 대시보드 → SQL Editor 에 '전체 복사 → 붙여넣기 → Run'.
-- 모두 멱등(재실행 안전). docs 버킷은 미리 Private 으로 생성되어 있어야 함.
-- =====================================================================

-- ===================== 0003_schedule.sql =====================
-- 0003_schedule.sql — 4D 시공 시뮬레이션 스키마 (설계 1차, 추가형)
--
-- S4(Phase 2)의 4D 기능은 현재 프론트엔드 로컬 상태 + CSV 임포트로 동작한다.
-- 이 마이그레이션은 추후 일정/매핑을 서버에 영속화하기 위한 스키마 "설계"이며,
-- models 테이블과 동일한 RLS(프로젝트 멤버십) 패턴을 따른다.
--
-- 적용은 4D 영속화 단계에서 진행한다(지금 당장 실행해도 안전: 추가형, 멱등).
-- 0001_init.sql 의 projects / models / project_members / is_member(uuid) /
-- is_admin() 가 선행 존재한다고 가정한다.

-- 공정표(스케줄) — 한 프로젝트에 여러 개(원본 CSV 버전/시나리오)를 둘 수 있다.
create table if not exists public.schedules (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  -- 어떤 모델에 대한 일정인지(선택). null 이면 프로젝트 공용.
  model_id    uuid references public.models (id) on delete set null,
  name        text not null,
  -- 원본 포맷: 'navisworks' | 'fuzor' | 'generic'
  source      text not null default 'generic',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 작업(태스크) — 이름/유형/계획 시작·종료.
create table if not exists public.schedule_tasks (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references public.schedules (id) on delete cascade,
  -- 원본 파일의 작업 식별자(ID/GUID 등). 매핑 갱신 시 매칭에 사용.
  external_id  text,
  name         text not null,
  -- 정규화 유형: 'construct' | 'demolish' | 'equipment' | 'temporary' | 'other'
  kind         text not null default 'other',
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  sort_order   int
);

create index if not exists schedule_tasks_schedule_idx
  on public.schedule_tasks (schedule_id);

-- 작업 ↔ IFC 객체 매핑. 한 작업이 여러 expressID 를, 한 객체가 여러 작업을
-- 가질 수 있어(예: 시공 후 철거) 다대다.
create table if not exists public.task_elements (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.schedule_tasks (id) on delete cascade,
  model_id    uuid not null references public.models (id) on delete cascade,
  -- web-ifc expressID (모델 내 요소 식별자)
  express_id  bigint not null,
  unique (task_id, model_id, express_id)
);

create index if not exists task_elements_task_idx on public.task_elements (task_id);

-- RLS: models 와 동일하게 "프로젝트 멤버(또는 admin)만" 접근.
alter table public.schedules enable row level security;
alter table public.schedule_tasks enable row level security;
alter table public.task_elements enable row level security;

-- schedules: 프로젝트 멤버는 조회/쓰기 가능.
drop policy if exists schedules_member_rw on public.schedules;
create policy schedules_member_rw on public.schedules
  for all
  using (public.is_admin() or public.is_member(project_id))
  with check (public.is_admin() or public.is_member(project_id));

-- schedule_tasks: 소속 schedule 의 프로젝트 멤버십으로 판정.
drop policy if exists schedule_tasks_member_rw on public.schedule_tasks;
create policy schedule_tasks_member_rw on public.schedule_tasks
  for all
  using (
    public.is_admin() or exists (
      select 1 from public.schedules s
      where s.id = schedule_tasks.schedule_id
        and public.is_member(s.project_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.schedules s
      where s.id = schedule_tasks.schedule_id
        and public.is_member(s.project_id)
    )
  );

-- task_elements: 소속 task→schedule→project 멤버십으로 판정.
drop policy if exists task_elements_member_rw on public.task_elements;
create policy task_elements_member_rw on public.task_elements
  for all
  using (
    public.is_admin() or exists (
      select 1
      from public.schedule_tasks t
      join public.schedules s on s.id = t.schedule_id
      where t.id = task_elements.task_id
        and public.is_member(s.project_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1
      from public.schedule_tasks t
      join public.schedules s on s.id = t.schedule_id
      where t.id = task_elements.task_id
        and public.is_member(s.project_id)
    )
  );

-- ===================== 0004_files.sql =====================
-- =====================================================================
-- MIR SMART — Phase 8: project documents & media (files table + bucket)
-- Adds a general-purpose file repository alongside IFC `models`, so a
-- project can also hold drawings, PDFs, videos, spreadsheets, docs, …
-- previewed in the in-app viewer (/view/:fileId).
-- Additive migration — does NOT modify 0001/0002/0003.
-- =====================================================================

-- ---------- table -----------------------------------------------------

-- Generic project files (binary lives in the private 'docs' Storage bucket).
-- Path convention mirrors models so the same membership check applies:
--   '<project_id>/<file_id>.<ext>'
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,                 -- original filename (with extension)
  storage_path text not null,         -- '<project_id>/<file_id>.<ext>'
  mime_type text,                     -- best-effort browser MIME at upload
  size_bytes bigint,
  uploaded_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create index if not exists files_project_idx on public.files (project_id);

-- ---------- row level security (mirrors public.models) ----------------

alter table public.files enable row level security;

-- read if you're a member of the project (admins all)
drop policy if exists files_select on public.files;
create policy files_select on public.files
  for select using (public.is_admin() or public.is_member(project_id));

-- insert if you're a member of the project
drop policy if exists files_insert on public.files;
create policy files_insert on public.files
  for insert with check (public.is_admin() or public.is_member(project_id));

-- delete if admin (refine to editor/admin role later)
drop policy if exists files_delete on public.files;
create policy files_delete on public.files
  for delete using (public.is_admin());

-- ---------- storage bucket + policies ---------------------------------
-- Create a PRIVATE bucket named 'docs' in the Supabase dashboard first,
-- or uncomment the insert below.
-- insert into storage.buckets (id, name, public) values ('docs', 'docs', false)
--   on conflict (id) do nothing;

-- Object path convention: '<project_id>/<file_id>.<ext>'
-- Read is gated by project membership; signed URLs are minted client-side
-- (createSignedUrl), which is authorised by this SELECT policy.
drop policy if exists storage_docs_read on storage.objects;
create policy storage_docs_read on storage.objects
  for select using (
    bucket_id = 'docs'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );

drop policy if exists storage_docs_write on storage.objects;
create policy storage_docs_write on storage.objects
  for insert with check (
    bucket_id = 'docs'
    and public.is_member((split_part(name, '/', 1))::uuid)
  );

-- ===================== 0005_cde.sql =====================
-- =====================================================================
-- MIR SMART — Phase 7: CDE (Common Data Environment, ISO 19650) foundation
-- Builds on 0004 (`files` table + private `docs` bucket) by adding:
--   • folders            — project folder tree
--   • file_versions      — multiple versions per file
--   • activity_log       — audit trail of CDE actions
--   • files.folder_id / files.status / files.current_version_id columns
-- Additive migration — does NOT modify 0001..0004.
-- Reuses the existing membership helpers public.is_member()/is_admin().
-- =====================================================================

-- ---------- folders ---------------------------------------------------

-- A project's folder tree. parent_id NULL = root-level folder.
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  parent_id uuid references public.folders on delete cascade,
  name text not null,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);

create index if not exists folders_project_idx on public.folders (project_id);
create index if not exists folders_parent_idx on public.folders (parent_id);

-- ---------- file status enum -----------------------------------------
-- ISO 19650 lifecycle: WIP → Shared → Published → Archived.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'file_status') then
    create type public.file_status as enum ('WIP', 'Shared', 'Published', 'Archived');
  end if;
end $$;

-- ---------- extend files ---------------------------------------------
-- Files gain a home folder, a lifecycle status and a pointer to the
-- current version. on delete set null for folder_id so removing a folder
-- never deletes the documents inside it (they fall back to "unfiled").
alter table public.files
  add column if not exists folder_id uuid references public.folders on delete set null;
alter table public.files
  add column if not exists status public.file_status not null default 'WIP';
alter table public.files
  add column if not exists current_version_id uuid;

create index if not exists files_folder_idx on public.files (folder_id);

-- ---------- file_versions --------------------------------------------
-- Each upload of a file is a version. The binary lives in the same private
-- `docs` bucket under '<project_id>/<file_id>/v<n>.<ext>' so the existing
-- storage policies (keyed on the leading project_id segment) already apply.
create table if not exists public.file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files on delete cascade,
  version_no int not null,
  storage_path text not null,
  size_bytes bigint,
  mime_type text,
  note text,
  uploaded_by uuid references auth.users,
  created_at timestamptz not null default now(),
  unique (file_id, version_no)
);

create index if not exists file_versions_file_idx on public.file_versions (file_id);

-- files.current_version_id → file_versions.id (added after the table exists).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_current_version_fk'
  ) then
    alter table public.files
      add constraint files_current_version_fk
      foreign key (current_version_id)
      references public.file_versions (id) on delete set null;
  end if;
end $$;

-- ---------- activity_log ---------------------------------------------
-- Append-only audit trail. action e.g. 'file.upload', 'file.version',
-- 'file.status', 'folder.create'. target_type 'file' | 'folder'.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  actor uuid references auth.users,
  action text not null,
  target_type text,
  target_id uuid,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_project_idx
  on public.activity_log (project_id, created_at desc);

-- ---------- backfill existing files as version 1 ----------------------
-- Files created by 0004/S13 have no version row yet — give each one a v1
-- pointing at its current storage object, then set current_version_id.
insert into public.file_versions (file_id, version_no, storage_path, size_bytes, mime_type, uploaded_by, created_at)
select f.id, 1, f.storage_path, f.size_bytes, f.mime_type, f.uploaded_by, f.created_at
from public.files f
where not exists (select 1 from public.file_versions v where v.file_id = f.id);

update public.files f
set current_version_id = v.id
from public.file_versions v
where v.file_id = f.id and v.version_no = 1 and f.current_version_id is null;

-- ---------- row level security ---------------------------------------

alter table public.folders enable row level security;
alter table public.file_versions enable row level security;
alter table public.activity_log enable row level security;

-- folders: members read/write their project's tree (admins all).
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_insert on public.folders;
create policy folders_insert on public.folders
  for insert with check (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_update on public.folders;
create policy folders_update on public.folders
  for update using (public.is_admin() or public.is_member(project_id));

drop policy if exists folders_delete on public.folders;
create policy folders_delete on public.folders
  for delete using (public.is_admin() or public.is_member(project_id));

-- file_versions: membership is derived from the parent file's project.
drop policy if exists file_versions_select on public.file_versions;
create policy file_versions_select on public.file_versions
  for select using (
    public.is_admin()
    or public.is_member((select project_id from public.files where id = file_id))
  );

drop policy if exists file_versions_insert on public.file_versions;
create policy file_versions_insert on public.file_versions
  for insert with check (
    public.is_admin()
    or public.is_member((select project_id from public.files where id = file_id))
  );

-- activity_log: members read & append their project's trail (no edit/delete).
drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log
  for insert with check (public.is_admin() or public.is_member(project_id));

-- Allow members to update files (folder move / status change) — 0004 only
-- granted select/insert/delete. Status transitions are a core CDE action.
drop policy if exists files_update on public.files;
create policy files_update on public.files
  for update using (public.is_admin() or public.is_member(project_id));

-- ===================== 0006_dashboard.sql =====================
-- =====================================================================
-- MIR SMART — Phase 11: project management portal (사업개요 대시보드)
-- Editable project KPIs that power the "사업개요" dashboard, in the style of
-- a construction PMIS (PROJECT WORKS):
--   • project_info        — 1 row/project: 착공/준공 일자, 전체 진행률, 개요
--   • project_milestones  — 노반완료·궤도시스템·개통예정 등 마일스톤(+D-day)
--   • daily_logs          — 공사일보: 일자별 투입인력·장비·날씨·내용
--   • monthly_records     — 월별 계획/실적 진행률 + 기성 금액(기성 현황 차트)
-- Additive migration — does NOT modify 0001..0005.
-- Reuses public.is_member()/is_admin(); members may read & edit their project.
-- =====================================================================

-- ---------- project_info (1:1 with projects) -------------------------
create table if not exists public.project_info (
  project_id uuid primary key references public.projects on delete cascade,
  start_date date,                      -- 착공일
  end_date date,                        -- 준공(계약) 예정일
  progress_pct numeric(5,2) not null default 0,  -- 전체 진행률 (0~100)
  summary text,                         -- 사업 개요 메모
  updated_at timestamptz not null default now()
);

-- ---------- project_milestones ---------------------------------------
create table if not exists public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  name text not null,                   -- e.g. '노반 완료', '궤도 시스템', '개통 예정'
  target_date date,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists milestones_project_idx on public.project_milestones (project_id, sort_order);

-- ---------- daily_logs (공사일보) -------------------------------------
create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  log_date date not null,
  manpower int not null default 0,      -- 투입 인력(명)
  equipment int not null default 0,     -- 투입 장비(대)
  weather text,
  content text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists daily_logs_project_idx on public.daily_logs (project_id, log_date desc);

-- ---------- monthly_records (월별 계획/실적 + 기성) -------------------
create table if not exists public.monthly_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  ym text not null,                     -- 'YYYY-MM'
  planned_pct numeric(5,2) not null default 0,
  actual_pct numeric(5,2) not null default 0,
  billing_amount numeric(16,2) not null default 0,  -- 기성 금액(원)
  unique (project_id, ym)
);
create index if not exists monthly_records_project_idx on public.monthly_records (project_id, ym);

-- ---------- row level security ---------------------------------------
-- Read for members; insert/update/delete for members or admins. (PMIS data
-- is maintained by the project team — same write scope as folders in 0005.)

alter table public.project_info enable row level security;
alter table public.project_milestones enable row level security;
alter table public.daily_logs enable row level security;
alter table public.monthly_records enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_info', 'project_milestones', 'daily_logs', 'monthly_records']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert with check (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update using (public.is_admin() or public.is_member(project_id))',
      t, t);

    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete using (public.is_admin() or public.is_member(project_id))',
      t, t);
  end loop;
end $$;

-- ===================== 0007_issues.sql =====================
-- =====================================================================
-- MIR SMART — Phase 12: 협업 · 이슈/지적 관리 (Issues)
-- Lightweight construction/BIM issue tracker (RFI·지적사항·검토의견):
--   • issues          — 제목·내용·상태·우선순위·담당자·기한
--   • issue_comments  — 이슈별 코멘트 스레드
-- Additive migration — does NOT modify 0001..0006. Reuses is_member()/is_admin().
-- Actor display names are stored as text (created_by_name / author_name) because
-- profiles RLS only exposes the caller's own row; the uid is kept for audit.
-- =====================================================================

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_name text,                  -- 담당자(표시용 텍스트)
  due_date date,
  file_id uuid references public.files on delete set null,  -- 선택: 관련 문서
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists issues_project_idx on public.issues (project_id, created_at desc);

create table if not exists public.issue_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues on delete cascade,
  body text not null,
  author uuid references auth.users,
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists issue_comments_issue_idx on public.issue_comments (issue_id, created_at);

-- ---------- row level security ---------------------------------------

alter table public.issues enable row level security;
alter table public.issue_comments enable row level security;

-- issues: members of the project read & write (admins all).
drop policy if exists issues_select on public.issues;
create policy issues_select on public.issues
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_insert on public.issues;
create policy issues_insert on public.issues
  for insert with check (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues
  for update using (public.is_admin() or public.is_member(project_id));

drop policy if exists issues_delete on public.issues;
create policy issues_delete on public.issues
  for delete using (public.is_admin() or public.is_member(project_id));

-- issue_comments: membership derived from the parent issue's project.
drop policy if exists issue_comments_select on public.issue_comments;
create policy issue_comments_select on public.issue_comments
  for select using (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );

drop policy if exists issue_comments_insert on public.issue_comments;
create policy issue_comments_insert on public.issue_comments
  for insert with check (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );

drop policy if exists issue_comments_delete on public.issue_comments;
create policy issue_comments_delete on public.issue_comments
  for delete using (
    public.is_admin()
    or public.is_member((select project_id from public.issues where id = issue_id))
  );

-- ===================== 0008_portal_extra.sql =====================
-- =====================================================================
-- MIR SMART — Phase 13: 포털 모듈 확장 (게시판 · 기성 · 하도급)
--   • posts          — 게시판/공지
--   • subcontracts   — 하도급(협력사) 내역
--   • project_info.contract_amount — 도급액(기성률 계산용)
-- Additive migration — does NOT modify 0001..0007. Reuses is_member()/is_admin().
-- =====================================================================

-- 도급액(계약금액). 기성내역에서 기성률 = 누적기성 / 도급액.
alter table public.project_info
  add column if not exists contract_amount numeric(16,2) not null default 0;

-- ---------- 게시판 / 공지 --------------------------------------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  title text not null,
  body text,
  pinned boolean not null default false,
  author_name text,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists posts_project_idx on public.posts (project_id, pinned desc, created_at desc);

-- ---------- 하도급(협력사) 내역 --------------------------------------
create table if not exists public.subcontracts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  company text not null,                 -- 협력사명
  trade text,                            -- 공종
  contract_amount numeric(16,2) not null default 0,  -- 계약금액
  paid_amount numeric(16,2) not null default 0,      -- 기지급액
  start_date date,
  end_date date,
  status text not null default 'active'
    check (status in ('active', 'done', 'terminated')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists subcontracts_project_idx on public.subcontracts (project_id);

-- ---------- RLS (멤버 읽기/쓰기) -------------------------------------
alter table public.posts enable row level security;
alter table public.subcontracts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['posts', 'subcontracts']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_admin() or public.is_member(project_id))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_admin() or public.is_member(project_id))', t, t);
  end loop;
end $$;

-- ===================== 0009_admin_writes.sql =====================
-- =====================================================================
-- MIR SMART — 권한 정책: 쓰기는 관리자(admin)만, 멤버는 읽기 전용
-- 사용자 결정: "모든 건 admin 계정이 진행한다." 포털/CDE/업로드의 모든
-- INSERT/UPDATE/DELETE 를 public.is_admin() 으로 제한한다. SELECT 정책은
-- 그대로(프로젝트 멤버는 전부 열람). 추가형 — 0001..0008 의 정책만 교체.
-- (멤버 협업이 필요해지면 해당 테이블 정책만 다시 is_member 로 완화하면 됨.)
-- =====================================================================

-- 표준 _insert/_update/_delete 네이밍 테이블 (멤버 → 관리자)
do $$
declare t text;
begin
  foreach t in array array[
    'folders', 'project_info', 'project_milestones', 'daily_logs',
    'monthly_records', 'issues', 'posts', 'subcontracts'
  ]
  loop
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.is_admin())', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_admin())', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_admin())', t, t);
  end loop;
end $$;

-- file_versions (insert 전용)
drop policy if exists file_versions_insert on public.file_versions;
create policy file_versions_insert on public.file_versions
  for insert with check (public.is_admin());

-- issue_comments (insert + delete)
drop policy if exists issue_comments_insert on public.issue_comments;
create policy issue_comments_insert on public.issue_comments
  for insert with check (public.is_admin());
drop policy if exists issue_comments_delete on public.issue_comments;
create policy issue_comments_delete on public.issue_comments
  for delete using (public.is_admin());

-- files (insert/update → 관리자; delete 는 이미 관리자)
drop policy if exists files_insert on public.files;
create policy files_insert on public.files
  for insert with check (public.is_admin());
drop policy if exists files_update on public.files;
create policy files_update on public.files
  for update using (public.is_admin());

-- models (insert → 관리자; delete 는 이미 관리자)
drop policy if exists models_insert on public.models;
create policy models_insert on public.models
  for insert with check (public.is_admin());

-- Storage 객체 쓰기도 관리자만 (docs / models 버킷)
drop policy if exists storage_docs_write on storage.objects;
create policy storage_docs_write on storage.objects
  for insert with check (bucket_id = 'docs' and public.is_admin());

drop policy if exists storage_models_write on storage.objects;
create policy storage_models_write on storage.objects
  for insert with check (bucket_id = 'models' and public.is_admin());

-- 비고: activity_log insert 는 멤버 허용 그대로 둔다(관리자 행위만 기록되며
-- 감사 로그가 끊기지 않도록). SELECT 정책은 전 테이블 변경 없음.

-- ===================== 0010_attachments.sql =====================
-- =====================================================================
-- MIR SMART — 범용 첨부파일 (사진/문서) : 공사일보·게시판·이슈에 연결
-- 하나의 attachments 테이블로 여러 엔티티(daily_log/post/issue)에 파일을 붙인다.
-- 바이너리는 기존 `docs` 버킷에 '<project_id>/attach/<id>.<ext>' 로 저장 →
-- 0004/0009 의 docs 정책(읽기=멤버, 쓰기=관리자)이 그대로 적용된다.
-- Additive — 0001..0009 변경 없음. 쓰기는 관리자만(D11), 읽기는 멤버.
-- =====================================================================

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  target_type text not null check (target_type in ('daily_log', 'post', 'issue')),
  target_id uuid not null,
  name text not null,
  storage_path text not null,           -- '<project_id>/attach/<id>.<ext>'
  mime_type text,
  size_bytes bigint,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index if not exists attachments_target_idx
  on public.attachments (target_type, target_id);
create index if not exists attachments_project_idx on public.attachments (project_id);

alter table public.attachments enable row level security;

-- read: project members; write: admins (D11)
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists attachments_insert on public.attachments;
create policy attachments_insert on public.attachments
  for insert with check (public.is_admin());

drop policy if exists attachments_delete on public.attachments;
create policy attachments_delete on public.attachments
  for delete using (public.is_admin());

-- ===================== 0011_billing_items.sql =====================
-- =====================================================================
-- MIR SMART — 기성 공종별 상세 (billing detail by work category)
-- 공종(토공·구조물공·포장공 등)별로 도급액 / 전월 누계 기성 / 당월 기성을
-- 관리한다. 누계 = 전월 + 당월, 기성률 = 누계 / 도급액.
-- Additive — 0001..0010 변경 없음. 읽기=멤버, 쓰기=관리자(D11).
-- =====================================================================

create table if not exists public.billing_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  category text not null,                          -- 공종
  contract_amount numeric(16,2) not null default 0, -- 공종 도급액
  prev_amount numeric(16,2) not null default 0,     -- 전월까지 누계 기성
  current_amount numeric(16,2) not null default 0,  -- 당월 기성
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists billing_items_project_idx on public.billing_items (project_id, sort_order);

alter table public.billing_items enable row level security;

drop policy if exists billing_items_select on public.billing_items;
create policy billing_items_select on public.billing_items
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists billing_items_insert on public.billing_items;
create policy billing_items_insert on public.billing_items
  for insert with check (public.is_admin());

drop policy if exists billing_items_update on public.billing_items;
create policy billing_items_update on public.billing_items
  for update using (public.is_admin());

drop policy if exists billing_items_delete on public.billing_items;
create policy billing_items_delete on public.billing_items
  for delete using (public.is_admin());

-- ===================== 0012_issue_location.sql =====================
-- =====================================================================
-- MIR SMART — 이슈에 3D 모델 객체 위치 연결 (issue ↔ model element)
-- 3D 뷰어에서 선택한 객체로 이슈를 만들고, 이슈에서 '위치 보기'로 그 객체에
-- 카메라를 맞춰 돌아올 수 있게 한다. (카메라 상태는 저장하지 않고 객체에 fit)
-- Additive — 0001..0011 변경 없음. issues 의 기존 RLS 정책이 새 컬럼도 커버한다.
-- =====================================================================

alter table public.issues
  add column if not exists model_id uuid references public.models on delete set null;
alter table public.issues
  add column if not exists express_id bigint;

-- ===================== 0013_issue_workflow.sql =====================
-- =====================================================================
-- 이슈 워크플로우(S30): 담당자 FK + 보류 상태 + 변경 이력 + 인앱 알림.
-- 쓰기는 D11(admin) 유지 + 예외 = 담당자 본인 자기 이슈 상태 변경 허용.
-- Additive · 멱등 — 0001..0012 구조 변경 없음(컬럼/제약/정책/신규 테이블).
-- =====================================================================

alter table public.issues
  add column if not exists assignee_id uuid references auth.users on delete set null;

alter table public.issues drop constraint if exists issues_status_check;
alter table public.issues
  add constraint issues_status_check
  check (status in ('open', 'in_progress', 'resolved', 'closed', 'on_hold'));

create index if not exists issues_assignee_idx on public.issues (assignee_id);

create table if not exists public.issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  kind text not null check (kind in ('created', 'status', 'assign')),
  from_value text,
  to_value text,
  actor uuid references auth.users,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists issue_events_issue_idx on public.issue_events (issue_id, created_at);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
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

alter table public.issue_events enable row level security;
alter table public.notifications enable row level security;

-- issues UPDATE: 관리자 전체 + 담당자 본인. 0009(admin-only)을 교체.
drop policy if exists issues_update on public.issues;
create policy issues_update on public.issues
  for update using (public.is_admin() or assignee_id = auth.uid());

drop policy if exists issue_events_select on public.issue_events;
create policy issue_events_select on public.issue_events
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists issue_events_insert on public.issue_events;
create policy issue_events_insert on public.issue_events
  for insert with check (public.is_admin() or public.is_member(project_id));

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

-- ===================== 0014_doc_delete_owner.sql =====================
-- =====================================================================
-- S31 / D12: CDE 문서 삭제 권한 완화 (업로더 본인 + 관리자).
-- D11(쓰기=admin)의 예외. files / docs 버킷 삭제 정책을
--   uploaded_by = auth.uid() OR is_admin() 로 완화.
-- Additive · 멱등 — 0001..0013 구조 변경 없음(정책만 교체/추가).
-- =====================================================================

drop policy if exists files_delete on public.files;
create policy files_delete on public.files
  for delete using (uploaded_by = auth.uid() or public.is_admin());

create or replace function public.owns_doc_object(obj_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.files f
    where f.uploaded_by = auth.uid()
      and (
        f.storage_path = obj_name
        or exists (
          select 1 from public.file_versions v
          where v.file_id = f.id and v.storage_path = obj_name
        )
      )
  );
$$;

drop policy if exists storage_docs_delete on storage.objects;
create policy storage_docs_delete on storage.objects
  for delete using (
    bucket_id = 'docs'
    and (public.is_admin() or public.owns_doc_object(name))
  );

notify pgrst, 'reload schema';

-- ===================== 0015_clash.sql =====================

-- ---------- 간섭 테스트(설정 + 실행 1회) ----------------------------
create table if not exists public.clash_tests (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  name        text not null,
  -- 대상 집합 라벨(예: '모델: 구조', '카테고리: IFCWALL', '전체'). 표시용.
  set_a       text,
  set_b       text,
  -- 'hard' | 'clearance'
  type        text not null default 'hard',
  tolerance   numeric not null default 0,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists clash_tests_project_idx on public.clash_tests (project_id, created_at desc);

-- ---------- 개별 간섭 ------------------------------------------------
create table if not exists public.clashes (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid not null references public.clash_tests (id) on delete cascade,
  -- 요소 A: 어느 DB 모델(있으면)·런타임 expressID·표시 이름/카테고리.
  model_a     uuid references public.models (id) on delete set null,
  express_a   integer,
  name_a      text,
  category_a  text,
  -- 요소 B.
  model_b     uuid references public.models (id) on delete set null,
  express_b   integer,
  name_b      text,
  category_b  text,
  -- 간섭 지점(월드 좌표) + 근사 관통깊이/이격(m).
  point_x     double precision,
  point_y     double precision,
  point_z     double precision,
  depth       double precision,
  -- 'new' | 'reviewing' | 'resolved' | 'approved'
  status      text not null default 'new',
  -- 간섭 → 이슈 전환 시 연결(0007 issues).
  issue_id    uuid references public.issues (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists clashes_test_idx on public.clashes (test_id);

-- ---------- row level security --------------------------------------
alter table public.clash_tests enable row level security;
alter table public.clashes enable row level security;

-- clash_tests: 멤버 읽기, admin 쓰기(D11).
drop policy if exists clash_tests_select on public.clash_tests;
create policy clash_tests_select on public.clash_tests
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists clash_tests_insert on public.clash_tests;
create policy clash_tests_insert on public.clash_tests
  for insert with check (public.is_admin());

drop policy if exists clash_tests_update on public.clash_tests;
create policy clash_tests_update on public.clash_tests
  for update using (public.is_admin());

drop policy if exists clash_tests_delete on public.clash_tests;
create policy clash_tests_delete on public.clash_tests
  for delete using (public.is_admin());

-- clashes: 멤버 읽기, admin 쓰기. 멤버십은 부모 테스트의 project 로 판정.
drop policy if exists clashes_select on public.clashes;
create policy clashes_select on public.clashes
  for select using (
    exists (
      select 1 from public.clash_tests t
      where t.id = clashes.test_id
        and (public.is_admin() or public.is_member(t.project_id))
    )
  );

drop policy if exists clashes_insert on public.clashes;
create policy clashes_insert on public.clashes
  for insert with check (public.is_admin());

drop policy if exists clashes_update on public.clashes;
create policy clashes_update on public.clashes
  for update using (public.is_admin());

drop policy if exists clashes_delete on public.clashes;
create policy clashes_delete on public.clashes
  for delete using (public.is_admin());

notify pgrst, 'reload schema';

-- ===================== 0016_model_purpose.sql =====================

alter table public.models
  add column if not exists purpose text not null default 'integrated';

alter table public.models drop constraint if exists models_purpose_check;
alter table public.models
  add constraint models_purpose_check
  check (purpose in ('integrated', '4d', 'clash'));

create index if not exists models_project_purpose_idx
  on public.models (project_id, purpose);

notify pgrst, 'reload schema';

-- ===================== 0017_viewpoints.sql =====================

create table if not exists public.viewpoints (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  model_id    uuid references public.models (id) on delete set null,
  name        text not null,
  camera      jsonb not null default '{}'::jsonb,
  display     jsonb not null default '{}'::jsonb,
  markup      jsonb not null default '[]'::jsonb,
  thumbnail   text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists viewpoints_project_idx
  on public.viewpoints (project_id, created_at desc);

alter table public.issues
  add column if not exists viewpoint_id uuid references public.viewpoints (id) on delete set null;

alter table public.viewpoints enable row level security;

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


-- ===================== 0018_drawings.sql =====================
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

-- ===================== 0019_bim_folders.sql =====================
-- CDE 폴더 종류(문서/BIM) + 통합모델 연동 기반. 추가형·멱등.
alter table public.folders
  add column if not exists kind text not null default 'doc';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'folders_kind_check') then
    alter table public.folders
      add constraint folders_kind_check check (kind in ('doc', 'bim'));
  end if;
end $$;
create index if not exists folders_kind_idx on public.folders (project_id, kind);

alter table public.models
  add column if not exists file_id uuid references public.files on delete set null;
alter table public.models
  add column if not exists version_id uuid references public.file_versions on delete set null;
alter table public.models
  add column if not exists bucket text not null default 'models';
create index if not exists models_file_idx on public.models (file_id);

insert into public.folders (project_id, parent_id, name, kind)
select p.id, null, 'BIM 데이터', 'bim'
from public.projects p
where not exists (
  select 1 from public.folders f
  where f.project_id = p.id and f.parent_id is null and f.kind = 'bim'
);

drop policy if exists storage_models_delete on storage.objects;
create policy storage_models_delete on storage.objects
  for delete using (bucket_id = 'models' and public.is_admin());

notify pgrst, 'reload schema';

-- ===================== 0020_acc_mapping.sql =====================
alter table public.projects add column if not exists acc_hub_id text;
alter table public.projects add column if not exists acc_project_id text;
alter table public.projects add column if not exists acc_default_urn text;
alter table public.projects add column if not exists acc_default_name text;

-- ===================== 0021_acc_root_folder.sql =====================
alter table public.projects add column if not exists acc_root_folder_id text;
alter table public.projects add column if not exists acc_root_folder_name text;

-- ===================== 0022_acc_storage.sql =====================
alter table public.files add column if not exists source text not null default 'supabase';
alter table public.files add column if not exists acc_item_urn text;
alter table public.files add column if not exists acc_version_urn text;
alter table public.files alter column storage_path drop not null;
create index if not exists files_project_source_idx on public.files (project_id, source);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_source_chk') then
    alter table public.files
      add constraint files_source_chk check (source in ('supabase', 'acc'));
  end if;
end $$;

notify pgrst, 'reload schema';

-- ===================== 0023_rbac.sql =====================
-- 0023_rbac.sql — 역할 기반 접근제어(RBAC): 뷰어 / 실무자 / 관리자 / 시스템 관리자.
--
-- project_members.role(viewer/editor/admin, 0001 부터 존재) 를 실제 쓰기 권한에
-- 연결한다. 그동안 0009 가 모든 쓰기를 글로벌 is_admin 으로 막았던 것을 프로젝트
-- 역할로 풀어준다.
--
--   뷰어(viewer)        : 읽기·미리보기만(다운로드 버튼은 UI 에서 숨김).
--   실무자(editor)      : 콘텐츠 쓰기 전부(업로드·수정·삭제·버전 등).
--   관리자(admin, 프로젝트): 실무자 + 프로젝트 설정 + 역할 부여(멤버 role 지정).
--                          단, 상위인 시스템 관리자 멤버는 건드릴 수 없음.
--   시스템 관리자(profiles.is_admin): 최상위 — 전 프로젝트·사용자 관리.
--
-- 추가형: 기존 정책을 '교체'만 한다(SELECT 정책·읽기 범위는 그대로 멤버 전체).
-- 안전성: 비-역할 사용자는 기존처럼 읽기전용(viewer) → 회귀 없음. editor/admin 으로
-- 명시 지정된 사용자만 쓰기를 얻는다.

-- ----------------------------------------------------------------------
-- 1) 헬퍼 (SECURITY DEFINER — RLS 재귀 회피, is_member 패턴과 동일)
-- ----------------------------------------------------------------------
create or replace function public.is_editor(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.project_members
    where project_id = p and user_id = auth.uid() and role in ('editor', 'admin')
  );
$$;

create or replace function public.is_project_admin(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.project_members
    where project_id = p and user_id = auth.uid() and role = 'admin'
  );
$$;

-- 대상 사용자가 시스템 관리자인지(프로젝트 관리자가 못 건드리게 가드).
create or replace function public.user_is_system_admin(uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

-- ----------------------------------------------------------------------
-- 2) 콘텐츠 테이블(직접 project_id 보유): 쓰기 = 실무자(editor)
--    기존 비-SELECT 정책을 모두 제거 후 표준 정책 재생성(누락 잔존 정책 방지).
--    files·issues 는 소유자/담당자 특례가 있어 아래에서 개별 처리(여기서 제외).
-- ----------------------------------------------------------------------
do $$
declare
  t text;
  p record;
  content_tables text[] := array[
    'folders','project_info','project_milestones','daily_logs','monthly_records',
    'posts','subcontracts','billing_items','viewpoints','drawings','clash_tests',
    'attachments','schedules','issue_events','drawing_pins','models'
  ];
begin
  foreach t in array content_tables loop
    -- 기존 쓰기 정책 일괄 제거
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t and cmd <> 'SELECT'
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    -- 표준 쓰기 정책(실무자)
    execute format('create policy %I_insert on public.%I for insert with check (public.is_editor(project_id))', t, t);
    execute format('create policy %I_update on public.%I for update using (public.is_editor(project_id)) with check (public.is_editor(project_id))', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.is_editor(project_id))', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------
-- 3) files — 쓰기 = 실무자, 삭제 = 실무자 또는 업로더 본인(D12/D14 보존)
-- ----------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select policyname from pg_policies
    where schemaname='public' and tablename='files' and cmd <> 'SELECT'
  loop execute format('drop policy %I on public.files', p.policyname); end loop;
end $$;
create policy files_insert on public.files
  for insert with check (public.is_editor(project_id));
create policy files_update on public.files
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));
create policy files_delete on public.files
  for delete using (public.is_editor(project_id) or uploaded_by = auth.uid());

-- ----------------------------------------------------------------------
-- 4) issues — 쓰기 = 실무자, 수정 = 실무자 또는 담당자 본인(D13 보존)
-- ----------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select policyname from pg_policies
    where schemaname='public' and tablename='issues' and cmd <> 'SELECT'
  loop execute format('drop policy %I on public.issues', p.policyname); end loop;
end $$;
create policy issues_insert on public.issues
  for insert with check (public.is_editor(project_id));
create policy issues_update on public.issues
  for update using (public.is_editor(project_id) or assignee_id = auth.uid());
create policy issues_delete on public.issues
  for delete using (public.is_editor(project_id));

-- ----------------------------------------------------------------------
-- 5) 조인 테이블(project_id 가 부모에 있음) — 부모로 실무자 판정
-- ----------------------------------------------------------------------
-- file_versions → files.project_id
drop policy if exists file_versions_insert on public.file_versions;
create policy file_versions_insert on public.file_versions
  for insert with check (
    public.is_editor((select project_id from public.files where id = file_id))
  );
drop policy if exists file_versions_delete on public.file_versions;
create policy file_versions_delete on public.file_versions
  for delete using (
    public.is_editor((select project_id from public.files where id = file_id))
  );

-- issue_comments → issues.project_id
drop policy if exists issue_comments_insert on public.issue_comments;
create policy issue_comments_insert on public.issue_comments
  for insert with check (
    public.is_editor((select project_id from public.issues where id = issue_id))
  );
drop policy if exists issue_comments_delete on public.issue_comments;
create policy issue_comments_delete on public.issue_comments
  for delete using (
    public.is_editor((select project_id from public.issues where id = issue_id))
  );

-- clashes → clash_tests.project_id
do $$
declare p record;
begin
  for p in select policyname from pg_policies
    where schemaname='public' and tablename='clashes' and cmd <> 'SELECT'
  loop execute format('drop policy %I on public.clashes', p.policyname); end loop;
end $$;
create policy clashes_insert on public.clashes
  for insert with check (
    public.is_editor((select project_id from public.clash_tests where id = test_id))
  );
create policy clashes_update on public.clashes
  for update using (
    public.is_editor((select project_id from public.clash_tests where id = test_id))
  );
create policy clashes_delete on public.clashes
  for delete using (
    public.is_editor((select project_id from public.clash_tests where id = test_id))
  );

-- task_elements → models.project_id
do $$
declare p record;
begin
  for p in select policyname from pg_policies
    where schemaname='public' and tablename='task_elements' and cmd <> 'SELECT'
  loop execute format('drop policy %I on public.task_elements', p.policyname); end loop;
end $$;
create policy task_elements_insert on public.task_elements
  for insert with check (
    public.is_editor((select project_id from public.models where id = model_id))
  );
create policy task_elements_update on public.task_elements
  for update using (
    public.is_editor((select project_id from public.models where id = model_id))
  );
create policy task_elements_delete on public.task_elements
  for delete using (
    public.is_editor((select project_id from public.models where id = model_id))
  );

-- ----------------------------------------------------------------------
-- 6) Storage 객체 — 경로 첫 세그먼트(<project_id>/...) 로 실무자 판정
-- ----------------------------------------------------------------------
-- docs: 쓰기 = 실무자
drop policy if exists storage_docs_write on storage.objects;
create policy storage_docs_write on storage.objects
  for insert with check (
    bucket_id = 'docs' and public.is_editor((split_part(name, '/', 1))::uuid)
  );
-- docs 삭제 = 실무자 또는 문서 소유자(0014 owns_doc_object 보존)
drop policy if exists storage_docs_delete on storage.objects;
create policy storage_docs_delete on storage.objects
  for delete using (
    bucket_id = 'docs'
    and (public.is_editor((split_part(name, '/', 1))::uuid) or public.owns_doc_object(name))
  );
-- models: 쓰기·삭제 = 실무자
drop policy if exists storage_models_write on storage.objects;
create policy storage_models_write on storage.objects
  for insert with check (
    bucket_id = 'models' and public.is_editor((split_part(name, '/', 1))::uuid)
  );
drop policy if exists storage_models_delete on storage.objects;
create policy storage_models_delete on storage.objects
  for delete using (
    bucket_id = 'models' and public.is_editor((split_part(name, '/', 1))::uuid)
  );

-- ----------------------------------------------------------------------
-- 7) 설정·역할 = 프로젝트 관리자(admin) 또는 시스템 관리자
-- ----------------------------------------------------------------------
-- projects: 설정 변경(이름·ACC 고정 등) = 프로젝트 관리자. 생성/삭제는 시스템 관리자만.
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update using (public.is_project_admin(id)) with check (public.is_project_admin(id));

-- project_members: 역할 부여 = 프로젝트 관리자. 단, 시스템 관리자 멤버는 보호.
-- 먼저 SELECT — 프로젝트 관리자가 자기 프로젝트의 멤버 목록을 볼 수 있어야 역할 관리 가능.
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (
    user_id = auth.uid() or public.is_admin() or public.is_project_admin(project_id)
  );
drop policy if exists members_insert on public.project_members;
create policy members_insert on public.project_members
  for insert with check (
    public.is_admin()
    or (public.is_project_admin(project_id) and not public.user_is_system_admin(user_id))
  );
drop policy if exists members_update on public.project_members;
create policy members_update on public.project_members
  for update using (
    public.is_admin()
    or (public.is_project_admin(project_id) and not public.user_is_system_admin(user_id))
  ) with check (
    public.is_admin()
    or (public.is_project_admin(project_id) and not public.user_is_system_admin(user_id))
  );
drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members
  for delete using (
    public.is_admin()
    or (public.is_project_admin(project_id) and not public.user_is_system_admin(user_id))
  );

-- profiles update(시스템 관리자 플래그·표시명)은 시스템 관리자만 — 0002 그대로 유지.

notify pgrst, 'reload schema';

-- ===================== 0024_protect_system_admin.sql =====================
create or replace function public.guard_is_admin()
returns trigger language plpgsql as $$
begin
  if new.is_admin is distinct from old.is_admin
     and current_user not in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    raise exception '시스템 관리자(is_admin)는 앱에서 변경할 수 없습니다. Supabase에서만 관리하세요.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_is_admin on public.profiles;
create trigger trg_guard_is_admin
  before update on public.profiles
  for each row execute function public.guard_is_admin();

notify pgrst, 'reload schema';

-- ===================== 0025_project_settings_sysadmin.sql =====================
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';

-- ===================== 0026_issue_global_id.sql =====================
alter table public.issues
  add column if not exists global_id text;
create index if not exists issues_global_id_idx
  on public.issues (project_id, global_id);

notify pgrst, 'reload schema';

-- ===================== 0027_clash_global_id.sql =====================
alter table public.clashes
  add column if not exists global_id_a text;
alter table public.clashes
  add column if not exists global_id_b text;
create index if not exists clashes_global_id_idx
  on public.clashes (global_id_a, global_id_b);

notify pgrst, 'reload schema';

-- ===================== 0028_issue_clash_anchor.sql =====================
alter table public.issues
  add column if not exists global_id_b text;

notify pgrst, 'reload schema';

-- ===================== 0029_task_elements_global_id.sql =====================
alter table public.task_elements
  add column if not exists global_id text;
alter table public.task_elements
  alter column express_id drop not null;
alter table public.task_elements
  drop constraint if exists task_elements_express_or_global_chk;
alter table public.task_elements
  add constraint task_elements_express_or_global_chk
  check (express_id is not null or global_id is not null);
create index if not exists task_elements_global_id_idx
  on public.task_elements (model_id, global_id);
create unique index if not exists task_elements_global_unique_idx
  on public.task_elements (task_id, model_id, global_id)
  where global_id is not null;

notify pgrst, 'reload schema';

-- ===================== 0030_acc_4d_default.sql =====================
alter table public.projects
  add column if not exists acc_4d_urn text;
alter table public.projects
  add column if not exists acc_4d_name text;

notify pgrst, 'reload schema';
