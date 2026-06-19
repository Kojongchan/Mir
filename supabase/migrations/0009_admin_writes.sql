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
