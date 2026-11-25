-- 0042_project_menus_model_lineage.sql — 현장별 메뉴 + 고정 모델의 ACC 아이템 (추가형·멱등).
--
-- 1) enabled_menus: 이 현장에서 보일 메뉴 키 목록(src/lib/projectMenus.ts 의 key).
--    null = 전체 메뉴(지금까지와 같음). 시스템 관리자가 관리자 콘솔에서 고른다.
--    권한은 projects 정책을 그대로 따른다(select = 멤버, update = 시스템 관리자 — 0025).
-- 2) acc_*_item_id: 메뉴별 고정 모델의 ACC 아이템(파일 계보) ID. 같은 파일에 새 버전(V2…)이
--    올라오면 뷰어가 이 아이템의 최신 버전을 연다. 이름이 다른 새 파일은 별도 아이템이라
--    관리자가 다시 고정한다. 비어 있으면(0042 이전에 고정한 모델) 고정한 버전 그대로 연다.

alter table public.projects add column if not exists enabled_menus text[];
alter table public.projects add column if not exists acc_default_item_id text;
alter table public.projects add column if not exists acc_4d_item_id text;
alter table public.projects add column if not exists acc_clash_item_id text;

notify pgrst, 'reload schema';
