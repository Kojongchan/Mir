# 메뉴별 고도화 개발자 핸드오프 (상세) — §0-K 사용자 확정 우선순위

> **공통 대전제 (모든 항목 필독)**
> - **단일 해결 플랫폼**: MIR SMART 안에서 검토·협의·마크업·해소·보고까지 완결. 원본 저작툴(Navisworks·
>   Revit·Solibri)로 돌아갈 필요 없음. 외부표준(BCF·IFC)은 "가져오기(온보딩)"만 선택적, "내보내 돌아가기"는 비목표.
> - **실무 대체력 6기준**(각 메뉴 완료 조건): ①양식(엑셀/한글/워드) 입출력 ②리비전·이력 ③결재선(서명)
>   ④인쇄/PDF 출력 ⑤모듈별 전용 UI(다 똑같은 표 금지) ⑥현장 맥락(모바일·오프라인·사진·알림).
> - 스택: Vite SPA + Supabase + APS/ACC. 하드코딩 hex/px 금지(토큰 var(--*)). RLS 쓰기=is_editor(설정·역할=
>   is_project_admin, 시스템관리자 보호 D21). 마이그레이션 추가형(착수 시 현재 max+1 확인). 검증 typecheck·build.
> - 재사용: APS 이슈핀·매핑(apsMapping S49)·첨부(attachments 0010)·알림(이슈 워크플로우 S30)·도면핀(drawing_pins
>   0018)·전문검색(Supabase FTS)·CDE(cde.ts)·활동로그·Recharts(U2). docs/STATUS 갱신+커밋+푸시(PR은 요청 시).

---

## ② 협업·이슈 고도화

### 컨텍스트
- 현재: 이슈 트래커(0007) + 이슈↔3D 객체 핀(0012) + 워크플로우(상태·담당·마감·인앱 알림, 0013) + APS 이슈핀(S49)
  + 도면 핀(0018) + 첨부(0010). **문제: 단순 목록, 이슈 타입 구분 없음, 협의가 얕음, 출력·양식 없음.**
- 목표: "지적·RFI·안전점검을 여기서 등록→협의→닫음까지" 실무 완결. 원본 툴/카톡/엑셀로 흩어지지 않게.

### 고도화 항목 (전부 플랫폼 안에서)
1) **이슈 타입 분화**: `general`·`rfi`·`punch`(하자)·`safety`(안전)·`quality`(품질). 타입별 전용 필드
   (RFI=상대처·응답기한·질의/응답, Punch=위치·협력사·심각도, Safety=위험요소·조치)·색·아이콘·워크플로우.
2) **전용 UI (도메인 특화, 3-way 뷰 전환)**: ① 리스트(필터·정렬·검색) ② **칸반**(상태 열: open→진행→검토→closed
   드래그 이동) ③ **3D/도면 핀 뷰**(뷰어 위 핀 클러스터). 다 똑같은 표 탈피.
3) **협의 완결(스레드)**: 이슈별 코멘트 스레드(@멘션·읽음표시)·첨부·**3D 뷰포인트/마크업 첨부**(카메라 state+도형)·
   담당(관계사/역할, R12)·기한·상태 전이 이력. 알림(담당지정·멘션·기한임박, S30 재사용).
4) **연결**: 이슈↔간섭(0015)·이슈↔회의록 액션아이템(R2)·이슈↔도면/부재(GlobalId). 상호 점프.
5) **출력/양식**: 이슈 목록 **엑셀 export**(필터 반영) + **지적통보서/RFI 회사 양식(.docx/PDF)** 출력
   (docxtemplater, 스냅샷·질의응답 주입).
6) **현장**: 모바일 등록(사진 GPS·시간 태깅), 오프라인 초안 후 온라인 동기화.

### 데이터 (마이그 추가형)
- `issues`에 `type` 컬럼 추가(기본 general) + 타입별 옵션 컬럼(nullable) 또는 `meta jsonb`.
- `issue_comment`(id, issue_id, author, body, mentions jsonb, created_at). 
- `issue_viewpoint`(id, issue_id, camera_state jsonb, markup jsonb, snapshot). 
- 첨부는 attachments target_type='issue' 재사용. RLS 읽기=is_member·쓰기=is_editor.

### 수용기준(AC)
- 타입별 전용 폼/워크플로우로 이슈 생성, 리스트/칸반/핀 3뷰 전환, 드래그로 상태 이동.
- 코멘트 스레드·@멘션·읽음·3D 뷰포인트 첨부가 동작하고 모든 협의 이력이 이슈에 남는다.
- 이슈↔간섭/회의록/도면 상호 점프, 엑셀 export + 양식 PDF 출력.
- 모바일에서 사진 포함 등록. typecheck·build 통과. 기존 이슈 데이터 회귀 없음.

### 범위 밖
- BCF export/저작툴 왕복. 신규 알림 채널(카톡/SMS)은 P4(R9)와 함께.

### 마무리
- docs/STATUS.md 갱신 + 의미 단위 커밋 + 푸시. PR은 요청 시.

---

## ③ 공정 시뮬레이션 (4D) 고도화

### 컨텍스트
- 현재: APS(ACC) 위 4D 시뮬(S50) — 일정↔객체 매핑(속성/이름/순서, apsScheduleMapping)·시공중/철거 도색·
  계획대비 빠름늦음 색(0029 task_elements.global_id)·Timeline. **문제: 공정표 입력 경로 약함·실적 반영·공유 부족.**
- 목표: "엑셀/P6 공정표를 넣으면 3D로 돌려보고, 실적까지 물려 계획대비를 현장이 본다."(진실원본=외부 파일, 협의=플랫폼)

### 고도화 항목
1) **공정표 import = 진실원본**: **Excel(우선)** + MS Project(.xml) + P6(.xer) 파서 → 작업(WBS·기간·선후행) 흡수.
   컬럼 매핑 UI(작업명·시작·종료·선행·진척·매칭키). 현황 **엑셀 export**(계획/실적 대비표).
2) **WBS 트리 + 마일스톤 뷰** + 일정↔객체 매핑 신뢰성(속성 우선→이름→순서) + 작업별 진척률.
3) **실적 동기화**: 실제 시작/끝 입력 또는 엑셀 → 계획대비 색(빠름 파랑/늦음 주황, 有) + 지연 작업 하이라이트·목록.
4) **4D 워크스루**: 카메라 경로/저장 뷰포인트 순차 재생 + **녹화(캔버스 캡처)·공유 링크**(웹에서 재생). 날짜 스크럽 UI.
5) **물량/기성 기간 연동**: 기간별 투입물량·기성 곡선(§0-H·R6와 연결).

### 데이터
- schedule/task import 매핑 저장(project_id, source_type, column_map jsonb) · task_elements(0029 有) 확장
  (actual_start/end) · 워크스루(카메라 경로 jsonb). RLS 쓰기=is_editor.

### 수용기준(AC)
- 엑셀/P6 공정표 import → WBS·타임라인·3D 시뮬 동작, 매칭키로 객체 연결.
- 실적 입력 시 계획대비 색·지연 목록 반영, 현황 엑셀 export.
- 4D 워크스루 재생·공유 링크가 웹에서 열림. typecheck·build 통과.

### 범위 밖
- P6 실시간 양방향 연동(진실원본은 파일 import 유지), 저작툴 왕복.

### 마무리
- docs/STATUS.md 갱신 + 커밋 + 푸시. PR은 요청 시.

---

## ④ 자료관리 (CDE/ACC) 고도화

### 컨텍스트
- 현재: ACC 단독 파일관리자(0022)·RBAC(0023)·리비전·상태(WIP/Shared/Published/Archived) 컬럼. **문제: ISO 19650
  승인 흐름·자료전송·검색이 미흡, 트리 UX 미완(폭·이동·새버전 검증).**
- 목표: 글로벌/발주처 수주요건인 **ISO 19650 준수**를 플랫폼 내에서 완결(승인·송부·감사이력 전부 웹에).

### 고도화 항목
1) **ISO 19650 승인 워크플로우**: 상태 게이팅(WIP→Shared→Published→Archived), 각 전환 시 **승인자 지정 + 사유 +
   감사로그(누가·언제·왜)**. ★상태전환은 **서버측 검증**(승인단계별 권한, 클라 신뢰 금지).
2) **자료전송(Transmittal)**: 정식 송부 단위(수신자·문서목록·목적) + **수신확인** + **송부 표지 자동생성(회사 양식 PDF)** +
   송부 이력 아카이브.
3) **리비전·이력**(보강) + **검색·태그**(파일명·태그·본문 FTS) + 폴더 권한.
4) **파일관리자 UX 마감**: 트리 폭 드래그 리사이즈(localStorage) · 이동(move) · 새 버전 업로드 **라이브 검증**
   (실제 PUT/CORS/item 생성 확인).
5) **웹 완결**: 미리보기·승인·송부까지 원본 다운로드 없이(모델=APS Viewer, 문서=우리 뷰어).

### 데이터
- `approval_flow`(id, project_id, target_type('file'|'model'), target_id, from_state, to_state, approver, decision
  ('approved'|'conditional'|'rejected'|'resubmit'), comment, created_at) = 감사로그 겸용.
- `transmittal`(id, project_id, no, purpose, sender, created_at) + `transmittal_item`(transmittal_id, file_id, version) +
  `transmittal_recipient`(transmittal_id, user_id/company, acknowledged_at). files.status 활용.
- RLS: 상태전환=승인자 권한(서버 검증), 나머지 쓰기=is_editor.

### 수용기준(AC)
- 상태 게이팅이 권한대로만 전환되고 모든 전환이 감사로그에 남는다(무단 전환 차단 테스트).
- 자료전송 송부·수신확인·표지 PDF 생성, 리비전·검색·태그·트리 리사이즈/이동/새버전 동작.
- typecheck·build 통과. 0022/신규 마이그 미적용 시 폴백(앱 안 깨짐).

### 범위 밖
- BCF/저작툴 왕복, 서버 변환(PPT/HWP)은 별도(S20).

### 마무리
- docs/STATUS.md 갱신 + 커밋 + 푸시. PR은 요청 시.

---

## ⑤ 구성원·권한·역할 고도화

### 컨텍스트
- 현재: RBAC 4단계(뷰어/실무자/관리자/시스템관리자, 0023·D20) + 프로젝트관리자 멤버관리(D22) + 시스템관리자 보호(D21).
  **문제: 회사(소속)·다중역할·관계사·역할기반 배정 개념이 없음.** 참고: ACC 구성원(다중역할·회사·접근권한) + ProjectWorks(사용자/관계사).
- 목표: 현장 조직(발주처·감리·시공·협력사)을 그대로 표현하고, 담당배정·결재선이 회사/역할로 굴러가게.

### 고도화 항목
1) **관계사(회사) 마스터 등록**: name·role_type(발주처/감리/시공/협력사)·현장전화·현장책임자·사업개요 표시토글·사용여부.
   (ProjectWorks '관계사 등록/관리' 참고.)
2) **구성원 모델 확장**: 구성원 = **회사(소속) + 다중역할**(BIM관리자/현장/본사/실무자 등 1인 N역할) + **접근권한**
   (뷰어/실무자/관리자 = 기존 project_members.role 유지). 역할은 태그(+N)로 표시. (ACC 구성원 화면 참고.)
3) **역할 기반 담당배정 연동**: 이슈·Punch·간섭·결재선·자료전송 수신자 배정 드롭다운을 **관계사/역할** 기준으로.
4) **초대·계정발급**(프로젝트관리자 D22, api/admin.ts) + **활동/접속 이력** + 구성원 **엑셀 내보내기**.

### 데이터
- `company`(id, project_id, name, role_type, phone, manager, show_on_overview bool, active bool).
- `project_members.company_id`(fk, nullable) 추가. `member_role`(id, member_id, role) 다중역할.
- 기존 project_members.role(viewer/editor/admin)=접근권한 유지. RLS 쓰기=is_project_admin, 시스템관리자 보호(D21).

### 수용기준(AC)
- 관계사 CRUD(사업개요 표시토글 포함), 구성원에 회사·다중역할·접근권한 부여·표시·편집.
- 접근권한과 역할이 분리되고, 담당배정 드롭다운이 관계사/역할 기반으로 동작.
- 초대/계정발급·활동이력·엑셀 내보내기 동작, 권한 게이팅. typecheck·build 통과.

### 범위 밖
- SSO/외부 IdP 연동. 시스템관리자 관리(Supabase 전용, D21) 유지.

### 마무리
- docs/STATUS.md 갱신 + 커밋 + 푸시. PR은 요청 시.

---

## ⑥ 사업개요 = 현장 현황판 (War-room) 고도화

### 컨텍스트
- 현재: Bento 대시보드(U2) + KPI + Recharts. **재정의: 단순 KPI가 아니라 실제 현장에서 벽/모니터에 띄우는 현황판.**
- 목표: 현장 사무실에서 "오늘 현장이 어떻게 돌아가는지" 한 화면으로. 관리자·발주처 방문 시 상황판.

### 고도화 항목
1) **현황판 위젯 세트**: 금일 현장사진(슬라이드/그리드)·오늘 이슈(신규·지연)·공지·알림·날씨(공정 영향)·공정률
   (계획대비)·안전지표(무재해 일수·금일 위험작업)·금일 작업(일보 연동)·마일스톤 D-day.
2) **키오스크/대형 디스플레이 모드**: 풀스크린 + 위젯 자동 순환(슬라이드쇼) + 큰 타이포. 현장 모니터 상시 표출용.
3) **실시간 갱신**: Supabase Realtime(postgres_changes) 구독 → 이슈/일보/공지 변경 시 즉시 반영.
   ★구독 lifecycle·디바운스·언마운트 해제(누수 방지).
4) **프로젝트별 위젯 커스터마이즈**: 드래그 배치·저장(react-grid-layout) — 철도(TBM 굴진)·도로(성토 다짐)·단지(분양) 등
   프로젝트 성격별 다른 구성(R7).
5) **모바일 요약 카드** + 빈 상태(empty)·로딩 스켈레톤.

### 데이터
- `dashboard_widget`(id, project_id, type, position jsonb, config jsonb) · `notice`(공지) · `site_photo`(금일 현장사진,
  Storage). RLS 읽기=is_member·쓰기=is_editor(공지/사진), 위젯배치=is_project_admin.

### 수용기준(AC)
- 현황판 위젯(현장사진·이슈·공지·날씨·공정률·안전·금일작업)이 표시되고 실시간 갱신.
- 키오스크 모드(풀스크린 자동 순환) 동작, 프로젝트별 위젯 배치 저장/복원, 구독 누수 없음.
- 모바일 요약. typecheck·build 통과.

### 범위 밖
- 외부 IoT/CCTV 실데이터(Track C, 예산 결정 시). 지금은 앱 내 데이터 + 날씨 API.

### 마무리
- docs/STATUS.md 갱신 + 커밋 + 푸시. PR은 요청 시.

---

## ⑦ 게시판·물량·기성·공정현황 고도화

> 4개 메뉴 묶음. 각각 별 세션으로 쪼개도 됨. 공통: 실무 대체력 6기준·플랫폼 완결·RLS 쓰기=is_editor·마이그 추가형.

### ⑦-a 게시판 → 공지 + 회의록·의사결정 로그 분화 (R2)
- 컨텍스트: 현재 단순 게시판(완성도 40%·저활용). → **공지사항 / 회의록·의사결정 로그**로 분화.
- 고도화: 
  · **공지**: 상단 고정·대상(전체/회사/역할)·**읽음 확인**·첨부. 
  · **회의록**: 참석자·본문(마크다운 TipTap)·**결정사항 → 액션아이템(담당·기한) → 이슈 자동 승격**·**전문검색**(감사 대응)·첨부.
  · 결재선(선택).
- 데이터: `meeting`(project_id, title, meeting_date, attendees jsonb, body md, created_by) · `meeting_decision`(meeting_id,
  text, type) · `action_item`(meeting_id, decision_id, text, assignee, due_date, status, linked_issue_id) · `notice`(공지).
- AC: 회의록 CRUD·결정→액션(이슈연결)·전문검색, 공지 읽음확인. 단순 목록 탈피.

### ⑦-b 공사일보 — 엑셀 양식 입출력 (★대표 실무 대체)
- 컨텍스트: 현재 DailyLogs(0006) 단순 폼. **핵심: 회사 엑셀 양식을 그대로 쓰게 만들어야 실사용.**
- 고도화:
  1) **양식 등록**: 관리자가 회사 `.xlsx` 템플릿 업로드 → 셀↔필드 매핑(명명 셀 또는 `{{placeholder}}` + 작업내용 등
     **표 반복 영역** 지정). 프로젝트별 저장.
  2) **작성 폼**: 일자·투입인력(직종별)·투입장비·날씨·작업내용(행 반복)·특이사항·사진. **모바일/오프라인(PWA)** 작성.
  3) **추출**: **exceljs**로 등록 템플릿을 읽어 값 주입(**스타일·병합셀·서식 보존**) → **양식과 동일한 .xlsx** 다운로드 +
     PDF 출력. (SheetJS는 서식 보존 약함 → exceljs 권장.)
  4) **리비전**: 일보 버전 이력·변경 비교·복원. **결재선**: 작성→검토→승인 + 서명/도장란.
  5) 사진 **GPS/시간 자동 태깅**. (선택) 음성→텍스트(Whisper).
- 데이터: `daily_log`(0006 확장) · `daily_log_revision`(log_id, version, snapshot jsonb, created_by, created_at) ·
  `log_template`(project_id, xlsx_path, cell_map jsonb) · `approval`(작성/검토/승인·서명). 첨부·사진=Storage.
- AC: 양식 등록 → 화면 작성 → **등록한 양식과 픽셀 동일한 엑셀** 추출 + PDF + 리비전 + 결재선 + 모바일 사진.
  (= 기존 엑셀 수기 방식 완전 대체.)

### ⑦-c 물량 (QTO)
- 고도화: 속성 매핑 신뢰성(미산출 개선 — 속성 덤프 스파이크로 이름/단위 매핑 보강, §0-F) + **수동 물량 입력** +
  **엑셀 입출력**(내역 export/import) + 원가/EVM 연동(§0-H·R6).
- AC: ACC 모델 물량 산출 + 수동 보정 + 엑셀 입출력 + 금액 연동.

### ⑦-d 기성내역
- 고도화: **QTO 물량 ↔ 기성 자동 연동**(공종별 물량×단가) + **기성 청구서 회사 양식 출력(엑셀/PDF)** + 도급액/기성률/
  차수 관리 + EVM 연동.
- AC: 물량 연동 기성 산출 + 청구서 양식 출력 + 차수별 기성률.

### ⑦-e 공정현황
- 고도화: **EVM 지표(PV/EV/AC·CPI/SPI·EAC)** 3선 차트(Recharts) + 마일스톤·**S-curve 계획/실적** + 엑셀 export.
- AC: EVM 3선·지표 정확, S-curve 계획/실적, 엑셀 export.

### 마무리(⑦ 공통)
- docs/STATUS.md 갱신 + 의미 단위 커밋 + 푸시. PR은 요청 시.
