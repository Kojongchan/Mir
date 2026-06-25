-- =====================================================================
-- MIR SMART — 이슈에 APS GlobalId(=externalId) 앵커 추가 — S49.
-- APS/ACC 뷰어 전환에 따라, 이슈가 가리키는 3D 객체를 web-ifc expressID(0012)
-- 대신 **GlobalId(IFC GlobalId / Revit UniqueId = APS externalId)** 로 앵커링한다.
-- 이슈 핀(3D 오버레이)·'위치 보기'(GlobalId→dbId isolate+fit)가 이 컬럼에 의존.
-- 추가형·멱등 — 0012 의 model_id/express_id 는 보존(IFC 백업 경로 유지).
-- 기존 expressID 저장분은 신규부터 GlobalId 로 전환(과거분 백필은 별도 협의).
-- =====================================================================

alter table public.issues
  add column if not exists global_id text;

create index if not exists issues_global_id_idx
  on public.issues (project_id, global_id);
