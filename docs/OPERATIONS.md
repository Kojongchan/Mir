# OPERATIONS — MIR_VDC 운영 가이드

> **권장: S2 관리자 콘솔(화면)으로 운영하세요.** 관리자 계정으로 로그인 → 프로젝트
> 선택 화면 우상단 **`관리자 콘솔`** 버튼(`/admin`). 프로젝트·사용자·멤버를 화면에서
> 추가/수정/삭제할 수 있고, 사용자 생성은 한글 아이디도 **수동 SQL 보정 없이** 자동
> 처리됩니다(아래 0-A). 아래 SQL 절차는 콘솔을 못 쓰는 상황의 **백업/참고**입니다.

## 0-A. 관리자 콘솔 (S2, 권장 경로)
- **사전 1회 셋업**: `supabase/migrations/0002_admin.sql` 실행(관리자 RLS 쓰기 정책),
  Vercel 프로젝트 환경변수에 **서버 전용**(VITE_ 접두사 X) 추가 →
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`(service_role 비밀키). 재배포.
  - ⚠️ `service_role` 키는 RLS를 우회하는 비밀키 → **프론트엔드/깃 절대 금지**.
    서버리스 함수 `api/admin.ts` 안에서만 사용됩니다.
  - 첫 관리자만 한 번 SQL로 승격(`update public.profiles set is_admin=true ...`),
    이후엔 콘솔 "사용자" 탭에서 관리자 지정/해제 가능.
- **프로젝트 탭**: 추가/이름·코드 수정/삭제.
- **사용자 탭**: 아이디(한글 가능)·표시이름·비밀번호로 생성, 관리자 지정/해제,
  **아이디(로그인 username) 변경**, 비밀번호 변경, 삭제. 생성 시 `username`
  메타데이터를 직접 넣으므로 비-ASCII 보정 SQL이 **불필요**합니다.
  - **아이디 변경** 버튼은 `username` 과 그로부터 계산되는 내부 인증 이메일을
    **함께** 바꿉니다(아래 6번 수동 SQL을 콘솔에서 대체). 이미 쓰는 아이디면 막힙니다.
- **멤버 배정 탭**: 프로젝트별로 사용자 추가/역할 변경(viewer·editor·admin)/해제.
- 📌 사용자 생성/삭제/아이디변경/비번변경은 `/api/admin` 서버리스 함수가 필요 → **배포
  환경(Vercel)** 또는 로컬 `vercel dev`에서 동작. 일반 `npm run dev`(vite)에서는 사용자
  관리만 404가 나며, 프로젝트·멤버 관리는 정상 동작합니다.

## 0-B. 문서·미디어 통합 뷰어 (S13, Phase 8)
- **사전 1회 셋업**:
  1. `supabase/migrations/0004_files.sql` 실행 → `public.files` 테이블 + RLS +
     Storage `docs` 버킷 정책 추가(추가형, 멱등).
  2. Supabase 대시보드 **Storage → New bucket** 으로 **`docs`** 버킷을 **Private**
     로 생성(0004 의 정책은 버킷이 있어야 적용됨; 또는 0004 안 주석의 insert 해제).
- **동작**: 워크스페이스 좌측 사이드바 **`문서 · 미디어`** 에서 파일 업로드 → 목록
  클릭 시 **새 탭 `/view/:fileId`** 로 미리보기. 경로 규칙은 모델과 동일
  (`<project_id>/<file_id>.<ext>`)이라 **프로젝트 멤버(RLS)** 만 접근 가능하며,
  열람 시 **짧은 만료(10분) 서명 URL** 을 발급합니다.
- **지원 포맷(1단계·웹 단독·서버 0원)**: 이미지(jpg/png/webp/gif/bmp/svg)·동영상
  (mp4/webm/ogg)·오디오·PDF(PDF.js)·Excel(xlsx/xls/csv, SheetJS)·Word(docx,
  mammoth)·텍스트(txt/md/json/…). 미지원(avi/pptx/doc/hwp 등)은 **다운로드 폴백**.
- ⚠️ **SheetJS 보안 메모**: npm 레지스트리가 주는 `xlsx`는 0.18.5(취약점 advisory 있음)
  뿐이고, 패치판(≥0.20.x)은 `cdn.sheetjs.com` 에서만 배포되는데 현재 네트워크 정책이
  차단합니다. 파일은 프로젝트 멤버만 올릴 수 있어 노출이 제한되지만, 정책이 허용되면
  CDN 빌드로 교체 권장. (`src/components/viewers/SheetViewer.tsx` 주석 참고)
- 🔜 **2단계(별도 세션)**: 서버 변환 파이프라인(avi→mp4, pptx/doc/hwp→PDF 등).

## 0-C. CDE 자료 관리 (S14, Phase 7)
- **사전 1회 셋업**: `supabase/migrations/0005_cde.sql` 실행 → `folders` ·
  `file_versions` · `activity_log` 테이블 + `files` 에 `folder_id` · `status`
  (`WIP→Shared→Published→Archived`) · `current_version_id` 컬럼 추가 + RLS(멤버,
  기존 `is_member`/`is_admin` 재사용). 추가형·멱등(0001~0004 수정 없음). 0-B 의
  `docs` 버킷을 그대로 사용하므로 **새 버킷은 불필요**합니다.
  - 적용 시 기존 `files`(S13) 레코드는 자동으로 **버전 1** 로 백필됩니다.
- **동작**: 워크스페이스 상단 **`자료 관리`** 버튼 → `/project/:id/docs`.
  좌측 **폴더트리**(생성/이름변경/삭제 — 빈 폴더만 삭제), 우측 **문서 목록**.
  - **문서 업로드**: 현재 폴더에 새 문서를 v1 로 올림. (워크스페이스 사이드바의
    `문서 · 미디어` 업로드도 동일 경로 → 루트(미분류)에 적재)
  - **새 버전**: 같은 문서에 v2, v3… 누적. 뷰어(`/view/:id`)는 항상 **최신 버전**을 엽니다.
  - **이력**: 버전별 크기·등록일·비고·열기(서명 URL).
  - **상태 뱃지**: 행마다 ISO 19650 상태 변경(작업중/공유/발행/보관).
  - **활동 로그**: 업로드·버전·상태변경·폴더 CRUD 감사 이력(최신순).
  - **삭제**: 문서 삭제(모든 버전 + 스토리지 오브젝트)는 **관리자만**(RLS).

## 0-D. 사업관리 포털 (S21·S22, Phase 11·12)
- **사전 1회 셋업** (SQL 에디터에서 순서대로 실행, 모두 추가형·멱등):
  1. `supabase/migrations/0006_dashboard.sql` — project_info(착공/준공/진행률) ·
     project_milestones · daily_logs(공사일보) · monthly_records(월별 계획/실적/기성).
  2. `supabase/migrations/0007_issues.sql` — issues + issue_comments(협업·이슈).
  3. `supabase/migrations/0008_portal_extra.sql` — posts(게시판) · subcontracts(하도급) ·
     project_info.contract_amount(도급액).
  4. `supabase/migrations/0009_admin_writes.sql` — **쓰기는 관리자(admin)만**(D11). 포털·CDE·
     업로드의 insert/update/delete 를 `is_admin()` 으로 제한. 멤버는 전 모듈 **읽기 전용**.
  - **새 Storage 버킷·외부 의존 없음.** RLS는 기존 멤버십(`is_member`/`is_admin`) 재사용.
    데이터 입력·수정은 **관리자 계정**으로 진행(비-admin 에는 편집 UI가 숨겨짐).
- **동작**: 프로젝트 진입 첫 화면 = **사업개요 대시보드**. 좌측 모듈 메뉴 —
  사업개요 / 공정현황 / 공사일보 / 협업·이슈 / 모델뷰어(3D) / 자료 관리 / 구성원(admin).
  - **사업개요**: 우상단 `편집`으로 착공·준공일·전체 진행률·마일스톤·월별 실적 입력.
  - **공사일보**: 일자별 투입 인력·장비·날씨·내용 등록(대시보드 인력/장비/일지 차트에 반영).
  - **공정현황**: 마일스톤 타임라인 + 계획/실적 S-curve + 4D 시뮬 바로가기.
  - **협업·이슈**: 지적/RFI 등록·상태(미해결/진행중/해결/종료)·우선순위·담당자·코멘트.
  - **기성내역**: 도급액 입력 → 누적 기성·기성률·잔여, 월별 기성 추이(금액은 사업개요 월별 입력).
  - **하도급내역**: 협력사 계약/기지급/지급률·상태 등록, 합계 요약.
  - **게시판**: 공지 작성·상단 고정·삭제.

---

> 아래는 대시보드 **수동 백업 절차**입니다. 작업 위치: Authentication(계정) /
> SQL Editor(권한·데이터). SQL은 **한 문장씩** 붙여넣고 `Run` 하세요.

## 0. 개념 한 줄
- 사용자는 **아이디**로 로그인 → 내부적으로 `아이디 → 이메일`로 변환되어 Auth에 저장.
- **무엇을 볼 수 있는지**는 `project_members` 에 줄이 있어야 정해짐(없으면 로그인은 되지만
  프로젝트가 안 보임). 관리자(`is_admin=true`)는 모든 프로젝트를 봄.
- 로그인 이메일은 아이디로부터 자동 계산됨: 영어/숫자면 `아이디@mir.local`,
  한글 등 비-ASCII면 `u-<hex>@mir.local` (`node scripts/username-email.mjs <아이디>` 로 확인).

---

## 1. 프로젝트(공구) 추가
```sql
insert into public.projects (name, code) values ('서울-춘천 3공구', '3공구');
```
- `name` = 화면에 보일 이름, `code` = 짧은 식별자(공구 번호 등).
- 추가 후 사용자를 배정해야 보입니다 → **2번** 참고.

---

## 2. 사용자 추가

### 2-A. 영어/숫자 아이디 (예: `kim`)
1) **계정 생성** — Authentication → Users → Add user → Create new user
   - Email: `kim@mir.local`, Password 입력, **Auto Confirm User 체크** → Create
   - (브라우저 비번 유출 경고 팝업은 `확인` 누르고 무시)
2) **프로젝트 배정** — SQL Editor:
```sql
insert into public.project_members (project_id, user_id, role)
values (
  (select id from public.projects where code = '5공구'),    -- 배정할 프로젝트 코드
  (select id from public.profiles where username = 'kim'),  -- 방금 만든 아이디
  'editor'                                                   -- viewer | editor | admin
)
on conflict (project_id, user_id) do update set role = excluded.role;
```

### 2-B. 한글 아이디 (예: `김현장`)
1) **이메일 뽑기** — 프로젝트 폴더 터미널:
```bash
node scripts/username-email.mjs 김현장 "김현장"
# 출력: email : u-xxxx@mir.local   ← 복사
```
2) **계정 생성** — Add user → Email: `u-xxxx@mir.local`, Password, **Auto Confirm 체크**.
3) **이름 보정 + 배정** — SQL Editor (이메일은 1)에서 나온 값):
```sql
update public.profiles
   set username = '김현장', full_name = '김현장'
 where id = (select id from auth.users where email = 'u-xxxx@mir.local');
```
```sql
insert into public.project_members (project_id, user_id, role)
values (
  (select id from public.projects where code = '5공구'),
  (select id from auth.users where email = 'u-xxxx@mir.local'),
  'editor'
)
on conflict (project_id, user_id) do update set role = excluded.role;
```
> 빠른 "Add user" 폼은 메타데이터 입력란이 없어 한글 사용자는 `username` 이 임시 hex 로
> 잡힙니다. 위 update 로 한글 이름으로 바로잡습니다. (S2 자동가입에서 이 단계 제거 예정)

### 2-C. 관리자(admin) 지정 / 해제
관리자는 **모든 프로젝트**를 보고 모델 삭제 등 권한을 가집니다(배정 불필요).
```sql
update public.profiles set is_admin = true  where username = 'kim';   -- 지정
update public.profiles set is_admin = false where username = 'kim';   -- 해제
```

---

## 3. 역할(role) 변경 / 배정 해제
역할: `viewer`(보기) · `editor`(업로드 가능) · `admin`(프로젝트 관리, 추후 확장).
```sql
-- 역할 변경
update public.project_members set role = 'viewer'
 where project_id = (select id from public.projects where code = '5공구')
   and user_id    = (select id from public.profiles where username = 'kim');
```
```sql
-- 배정 해제(프로젝트에서 제거)
delete from public.project_members
 where project_id = (select id from public.projects where code = '5공구')
   and user_id    = (select id from public.profiles where username = 'kim');
```

---

## 4. 사용자 비밀번호 변경
`@mir.local` 계정은 실제 메일함이 없어 "이메일로 재설정"이 안 됩니다. 아래처럼 직접 바꿉니다
(pgcrypto 확장 필요 — Supabase 기본 활성. `'newpass'` 를 새 비번으로):
```sql
-- 최초 한 번만: create extension if not exists pgcrypto;
update auth.users
   set encrypted_password = crypt('newpass', gen_salt('bf'))
 where email = 'kim@mir.local';     -- 한글 아이디면 u-xxxx@mir.local
```
실행 즉시 새 비밀번호로 로그인됩니다.

---

## 5. 사용자 삭제
1) 그 사용자가 **업로드한 모델이 있으면** 먼저 연결을 끊습니다(FK 제약):
```sql
update public.models set uploaded_by = null
 where uploaded_by = (select id from auth.users where email = 'kim@mir.local');
```
2) **Authentication → Users → 해당 사용자 → ⋯ 메뉴 → Delete user**.
   - `profiles` 와 `project_members` 는 자동으로 함께 삭제됩니다(cascade).

---

## 6. 아이디 / 표시이름 변경
> 💡 **로그인 아이디(username) 변경은 이제 콘솔 "사용자" 탭의 `아이디 변경` 버튼으로
> 가능합니다**(username + 내부 이메일을 함께 안전하게 변경). 아래 수동 SQL은 콘솔을 못
> 쓰는 상황의 백업 절차입니다.

**표시이름(full_name)만** 바꾸기 — 로그인엔 영향 없음:
```sql
update public.profiles set full_name = '김반장' where username = 'kim';
```
**로그인 아이디(username) 바꾸기** — ⚠️ 로그인 이메일도 같이 바꿔야 로그인됩니다:
```sql
-- 영어 새 아이디 예: kim -> kimhj  (한글이면 username-email.mjs 로 새 이메일 확인)
update auth.users     set email    = 'kimhj@mir.local' where email    = 'kim@mir.local';
update public.profiles set username = 'kimhj'           where username = 'kim';
```
> 둘 중 하나만 바꾸면 "아이디↔이메일"이 어긋나 로그인이 안 됩니다. 반드시 둘 다.

---

## 7. 프로젝트 이름·코드 변경 / 삭제
```sql
-- 이름/코드 변경
update public.projects set name = '평택-오송 5공구(개정)', code = '5공구A'
 where code = '5공구';
```
```sql
-- 프로젝트 삭제 (배정·모델 DB행은 cascade로 함께 삭제)
delete from public.projects where code = '3공구';
```
> ⚠️ 프로젝트를 지워도 **Storage의 실제 IFC 파일은 자동 삭제되지 않습니다.**
> Storage → `models` 버킷에서 `<project_id>/` 폴더를 수동으로 지워주세요.

---

## 8. 모델(IFC) 삭제
```sql
-- 먼저 대상 확인 (storage_path 메모)
select id, name, storage_path from public.models
 where project_id = (select id from public.projects where code = '5공구');
```
```sql
-- DB 행 삭제
delete from public.models where id = '<model_id>';
```
그다음 **Storage → `models` 버킷**에서 위 `storage_path` 파일을 삭제합니다.
(앱에 삭제 버튼은 S2에서 추가 예정 · 삭제 권한은 admin)

---

## 9. 현황 조회
```sql
-- 사용자 목록
select username, full_name, is_admin from public.profiles order by username;
```
```sql
-- 누가 어느 프로젝트에 무슨 역할로 배정됐는지
select pr.username, pj.name as project, pm.role
  from public.project_members pm
  join public.profiles pr on pr.id = pm.user_id
  join public.projects pj on pj.id = pm.project_id
 order by pj.name, pr.username;
```

---

## 10. 참고
- 초기 일괄 셋업은 `supabase/seed.sql` (관리자 승격 + 프로젝트 + 멤버 배정, 멱등).
- 연결/권한 점검은 `npm run verify:e2e` (README "연결 검증" 참고).
- 위 수동 절차는 **S2 관리자 콘솔**에서 화면 버튼으로 자동화 예정.
