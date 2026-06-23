-- 0021_acc_root_folder.sql — 프로젝트 ACC 시작 폴더 고정 (추가형·멱등).
--
-- 0020(허브/프로젝트 고정)에 이어, 관리자가 특정 폴더(예: 'Project Files')를
-- 시작 폴더로 고정하면 사용자는 그 안쪽만 보게 된다(ACC 내부 폴더 Photos/
-- submittals 등 노출 방지). 권한은 projects 정책 상속.

alter table public.projects add column if not exists acc_root_folder_id text;
alter table public.projects add column if not exists acc_root_folder_name text;

notify pgrst, 'reload schema';
