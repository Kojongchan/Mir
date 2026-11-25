-- 0043: 현장별 통합모델(3D) 뷰어.
--   null  = 자체 엔진(three.js + 3D Tiles). 지정 모델에 자체 엔진 타일이 아직 없으면 기존 뷰어로 대신 연다.
--   'aps' = 기존 Autodesk(APS) 뷰어 고정 — 관리자 콘솔 > 현장 > 메뉴 에서 바꾼다.
-- 관리자만 바꿀 수 있다(projects update RLS, 0025). 앱은 이 열이 없어도(미적용) 자체 엔진 + 대체로 동작한다.
alter table public.projects add column if not exists viewer_engine text;

alter table public.projects drop constraint if exists projects_viewer_engine_check;
alter table public.projects
  add constraint projects_viewer_engine_check check (viewer_engine is null or viewer_engine in ('aps'));

-- 지금 기존 뷰어로 현장에 공유 중인 현장(2026-11-23 공유 시작)은 그대로 기존 뷰어.
update public.projects set viewer_engine = 'aps'
 where viewer_engine is null and name like '남양주왕숙%';

notify pgrst, 'reload schema';
