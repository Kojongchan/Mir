-- =====================================================================
-- MIR SMART — 모델 용도 분리 (통합모델 3D / 공정관리 4D / 간섭체크) — S33.
-- 한 프로젝트의 IFC 모델을 용도별로 구분한다. 같은 3D 모델이라도 4D·간섭체크는
-- 공정표 매핑/간섭 검토에 전념하도록 각 모듈이 자기 모델 세트만 본다(사용자 결정).
--   • models.purpose — 'integrated'(통합모델 3D, 기본) | '4d'(공정관리) | 'clash'(간섭체크).
-- 기존 모델은 모두 'integrated' 로 백필(통합모델에서 그대로 보임).
-- Additive · 멱등 — 0001..0015 구조 변경 없음(컬럼/인덱스만 추가).
-- =====================================================================

alter table public.models
  add column if not exists purpose text not null default 'integrated';

alter table public.models drop constraint if exists models_purpose_check;
alter table public.models
  add constraint models_purpose_check
  check (purpose in ('integrated', '4d', 'clash'));

create index if not exists models_project_purpose_idx
  on public.models (project_id, purpose);

notify pgrst, 'reload schema';
