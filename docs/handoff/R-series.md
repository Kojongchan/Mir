# R-시리즈 개발자 핸드오프 (기능 확장 로드맵 §0-J)

> 각 항목을 새 대화에 그대로 붙여 개발자에게 전달. 공통 전제:
> - 레포 Kojongchan/Mir. 스택 = Vite SPA + Supabase + APS/ACC(자체 뷰어 아님). Next/Xeokit 전제 금지.
> - 하드코딩 hex/px 금지(U1 토큰 나오면 var(--*)). 권한=RBAC(0023, 쓰기 is_editor·설정 is_project_admin).
> - 마이그레이션 추가형(착수 시 현재 max+1 확인, 아래 번호는 예시). 검증 = npm run typecheck && npm run build 통과.
> - 재사용 자산: APS 이슈핀(lib/apsMapping.ts·AccModels S49) · 첨부(attachments 0010) · 알림(이슈 워크플로우 S30)
>   · 도면핀(drawing_pins 0018) · 전문검색(Supabase FTS) · CDE(cde.ts) · 활동로그.
> - docs/STATUS.md 갱신 + 의미 단위 커밋 + 푸시. PR은 사용자가 요청할 때만.

---

## [P1] R1 — RFI(정보요청서) 관리
- 개념: 발주처·감리·설계와 주고받는 정보요청서를 CDE 안에서. 3D 부재/도면 핀 + 응답기한(SLA) + 상태 + 첨부.
- 재사용: APS 이슈핀(부재 dbId→GlobalId), 첨부(0010), 알림(S30), 도면핀(0018).
- 데이터: `rfi`(id, project_id, rfi_no 프로젝트별 시퀀스, title, question, discipline, from_party(발주처/감리/설계/시공),
  to_assignee uuid, status('open'|'answered'|'void'|'closed'), priority, due_date, answered_at, answer,
  global_id nullable, drawing_id/pin nullable, created_by, created_at). 첨부는 attachments target_type='rfi'.
  RLS 읽기=is_member·쓰기=is_editor.
- 구현: 목록(번호·제목·상대처·상태칩·담당·SLA배지 + 필터/검색) · 상세(질의/응답 스레드·첨부·"위치 보기"→isolate/fit·
  상태전이 게이팅) · SLA 카운트다운(임박≤3일 warning·지연 error, .tabular) · 부재/도면 핀 연결 · 담당지정/기한임박 알림.
- AC: 생성(핀 포함)·필터·응답·상태전이 권한 게이팅, SLA 배지 정확, "위치 보기" 이동, 첨부·알림 동작.

## [P1] R2 — 회의록·의사결정 로그
- 개념: 현장·사무실 미팅 결과 기록, **결정사항→액션아이템(담당·기한)→이슈/RFI 자동연결**, 검색 가능한 의사결정
  아카이브(감사 대응). **기존 게시판(완성도 40%·저활용) 대체.**
- 재사용: 전문검색(FTS), 이슈(액션아이템=이슈 생성), 첨부, 알림.
- 데이터: `meeting`(id, project_id, title, meeting_date, attendees jsonb, body(마크다운), created_by, created_at).
  `meeting_decision`(id, meeting_id, text, decision_type, created_at). `action_item`(id, meeting_id, decision_id,
  text, assignee uuid, due_date, status, linked_issue_id nullable). RLS 읽기=member·쓰기=is_editor.
- 구현: 회의록 작성(마크다운 에디터·참석자·첨부) · 결정사항 목록 + 각 결정에서 "액션아이템 생성"(담당·기한→이슈 승격)
  · 전문검색(회의록/결정 본문) · 캘린더/타임라인 뷰(선택) · 게시판 메뉴를 회의록으로 대체/이관.
- AC: 회의록 CRUD, 결정→액션아이템(담당·기한·이슈연결), 검색으로 과거 결정 조회, 권한 게이팅.

## [P1] R3 — Punch List(하자·미완료 항목)
- 개념: 준공 전 하자·재작업 항목을 3D 모델/도면에 마킹, 모바일 사진 첨부 즉시 등록, 층·공구별 그룹, 담당 협력사 배정.
- 재사용: APS 이슈핀, 첨부(모바일 카메라), 이슈 워크플로우/알림, 도면핀.
- 데이터: `punch`(id, project_id, title, description, location_desc, global_id nullable, drawing_id/pin nullable,
  status('open'|'in_progress'|'verified'|'closed'), assignee_company, assignee uuid, severity, photos, created_by, created_at).
  RLS 읽기=member·쓰기=is_editor.
- 구현: 3D/도면에서 위치 찍어 생성 + 모바일 사진 · 목록(층·공구·상태·담당 필터·그룹) · 상세(사진 before/after·상태전이)
  · 담당 협력사 자동배정(관계사 매핑, R12 연계) · 준공률 위젯(전체 대비 closed).
- AC: 핀 생성 + 사진, 그룹/필터, 상태전이 게이팅, "위치 보기" 이동, 준공률 집계.

## [P2] R4+R5 — ISO 19650 승인 워크플로우 + Submittals(제출물)
> R5(Submittals)는 R4 승인엔진 위에 얹으므로 한 세션으로. **수주 결정요인**(ISO 준수 40%→). RLS/상태머신 신중.
- R4 개념: 문서·모델의 상태 게이팅(WIP → Shared → Published → Archived). 각 상태 전환 시 **승인자 지정 + 감사로그
  (누가·언제·왜)**. 글로벌/발주처 수주 필수.
- R5 개념: 자재승인·시공계획서·시공상세도 등 **승인 프로세스 있는 문서**를 Ball-in-court(지금 누구 손에)·승인/조건부
  승인/반려/재제출 상태·Revision 이력으로 관리.
- 재사용: CDE(cde.ts·files·file_versions), ACC 메타(0022), 활동로그, 알림.
- 데이터: `approval_flow`(id, project_id, target_type('file'|'model'|'submittal'), target_id, from_state, to_state,
  approver uuid, decision('approved'|'conditional'|'rejected'|'resubmit'), comment, created_at) = 감사로그 겸용.
  files/모델에 status 컬럼(WIP/Shared/Published/Archived) — 기존 CDE status 확장. `submittal`(id, project_id,
  title, type, current_holder uuid(ball-in-court), status, revision_no, file_id, due_date, …).
  ★ RLS: 상태전환 권한을 승인단계별로(단순 is_editor 넘어 approver 지정) — 상태머신은 서버측 검증 필수(클라 신뢰 금지).
- 구현: 상태 배지 + 전환 UI(권한자만·사유입력) · 승인자 지정 · 감사로그 타임라인(누가·언제·왜) · Ball-in-court 뷰
  (지금 누구 손·며칠 지연) · Revision 이력 · 알림(내 차례/반려). React Flow 등으로 승인 흐름 시각화(선택).
- AC: 상태게이팅이 권한대로만 전환, 모든 전환이 감사로그에 기록, Ball-in-court로 병목 파악, Revision 추적. 
  ★ 서버측 상태전환 검증(무단 전환 차단) 테스트.

## [P3] R6 — EVM 원가관리 (= §0-H 5D 통합)
> §0-H(5D 원가·기성) 설계를 EVM 지표로 정식화. **선행 참고: §0-H·§0-F(QTO).**
- 개념: 기성 현황을 정식 EVM으로 — PV(계획)·EV(획득)·AC(실제) 3선 차트, CPI(원가성과)·SPI(일정성과) 자동 계산,
  EAC(예상완료원가) 예측. 국가철도공단·LH 원가관리 인정.
- 재사용: QTO(물량·금액), 4D(계획/실적 날짜 task_elements), 기성내역(0011), Recharts(U2).
- 데이터: `cost_rates`(§0-H: project_id, category, qty_basis, unit_price, manual_qty) + `evm_actual`(id, project_id,
  category/task, ac_amount, as_of_date) — 실제원가 입력(CSV 업로드 MVP, 후속 ERP/SAP REST). RLS 쓰기=is_editor.
- 구현: 객체 금액(물량×단가) → 날짜별 PV(계획일정)·EV(실적일정×금액)·AC(입력) 집계 → CPI=EV/AC·SPI=EV/PV·
  EAC 산출 · 3선 S-curve(Recharts) · 공종별 지표 표 · CSV 실제원가 업로드(Papa Parse) · 기성내역 대사.
- AC: PV/EV/AC 3선 차트 + CPI/SPI/EAC 정확, 기준일 변경 반영, CSV 실제원가 반영, 기성내역 연동.

## [P3] R7 — HIBoard 실시간 위젯 대시보드 (= U2 통합)
> U2(Bento 대시보드)에 **Supabase Realtime**를 얹어 실시간·커스터마이즈 위젯으로. U2와 한 세션 권장.
- 개념: 사업개요를 모듈러 위젯 시스템으로. 프로젝트별 커스터마이즈(철도→TBM 굴진, 도로→성토 다짐, 단지→분양 진행).
  이슈·기성·안전·기상 등 실시간 갱신.
- 재사용: U2 Bento(.bento-*), Recharts, KPI Card, Supabase Realtime(postgres_changes 구독).
- 데이터: `dashboard_widget`(id, project_id, type, position, config jsonb) — 프로젝트별 위젯 배치/설정. RLS 쓰기=is_project_admin.
- 구현: 위젯 카탈로그(KPI·차트·리스트·진행률) · Bento 드래그 배치·저장(react-grid-layout) · Supabase Realtime 구독
  (이슈/기성/일보 변경 시 위젯 자동 갱신) · ★ 구독 남용 방지(디바운스·위젯 lifecycle·언마운트 해제) · 빈 상태.
- AC: 위젯 추가/배치/저장, 데이터 변경 시 실시간 반영, 프로젝트별 커스터마이즈, 구독 누수 없음.

## [P4] R8~R11 — 소품 4종 (각 1~2주)
- **R8 통합검색(Cmd+K)**: 도면·이슈·RFI·회의록·파일 글로벌 검색 팔레트(cmdk 스타일). Supabase FTS + fuzzy(Fuse.js),
  최근 항목·바로가기. 데이터 신규 없음(각 테이블 FTS 인덱스). AC: Cmd+K로 어디서든 열려 통합 검색·이동.
- **R9 기상알림 자동화**: 기상이력(저활용)에 임계치 초과(강수·풍속) 시 담당자에게 자동 알림(카카오 알림톡 또는 인앱/SMS).
  Vercel Cron + 기상청 API. `weather_alert_rule`(project_id, metric, threshold, assignee). AC: 임계 초과 시 알림 발송·이력 기록.
- **R10 QR 자재·자산 태깅**: 반입 자재/장비에 QR(qrcode.js) 부착 → 스캔(html5-qrcode)으로 반입일·시험성적서·투입위치 조회.
  `asset`(id, project_id, name, qr_code, received_at, spec_docs, install_location, status). AC: QR 생성·스캔·자산이력 조회.
- **R11 원격지원 세션 아카이브**: 스마트글래스 없이 Teams/Meet 세션 링크 + 화면캡처를 프로젝트별 아카이브(나중 글래스
  도입 시 확장). MS Graph/Google Calendar API(선택) 또는 수동 링크+캡처 업로드. `remote_session`(id, project_id, title,
  link, captures, held_at). AC: 세션 등록·캡처 첨부·프로젝트별 조회.

## [P5] R12 — 구성원·역할·관계사 고도화
> 참고 화면: ACC 구성원(다중 역할·회사·접근권한) + ProjectWorks(사용자/관계사 등록). 현 RBAC 4단계 위에 확장.
- 개념: 사람마다 **회사(소속) + 다중 역할(BIM관리자/현장/본사/실무자 등) + 접근권한(구성원/관리자)** 을 부여하고,
  **관계사(협력사·발주처·감리) 마스터**를 등록해 사용자·문서·Punch 담당배정에 연결.
- 재사용: 관리자 콘솔(Admin.tsx), useProjectRole, RBAC(0023, D22 프로젝트관리자 멤버관리).
- 데이터: `company`(id, project_id, name, role_type('발주처'|'감리'|'시공'|'협력사'…), phone, manager, active) = 관계사.
  `project_members`에 company_id 추가. `member_role`(member_id, role)= 다중역할(1인 N역할). 기존 project_members.role
  (viewer/editor/admin)= 접근권한으로 유지. RLS: 관계사·역할 쓰기=is_project_admin(D22).
- 구현: 관계사 등록/관리(목록·CRUD·사업개요 표시 토글) · 구성원 화면에 회사·다중역할·접근권한 컬럼·편집 · 역할 태그(+N)
  · 담당배정 드롭다운이 관계사/역할 기반 · (선택) 엑셀 내보내기. 시스템관리자 보호(D21) 유지.
- AC: 관계사 CRUD, 구성원에 회사·다중역할 부여·표시, 접근권한(뷰어/실무자/관리자)과 역할 분리, 담당배정 연동, 권한 게이팅.

---

## (★ 별도) R-AI — AI 재해예측 (킬러 후보 · 인프라 결정 필요)
- 개념: 과거 시공/안전 데이터 기반 매일 06:00 고위험 작업 자동 리포트 + 맞춤 안전지침 + 카카오 알림.
- 방식: Claude API + pgvector(Supabase) RAG. Vercel Cron. **선결: LLM API 키·비용 승인, 안전/사고 데이터 확보,
  프롬프트 인젝션 방어·결과 검증·rate limit(시니어 리뷰 권장).** → 별도 설계 세션에서 스펙 확정 후 착수.

## (보류) Track C — 예산/외부 SaaS 결정 필요
- AI CCTV 안전감지(#06, 뷰메진 등 월 300~500만) · IoT 디지털트윈(#07, 계측업체 협업) · 360° As-Built(#08, OpenSpace 월 200~400만).
  → 우리는 "결과를 CDE에 임베드하는 UI + 위치/이슈 링크"만 개발. **사용자 예산 결정 후 착수.**
