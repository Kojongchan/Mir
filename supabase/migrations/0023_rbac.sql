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
