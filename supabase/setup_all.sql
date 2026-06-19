-- =====================================================================
-- MIR SMART — 통합 셋업 SQL (0005~0009 한 번에 실행)
-- Supabase 대시보드 → SQL Editor 에 '전체 복사 → 붙여넣기 → Run'.
-- 모두 멱등(재실행 안전). 새 Storage 버킷 불필요(docs/models 재사용).
-- 마지막 줄에서 PostgREST 스키마 캐시를 강제로 새로고침합니다.
-- =====================================================================

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

-- 스키마 캐시 새로고침 (이게 없으면 'schema cache' 오류가 남을 수 있음)
notify pgrst, 'reload schema';
