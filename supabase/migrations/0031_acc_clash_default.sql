-- =====================================================================
-- MIR SMART — 간섭체크 전용 고정 모델(acc_clash_urn/name) — S52.
-- 0020 의 acc_default_urn/name = 통합모델(3D) 전용 고정 모델,
-- 0030 의 acc_4d_urn/name = 공정관리(4D) 전용 고정 모델.
-- 본 마이그레이션은 간섭체크 전용 고정 모델을 추가한다 — 세 메뉴(통합/4D/간섭)가
-- 각자 독립된 ACC 모델을 자료관리에서 지정해 운용하도록. 추가형·멱등.
-- =====================================================================

alter table public.projects
  add column if not exists acc_clash_urn text;

alter table public.projects
  add column if not exists acc_clash_name text;
