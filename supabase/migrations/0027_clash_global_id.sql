-- =====================================================================
-- MIR SMART — 간섭 결과에 APS GlobalId(=externalId) 저장키 추가 — S49.
-- APS Viewer 위에서 검출한 간섭은 web-ifc expressID(0015) 대신 요소 A/B 의
-- **GlobalId** 로 영속화한다(모델 재로드·세션 무관 재현). 시각화/이슈연계가
-- GlobalId→dbId 해석으로 동작. 추가형·멱등 — 0015 의 express_a/express_b·
-- model_a/model_b 는 보존(IFC 백업 경로). 신규 간섭부터 GlobalId 를 채운다.
-- =====================================================================

alter table public.clashes
  add column if not exists global_id_a text;
alter table public.clashes
  add column if not exists global_id_b text;

create index if not exists clashes_global_id_idx
  on public.clashes (global_id_a, global_id_b);
