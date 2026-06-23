-- 0022_acc_storage.sql — 자료관리 ACC 일원화: ACC 파일 메타 매핑 (추가형·멱등).
--
-- S47: 신규 업로드 저장소를 ACC(Autodesk Construction Cloud)로 일원화한다.
-- 바이너리는 ACC Data Management 에 저장되고, 우리 `files` 테이블에는 그 ACC
-- 아이템을 가리키는 **메타 행**을 남겨 CDE 상태(WIP/Shared/Published/Archived)·
-- 활동로그·이슈첨부가 ACC 파일에도 붙도록 한다(기존 Supabase docs 와 공존).
--
--  - source       : 'supabase'(기존 docs 버킷) | 'acc'(ACC Data Management). 기본 supabase.
--  - acc_item_urn : ACC 아이템 id (urn:adsk.wipprod:dm.lineage:...). 종류별 분기·열기 키.
--  - acc_version_urn : 업로드된 버전 id(또는 base64 뷰어 URN). 버전 이력 매핑용.
--
-- 0022 미적용 시: source 컬럼이 없으므로 데이터층이 레거시(전부 supabase)로 폴백 →
-- 기존 동작 유지. RLS 는 0009(쓰기=admin, D11) / 0014(삭제=업로더·admin, D12) 를 그대로 상속.

alter table public.files add column if not exists source text not null default 'supabase';
alter table public.files add column if not exists acc_item_urn text;
alter table public.files add column if not exists acc_version_urn text;

-- ACC 파일은 docs 버킷에 바이너리가 없으므로 storage_path 가 비어 있을 수 있다.
alter table public.files alter column storage_path drop not null;

-- 종류별(supabase/acc) 조회를 위해 인덱스 추가.
create index if not exists files_project_source_idx on public.files (project_id, source);

-- source 값 가드(기존 행은 default 로 'supabase').
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'files_source_chk'
  ) then
    alter table public.files
      add constraint files_source_chk check (source in ('supabase', 'acc'));
  end if;
end $$;

-- PostgREST 스키마 캐시 갱신
notify pgrst, 'reload schema';
