-- 0020_acc_mapping.sql — 프로젝트별 ACC(Autodesk) 고정 매핑 (추가형·멱등).
--
-- 관리자가 각 MIR 프로젝트에 ACC 허브/프로젝트를 고정하면, 일반 사용자는 그
-- 범위만(전체 ACC 탐색 없이) 보게 된다. acc_default_urn = '통합/기본으로 열릴'
-- 대표 모델(base64 URN). 권한은 projects 테이블 정책을 그대로 상속
-- (select = 멤버, update = 관리자 — 0001/0002).

alter table public.projects add column if not exists acc_hub_id text;
alter table public.projects add column if not exists acc_project_id text;
alter table public.projects add column if not exists acc_default_urn text;
alter table public.projects add column if not exists acc_default_name text;

-- PostgREST 스키마 캐시 갱신
notify pgrst, 'reload schema';
