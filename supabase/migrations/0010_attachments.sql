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
