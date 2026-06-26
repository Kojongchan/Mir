-- =====================================================================
-- MIR SMART — task_elements 에 APS GlobalId(=externalId) 저장키 추가 — S50.
-- 4D 시공 시뮬레이션을 APS(ACC) Viewer 위로 이식: APS dbId 는 세션마다 휘발성
-- (모델 재로드 시 바뀜)이라 영속 매핑 키로 쓸 수 없다. S49(0026/0027)와 동일하게
-- **GlobalId** 를 저장키로 추가한다. 추가형·멱등 — express_id 경로(0003)는 보존
-- (web-ifc 백업 경로). 신규(APS) 매핑부터 global_id 를 채운다.
--
-- express_id 는 GlobalId 전용 행에서는 의미가 없으므로 not null 제약을 완화하고,
-- "express_id 또는 global_id 중 하나는 있어야 한다" 체크로 대체한다.
-- =====================================================================

alter table public.task_elements
  add column if not exists global_id text;

alter table public.task_elements
  alter column express_id drop not null;

alter table public.task_elements
  drop constraint if exists task_elements_express_or_global_chk;
alter table public.task_elements
  add constraint task_elements_express_or_global_chk
  check (express_id is not null or global_id is not null);

create index if not exists task_elements_global_id_idx
  on public.task_elements (model_id, global_id);

-- express_id 가 null(=GlobalId 행)인 경우 기존 unique(task_id, model_id, express_id)
-- 는 effectively 비활성(postgres 는 null 을 서로 다르다고 봄) → 중복 방지용 부분 인덱스.
create unique index if not exists task_elements_global_unique_idx
  on public.task_elements (task_id, model_id, global_id)
  where global_id is not null;
