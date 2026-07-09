-- =====================================================================
-- MIR SMART — 이슈 첨부를 자료관리(ACC) 파일 링크로 전환
--
-- 사용자 요청: 이슈에 개인 파일을 직접 올려 흩어지지 않게, **자료관리(ACC)에 있는
-- 파일만** 링크해 첨부한다. 첨부 옆에 파일의 폴더 위치를 표시하고, 클릭하면 자료관리
-- 해당 폴더로 이동한다. 직접 업로드도 ACC 폴더를 골라 올린 뒤 링크로 연결한다.
--
--   • issue_file_link — 이슈 ↔ ACC 아이템 링크(아이템 id·urn·이름 + 폴더 경로).
--     폴더 경로는 자료관리 딥링크(정확한 폴더 펼침)를 위해 조상 폴더 id 배열과
--     표시용 이름 배열을 함께 저장한다.
--
-- 추가형 · 멱등 — 0001..0034 무수정. 쓰기 = 실무자(is_editor). 읽기 = 멤버.
-- =====================================================================

create table if not exists public.issue_file_link (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  issue_id       uuid not null references public.issues (id) on delete cascade,
  -- ACC 참조 — 파일을 다시 열려면 ACC 프로젝트 + 아이템 id 가 필요.
  acc_project_id text not null,
  acc_item_id    text not null,
  acc_urn        text,            -- 모델이면 뷰어용 urn(있을 때)
  name           text not null,
  -- 폴더 위치 — 딥링크 펼침용 조상 폴더 id 체인 + 표시용 이름 체인(최상위→대상).
  folder_id      text,
  folder_ids     text[] not null default '{}',
  folder_names   text[] not null default '{}',
  added_by       uuid references auth.users (id) on delete set null,
  added_by_name  text,
  created_at     timestamptz not null default now()
);
create index if not exists issue_file_link_issue_idx on public.issue_file_link (issue_id, created_at);

alter table public.issue_file_link enable row level security;

drop policy if exists issue_file_link_select on public.issue_file_link;
create policy issue_file_link_select on public.issue_file_link
  for select using (public.is_admin() or public.is_member(project_id));

drop policy if exists issue_file_link_insert on public.issue_file_link;
create policy issue_file_link_insert on public.issue_file_link
  for insert with check (public.is_editor(project_id));

drop policy if exists issue_file_link_delete on public.issue_file_link;
create policy issue_file_link_delete on public.issue_file_link
  for delete using (public.is_editor(project_id));

notify pgrst, 'reload schema';
