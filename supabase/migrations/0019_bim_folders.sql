-- =====================================================================
-- MIR SMART — S45: CDE 폴더 종류(문서 / BIM 데이터) + 통합모델 연동 기반
-- 자료관리(CDE) 폴더트리를 최상위에서 "문서 / BIM 데이터"로 나누고, BIM 데이터
-- 하위에 올린 IFC를 통합모델(3D)이 그대로 소비할 수 있도록 기반을 마련한다.
-- 추가형 마이그레이션 — 0001..0018 을 수정하지 않는다. 기존 폴더는 모두 'doc'.
-- =====================================================================

-- ---------- folders.kind ('doc' | 'bim') -----------------------------
-- 폴더의 종류. 하위 폴더는 생성 시 부모의 kind 를 물려받도록 앱(cde.ts)에서
-- 처리한다. 기존 폴더는 기본 'doc' 라서 자료관리 "문서" 섹션에 그대로 보인다.
alter table public.folders
  add column if not exists kind text not null default 'doc';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folders_kind_check'
  ) then
    alter table public.folders
      add constraint folders_kind_check check (kind in ('doc', 'bim'));
  end if;
end $$;

create index if not exists folders_kind_idx on public.folders (project_id, kind);

-- ---------- models ↔ CDE 파일 연동 컬럼 -------------------------------
-- 통합모델은 앞으로 별도 업로드 대신 CDE 의 BIM 파일/버전을 가리킨다(후속 단계).
-- 지금은 컬럼만 추가(추가형) — 기존 동작은 그대로. bucket 으로 어느 스토리지
-- 버킷에서 바이트를 받을지 구분('models' 레거시 / 'docs' CDE).
alter table public.models
  add column if not exists file_id uuid references public.files on delete set null;
alter table public.models
  add column if not exists version_id uuid references public.file_versions on delete set null;
alter table public.models
  add column if not exists bucket text not null default 'models';

create index if not exists models_file_idx on public.models (file_id);

-- ---------- BIM 데이터 최상위 폴더 시드 -------------------------------
-- 프로젝트마다 'BIM 데이터'(kind=bim) 최상위 폴더가 없으면 하나 만든다.
-- (문서는 기존 폴더/미분류가 'doc' 섹션에 그대로 들어가므로 별도 시드 불필요.)
insert into public.folders (project_id, parent_id, name, kind)
select p.id, null, 'BIM 데이터', 'bim'
from public.projects p
where not exists (
  select 1 from public.folders f
  where f.project_id = p.id and f.parent_id is null and f.kind = 'bim'
);

-- ---------- models 스토리지 객체 삭제 정책(관리자) --------------------
-- 0001/0009 는 models 버킷에 read/insert 만 있었다. 관리자가 모델을 완전히
-- 삭제(행 + 스토리지 객체)할 수 있도록 delete 정책을 추가한다.
drop policy if exists storage_models_delete on storage.objects;
create policy storage_models_delete on storage.objects
  for delete using (bucket_id = 'models' and public.is_admin());
