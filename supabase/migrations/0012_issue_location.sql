-- =====================================================================
-- MIR SMART — 이슈에 3D 모델 객체 위치 연결 (issue ↔ model element)
-- 3D 뷰어에서 선택한 객체로 이슈를 만들고, 이슈에서 '위치 보기'로 그 객체에
-- 카메라를 맞춰 돌아올 수 있게 한다. (카메라 상태는 저장하지 않고 객체에 fit)
-- Additive — 0001..0011 변경 없음. issues 의 기존 RLS 정책이 새 컬럼도 커버한다.
-- =====================================================================

alter table public.issues
  add column if not exists model_id uuid references public.models on delete set null;
alter table public.issues
  add column if not exists express_id bigint;
