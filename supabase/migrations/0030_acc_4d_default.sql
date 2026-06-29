-- =====================================================================
-- MIR SMART — 공정관리(4D) 전용 고정 모델(acc_4d_urn/name) — S51.
-- 0020 의 acc_default_urn/name 은 통합모델/간섭체크가 공유하는 기본 모델이다.
-- 사용자 요청: 공정관리(4D)는 ACC 폴더 트리를 화면에서 없애고, 관리자가 상단
-- 메뉴의 전용 버튼으로 ACC 폴더에서 시뮬레이션용 모델을 골라 "고정뷰"로 지정하게
-- 한다 — 통합모델 기본값과 독립적으로. 추가형·멱등.
-- =====================================================================

alter table public.projects
  add column if not exists acc_4d_urn text;

alter table public.projects
  add column if not exists acc_4d_name text;
