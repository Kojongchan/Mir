-- =====================================================================
-- MIR SMART — 이슈 변경이력 확장: 내용·우선순위·마감·파일·코멘트 이벤트
--
-- 사용자 요청: 변경이력에 내용 변경·속성(우선순위/마감) 변경·파일 추가·파일 다운로드·
-- 코멘트 추가까지 남긴다. 0013 의 issue_events.kind 체크(created/status/assign)를
-- 확장한다.
--
-- 추가형 · 멱등 — 0001..0035 무수정.
-- =====================================================================

alter table public.issue_events drop constraint if exists issue_events_kind_check;
alter table public.issue_events
  add constraint issue_events_kind_check
  check (kind in (
    'created', 'status', 'assign',
    'content', 'priority', 'due', 'file_add', 'file_download', 'comment'
  ));

notify pgrst, 'reload schema';
