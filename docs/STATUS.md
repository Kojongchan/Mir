# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

**마지막 업데이트**: 2026-06-19 · S21~S23(포털 전 모듈) + **S24(권한: 쓰기 admin 전용, D11)** 완료.
S14·S21·S22·S23 = **PR #24 main 병합**. **다음=배포(0005~0009) 라이브 검증 · 잔여 폴리시**.

## 지금까지 한 일
- Phase 1: 3D IFC 뷰어 (Three.js + web-ifc) — 로드·탐색·선택·속성·표시제어.
- Phase 0: 인증(아이디 로그인) + 프로젝트별 권한(RLS) + 모델 저장(Storage).
  - DB 스키마/정책: `supabase/migrations/0001_init.sql`
  - 화면: 로그인 → 프로젝트 선택 → 작업공간(뷰어+모델 목록/업로드)
- **S1: 실제 Supabase 프로젝트 연결·라이브 검증 완료** (아래 검증 상태 참고).
- **S3: Vercel 배포 라이브 검증 완료** — `vercel.json`(SPA rewrites + WASM/asset 캐시
  헤더), GitHub Actions CI(`.github/workflows/ci.yml`: typecheck+build), README 가이드.
  실제 Vercel URL에서 로그인 성공 확인(사용자 검증). Supabase 키는 publishable(공개)
  키 사용 — supabase-js 호환 OK.
- **S2: 관리자 콘솔 구현 완료** (`/admin`) — 프로젝트·사용자·멤버를 화면에서 관리.
  service_role 자동가입으로 한글 아이디 **수동 보정 SQL 제거**(아래 S2 결과 참고).
- 멀티세션 워크플로우 백본: `CLAUDE.md`, `docs/`, SessionStart 훅(`.claude/`).
- `main` 통합 브랜치 생성 + PR 병합 전략 채택.

## 검증 상태
- ✅ `npm run typecheck` 통과, ✅ `npm run build` 성공, ✅ SessionStart 훅 동작.
- ✅ **라이브 검증 완료 (실제 Supabase)** — `npm run verify:e2e` (admin) 전 항목 통과:
  로그인·프로필/관리자플래그(트리거)·RLS 프로젝트 조회·모델 목록·Storage
  업로드/다운로드/insert/cleanup. 한글 아이디(`고종찬`) 브라우저 로그인→프로젝트
  선택(RLS)→작업공간/뷰어 진입까지 정상 확인.
- (선택 잔여) 실제 IFC 파일 업로드→뷰어 형상 렌더는 파일 준비 시 눈으로 확인 가능
  (Storage 경로·뷰어 그리드 렌더는 검증됨).

## S1 결과 (branch: feature/supabase-wiring → main PR)
- ✅ 셋업 도구: `supabase/seed.sql`(관리자 승격+프로젝트+멤버, 멱등),
  `scripts/verify-e2e.mjs`(`npm run verify:e2e`, 헤드리스 e2e),
  `scripts/username-email.mjs`(한글↔ASCII 이메일 매핑 + 대시보드용 CLI).
- ✅ 버그픽스: AuthProvider 미설정 시 네트워크 호출 스킵 + profile fetch 에러 처리.
- ✅ **한글 아이디 지원**: `usernameToEmail` — ASCII 는 그대로(`admin@mir.local`),
  비-ASCII 는 가역 인코딩(`u-<hex>@mir.local`)으로 매핑(GoTrue 비-ASCII 회피).
  사용자는 한글 아이디 그대로 로그인. (src/lib/supabase.ts ↔ username-email.mjs 동기)
- 📌 **운영 메모**: Supabase 대시보드 "Add user" 빠른 폼은 User Metadata 입력이
  없어, 비-ASCII 사용자는 생성 후 `profiles.username/full_name` 을 이메일 기준으로
  보정 + 멤버 배정하는 SQL 1회 필요(README 참고). S2 service_role 자동가입에서 해소.
- 📌 egress: 원격 웹 세션에서 Supabase 검증하려면 환경 네트워크 정책에
  `*.supabase.co` 허용 필요(이번엔 사용자 로컬 PC에서 검증). 

## S3 결과 (branch: feature/deploy-vercel → main PR)
- ✅ `vercel.json`: `framework:vite`, `buildCommand:npm run build`, `outputDirectory:dist`.
  - SPA `rewrites`(모든 경로→`/index.html`)로 react-router 새로고침/직접접속 404 방지.
  - `/web-ifc/*.wasm` → `application/wasm` + 1년 immutable 캐시, `/assets/*` immutable.
- ✅ CI: `.github/workflows/ci.yml` — main PR·push 마다 `npm ci → typecheck → build`.
  자격증명 없이 통과(supabase 미설정 시 안전 폴백).
- ✅ prebuild WASM 복사가 `dist/web-ifc/`에 포함됨을 빌드로 확인.
- ✅ **라이브 검증**: 사용자가 Vercel 레포 import + 환경변수(`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`=publishable 키) 설정 → Deploy → 실제 URL에서 **로그인 성공**.
  로그인 화면 렌더·SPA·WASM 포함 정상.
- 📌 운영 메모: Vercel Hobby/Supabase Free 둘 다 무기한 무료(자동 과금 X). Supabase
  무료 프로젝트는 **1주 미사용 시 자동 일시정지** → 대시보드 Restore 필요.
- 📌 키 메모: 사용자는 새 형식 publishable 키(`sb_publishable_...`) 사용. 만약 추후
  "Invalid API key" 발생 시 레거시 anon 키(JWT `eyJ...`)로 교체.

## S2 결과 (branch: claude/clever-maxwell-z64bhm → main PR, feature/admin-console)
- ✅ DB: `supabase/migrations/0002_admin.sql` — admin RLS **쓰기** 정책 추가
  (projects/project_members insert·update·delete, profiles update). 추가형·멱등.
- ✅ 서버리스: `api/admin.ts` (Vercel 함수) — service_role 로 사용자 **생성/삭제/비번변경**.
  호출자 access_token 검증 → `is_admin` 확인 후 처리. 생성 시 `user_metadata.username`
  직접 주입 → 한글 아이디도 **수동 보정 SQL 불필요**. (vercel.json rewrite 에서 `/api` 제외)
- ✅ UI: `src/pages/Admin.tsx` (`/admin`, 관리자 전용 가드) — 프로젝트/사용자/멤버 3탭.
  진입점: 프로젝트 선택 화면 우상단 `관리자 콘솔`(admin 만 노출). `src/lib/admin.ts` 데이터층.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. `api/admin.ts` 는 tsconfig 제외(Vercel
  가 배포 시 컴파일, @types/node 자동 제공) — 단독 tsc 시 `process` 만 미해결(정상).
- 📌 **배포 셋업 필요**: Vercel 서버 전용 env `SUPABASE_URL`,`SUPABASE_SERVICE_ROLE_KEY`
  추가(VITE_ 금지) + `0002_admin.sql` 실행 + 첫 관리자 1회 SQL 승격. README/OPERATIONS 0-A 참고.
- 📌 **미검증(egress)**: 실제 사용자 생성/삭제 라이브 테스트는 배포 환경 또는 `vercel dev`
  에서 필요(원격 세션 egress 제약). `npm run dev`(vite)에선 사용자 관리만 404, 프로젝트·멤버는 동작.

## S8 결과 (branch: claude/vibrant-goldberg-fxpfua)
- ✅ 긴 텍스트 오버플로우/좁은 화면 레이아웃 정리 (CSS 중심, 일부 구조 보정).
  - **프로젝트 선택**(`ProjectSelect`): 카드 고정폭(340/460px) → `width:100% + max-width`로
    반응형. `관리자 콘솔`/`로그아웃` 버튼 줄바꿈 방지(`white-space:nowrap` 전역 + 액션
    `flex-shrink:0`), 인사문구 블록 `min-width:0`로 축소·줄바꿈. 프로젝트명 말줄임(ellipsis),
    코드 칩 `flex-shrink:0`.
  - **워크스페이스**(`Workspace`): 상단바 `overflow:hidden`, 브랜드/툴바/버튼 `flex-shrink:0`,
    프로젝트명(`project-title`)·모델명(`model-name`)은 `min-width:0`+ellipsis로 말줄임.
  - **관리자 콘솔**(`Admin`): 상단바 사용자명 말줄임(`max-width:30vw`), 탭 `overflow-x:auto`,
    폼 행 `flex-wrap:wrap`, 3개 테이블을 `.admin-table-wrap`(가로 스크롤)로 감싸고
    `min-width:480px` 유지 → 좁은 화면에서 칸 깨짐 대신 가로 스크롤.
  - **속성 패널**·**모바일**: `.panel` 폭 `min(300px, 100vw-24px)`, `@media(max-width:640px)`
    에서 사이드바 260→180px 축소·여백 보정.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브 눈 검증은 사용자 화면에서 확인 권장)
- 📌 메모: 데이터 변경/마이그레이션 없음, 순수 표현(레이아웃) 변경.

## S9 결과 (branch: feature/admin-rename-username → main PR)
- ✅ 서버리스: `api/admin.ts` 에 `renameUser` 액션 추가 — `profiles.username` 과
  그로부터 계산되는 **내부 인증 이메일(auth.users.email)** 을 함께 변경
  (`updateUserById({ email, email_confirm, user_metadata.username })` + profiles update).
  변경 전 username 중복(profiles.username UNIQUE) 선검사 → 409 차단.
- ✅ 데이터층: `src/lib/admin.ts` `renameUserAccount(userId, username)`.
- ✅ UI: `src/pages/Admin.tsx` 사용자 탭에 `아이디 변경` 버튼(prompt) 추가 → 변경 후 목록 새로고침.
- ✅ 문서: `docs/OPERATIONS.md` 콘솔 기능 목록·6번(수동 SQL)에 콘솔 대체 안내 반영.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브 검증은 `/api/admin` 필요 →
  배포 환경 또는 `vercel dev`. S2와 동일 제약.)
- 📌 기존 미해결 질문(아이디 변경 미구현, auth.users.email 동기 필요) **해소**.

## S10 결과 (branch: claude/hopeful-davinci-ihxezk, 주제: ifc-georef) — 라이브 검증 완료
- 🐛 **진짜 원인(라이브로 확정)**: "대상교량 A"가 **Y-up 으로 내보내진** IFC. 뷰어는 모든
  모델에 무조건 Z-up→Y-up(`-π/2` X) 회전을 적용 → Y-up 모델은 오히려 옆으로 눕는다.
  (사진: 교각이 아래가 아니라 옆으로. 사용자가 콘솔 `window.__mirUpAxis('y')` 로 똑바로
  섬을 확인.) ← 1차 가설(`COORDINATE_TO_ORIGIN` 회전 오염)은 **오답**: 그 옵션 제거로
  방향이 안 바뀐 것이 단서였음. (IfcMapConversion/TrueNorth 는 수직축 회전 → 누움 무관.)
- ✅ **수정** (`src/viewer/IfcViewer.ts` + `Workspace`):
  - `COORDINATE_TO_ORIGIN:false` + 첫 요소 원점 **이동분만** 빼 재중심화(정밀도 보존).
  - **up축 기본값 Y-up 고정**(사용자 결정): `loadIfc` 가 회전 없이(=Y-up) 그림. 다루는
    교량 IFC가 Y-up으로 내보내지므로 이게 정답. `orientGroup`/`setUpAxis` 로 모델 단위 적용.
  - 자동감지(컨텍스트 WCS·bbox·법선) 시도는 **폐기**: WCS 미선언(undefined)이고, 법선
    기반은 사각 단면 기둥 등에서 오판 위험(사용자 지적). → 단순 고정값이 맞다.
  - override 유지: 콘솔 `window.__mirUpAxis('z')` → `localStorage`(`mir.upaxis.<modelId>`)에
    모델별 기억(Z-up 모델이 나중에 들어올 때 대비). 진단 `[IFC-georef]` 로그 유지.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브: Y-up 고정으로 교량 똑바로 섬)
- 📌 **트레이드오프**: 기본 Y-up이라 **정통 Z-up IFC는 눕는다** → 그 경우 override(`'z'`)
  필요. 참고: 사용자 레포 `bim-thesis-viewer`(교량 안 누움)의 로딩/방향 처리 방식에
  맞추면 양쪽(Z/Y) 모두 정확히 처리 가능 — 세션 권한이 mir로 한정돼 직접 못 읽음(코드
  공유 시 반영). DB(`models.up_axis`) 저장으로 승격도 후보.

## S4 결과 (branch: feature/4d-simulation → main PR) — 4D 시공 시뮬레이션 1차
- ✅ 공정표 CSV 임포트: **Navisworks(한글·EUC-KR)·Fuzor(영문·UTF-8) 자동 인식**.
  헤더 기반 파서(`src/lib/schedule.ts`) — 인코딩 자동 디코딩, `OutlineNumber` 상위
  (합계) 작업 제외, 작업 유형(시공/철거/장비/임시) 정규화.
- ✅ 일정↔객체 매핑(`src/lib/fourd.ts`): **이름 매핑** + **순서 자동배정**(이름이 안
  맞으면 5% 미만 시 자동 폴백). 한 요소가 여러 작업이면 built>active>future 우선순위.
- ✅ 뷰어 연동: `IfcViewer.getElementCatalog/applyConstruction/clearConstruction`
  추가(기존 `setElementVisible` 위에서). 시공완료=원색, 진행중=주황, 미시공=숨김/반투명.
- ✅ UI(`src/components/Timeline.tsx`): 하단 패널 — 임포트·4D토글·매핑·재생(속도)·
  타임슬라이더·간트(현재시점 커서). Workspace 그리드에 `tl` 행 추가, 모델 교체 시 매핑 초기화.
- ✅ DB **설계만**: `supabase/migrations/0003_schedule.sql`(schedules/schedule_tasks/
  task_elements 다대다 + models 동일 RLS). 현재는 프론트 로컬상태+CSV로 동작.
- ✅ 샘플: `public/samples/`(두 CSV + README), 설계 문서 `docs/4D.md`.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과 + 파서 두 샘플 파싱 확인
  (Navisworks 21작업, Fuzor 59작업). 라이브 눈 검증(실 IFC+슬라이더)은 사용자 화면 권장.
- ✅ **후속 보강(동 세션)**: 철거(demolish) **생애주기** 반영(생성 후 철거→removed/숨김),
  **수동 매핑 UI**(간트 행 ＋로 선택 객체 연결), **증분 갱신**(상태 바뀐 메시만),
  **DB 저장/로드**(`src/lib/scheduleApi.ts` + 타임라인 DB 저장/불러오기/삭제, 0003 스키마).
- 📌 한계/다음: 정밀 GUID 매핑은 **기준 정립 후 보완**(사용자 결정으로 현재 미추가).
  DB 저장/로드 **라이브 검증**은 0003 적용 + 배포 환경 필요(원격 egress 제약).

## S11 결과 (branch: claude/youthful-meitner-nu7ojt, 주제: ui-refresh) — Phase 6 UI/UX 리뉴얼
- ✅ **디자인 토큰화**(`src/index.css`): 라이트 기본 + **네이비 구조색**(상단바·상태바·
  관리자 헤더) + **블루 강조**. 모든 색을 `--*` 토큰으로만 참조하도록 재작성(레이아웃·
  클래스명·반응형은 그대로 — S8 표현만 원칙). 4D 칩/간트 바의 하드코딩 색도 토큰화해
  라이트/다크 양쪽에서 가독성 확보.
- ✅ **다크모드 토글 보존**: `src/lib/theme.ts`(`<html data-theme>` + `localStorage('mir.theme')`,
  기본 light) + `src/components/ThemeToggle.tsx`. `main.tsx` 에서 `initTheme()` 렌더 전
  호출(깜빡임 방지). 토글을 로그인·프로젝트선택·워크스페이스 상단바·관리자 헤더에 배치.
- ✅ **Pretendard** 도입(`index.css` 상단 jsDelivr CDN `@import`, 동적 서브셋) + 시스템 폴백.
- ✅ **리스킨**: 로그인→프로젝트선택→워크스페이스→관리자→타임라인 순으로 표면/강조/그림자/
  라운드/입력 focus 링/고스트 버튼 적용. 기능·데이터·마이그레이션 변경 **없음**.
- ✅ **디자인 시스템 문서 분리**: `docs/DESIGN.md`(토큰 표·테마 규칙·타이포·인터랙션).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 16.76kB). 라이트/다크 눈 검증은 사용자 화면 권장.
- 📌 브랜치 메모: 요청은 `feature/ui-refresh` 였으나 원격 세션이 지정한 작업 브랜치
  `claude/youthful-meitner-nu7ojt` 에서 작업·푸시 → main 으로 PR(#14 머지됨).
- ✅ **S11 후속(브랜딩)**: 3D 뷰포트 배경 **흰색**(`IfcViewer` `scene.background=0xffffff`,
  그리드도 밝은 회색으로). 브랜드를 로고 색으로 — `BrandLogo`(SS 마크 + **MIR 회색
  / VDC 빨강**), 토큰 `--brand-gray`/`--brand-red`. 로그인·프로젝트선택·워크스페이스·
  관리자 4곳 적용. SS 마크는 공식 로고 근사 인라인 SVG(공식 에셋 받으면 교체 가능).

## S12 결과 (branch: claude/youthful-meitner-nu7ojt, 주제: branding-rename)
- ✅ **제품명 MIR_VDC → MIR SMART** (UI 전반: `BrandLogo` 워드마크 MIR(회색)/SMART(빨강),
  `index.html` 제목·파비콘, 로그인 부제). 내부 docs 일부 표기는 점진 정리.
- ✅ **공식 로고 적용**: `public/brand/ss-logo.png`(SS 마크, 인라인 SVG 근사 → 실제
  이미지로 교체), `public/brand/ssyenc-ci.png`(쌍용건설 CI). `public/samples/` 에서
  ASCII 경로로 이동.
- ✅ **로그인(메인 홈) 보강**: 우상단 **쌍용건설 CI**(다크 테마는 흰 칩 위), 좌상단
  테마 토글, 부제 "쌍용건설 스마트 건설기술 플랫폼에 오신 것을 환영합니다.", 하단
  푸터(좌: `© Copyright Ssangyong E&C. All Rights Reserved` / 우:
  `Designed by Civil Engineering Technology Team, Smart Construction Part`).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과, `dist/brand/*` 포함 확인.
- ✅ **로그인 리파인(후속)**: 부제 "스마트 건설기술 플랫폼" 굵게 강조, 우상단 쌍용 CI
  제거(테마 토글 우상단 원위치), 푸터 고급화(상단 구분선·글래스 배경·회사명 굵게·팀명
  강조색), 배경에 톤다운 블루프린트 그리드+블루 글로우(CSS, 외부 이미지 불필요).
  `ssyenc-ci.png` 는 미사용 보존.
- ✅ **로고/카드 마무리**: 로그인 로고 lg 복귀 + MIR SMART 글자를 마크 높이에 맞춰 확대
  (lg word 52px), 카드 폭 460px 로 넓혀 부제 한 줄. 푸터 최종 문구 확정
  `Designed by Civil Engineering Technology Team, Smart Construction Part`.
- 📌 **도메인(코드 밖)**: 현재 `mir-kappa...`(Vercel 자동 서브도메인). 사용자는 당분간
  Vercel 주소 유지(`mir-smart...vercel.app` 로 프로젝트명 변경은 대시보드에서), `.com`(ssyenc)
  은 사내 전산실 DNS 호스팅으로 추후 연결 예정. `mir_smart`(언더스코어)는 호스트명 불가.

## S13 결과 (branch: claude/magical-cray-dh6tb5, 주제: doc-viewers) — Phase 8 문서·미디어 뷰어 1단계
- ✅ **새 라우트 `/view/:fileId`**(`src/pages/FileViewer.tsx`) — 저장소 파일을 **새 탭**
  으로 열어 미리보기. 파일 레코드 조회(RLS) → **짧은 만료(10분) 서명 URL** 발급 →
  mime/확장자로 뷰어 분기(`src/lib/files.ts` `viewerKindFor`). App.tsx 에 `Protected` 라우트 추가.
- ✅ **데이터/스토리지**: 마이그레이션 `supabase/migrations/0004_files.sql` — `public.files`
  테이블 + RLS(멤버 select/insert, admin delete) + Storage **`docs`** 버킷 정책(모델과
  동일한 `<project_id>/<file_id>.<ext>` 경로 규칙 → 멤버만 접근). `src/lib/files.ts`:
  `listFiles/getFile/uploadFile/deleteFile/signedFileUrl` + 카테고리 판별·sizeLabel.
- ✅ **뷰어(웹 단독·서버 0원)** `src/components/viewers/`: 이미지(native `<img>`),
  동영상(native `<video>`), 오디오(native `<audio>`), **PDF=PDF.js**(페이지별 canvas
  렌더, `pdf.worker.min.mjs?url`), **Excel=SheetJS**(xlsx/xls/csv → 시트 탭 + HTML 테이블),
  **Word=mammoth.js**(docx → HTML), 텍스트(txt/md/json…). 미지원(avi/pptx/doc/hwp 등)은
  **다운로드 폴백**(`DownloadFallback`)으로 막다른 길 없음.
- ✅ **워크스페이스 연동**(`src/pages/Workspace.tsx`): 사이드바에 **`문서 · 미디어`** 섹션
  (업로드 + 목록), 항목 클릭 시 `window.open('/view/:id', '_blank')` 새 탭.
- ✅ **코드 스플리팅**: 무거운 뷰어(PDF.js/SheetJS/mammoth)를 `React.lazy`로 분리 →
  메인 번들 gzip **1006KB→650KB**. (PdfViewer/SheetViewer/DocxViewer 별도 청크 + pdf.worker)
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. 라이브 눈 검증은 `docs` 버킷 생성 +
  0004 적용 후 사용자 화면 권장(원격 egress 제약).
- 📌 **배포 셋업 필요**: `0004_files.sql` 실행 + Supabase **`docs`(Private) 버킷 생성**.
  (docs/OPERATIONS.md 0-B 참고)
- ⚠️ **SheetJS 보안 한계**: npm `xlsx`는 0.18.5(prototype pollution·ReDoS advisory)만 제공,
  패치판(≥0.20.x)은 `cdn.sheetjs.com`에서만 배포되는데 **네트워크 정책 차단**. 파일은
  프로젝트 멤버만 업로드 가능(RLS)해 노출이 제한되지만, 정책 허용 시 CDN 빌드로 교체 권장.
- 🔜 **2단계(별도 세션)**: 서버 변환 파이프라인(avi→mp4, pptx/doc/hwp→PDF) — 분리.
- 📌 브랜치 메모: 작업 브랜치 `claude/magical-cray-dh6tb5`(원격 세션 지정)에서 작업·푸시.
  요청 주제명은 `feature/doc-viewers`. **PR #22 main 병합 완료.**

## 확장 기획 (PLAN, branch: claude/eager-dirac-a0dacr) — 기획창 신설 + 로드맵 재정렬
- ✅ **`docs/PLANNING.md` 신설**: 사용자가 준 7개 확장 요구를 가능여부 판단과 함께 정리.
  - ① UI 리뉴얼(화이트+네이비) → **S11 ✅ 완료** (+ S12 브랜딩 MIR SMART ✅ 완료).
  - ③ 문서·미디어 뷰어(새 탭): 이미지/PDF/mp4/xlsx/docx = 🟢, avi/pptx/doc/hwp = 🟡 서버변환
    → **하이브리드** → **S13 ✅ 완료(PR #22 병합, 1단계)**.
  - ④ CDE(ISO 19650): 좌측 "모듈+폴더트리" 재편 + 파일 저장소(버전/이력, 상태
    `WIP→Shared→Published→Archived`), 활동로그 → **S14(다음 권장)**. PR #22 가 만든 `files`
    테이블·`docs` 버킷 위에 folders/versions/status/activity 를 얹는다(마이그레이션 `0005_cde.sql`).
  - ⑤ Navisworks 기능군 → **S15 ⏳ 입력대기** · ⑥ 장비 시뮬(Rapier) → **S16 ⏳ 이미지대기**
    · ⑦ 네이티브 BIM(rvt/nwd/dwg) 🔴 → **하이브리드 권장**(IFC=web-ifc 유지, 원본은 CDE 보관/
    다운로드, 열람은 APS Viewer 또는 IFC export) → **S17 🔴 결정대기**.
- 📌 **세션번호 재정렬**: main 이 S12 를 브랜딩으로 선점 → 기획안의 S12(CDE)를 **S14** 로 이동.
  최종: S11 UI✅ · S12 브랜딩✅ · S13 문서뷰어✅ · **S14 CDE** · S15 NW · S16 장비 · S17 네이티브 · S18 스플리팅.
- ✅ `ROADMAP.md` Phase 6~10 + 세션 S11~S18 반영(재정렬).

## S14 결과 (branch: claude/busy-lovelace-cj8adq, 주제: cde-foundation) — Phase 7 CDE 토대 + 파일 저장소 MVP
- ✅ **마이그레이션 `supabase/migrations/0005_cde.sql`**(추가형, 0001~0004 무수정): `folders`
  (프로젝트 폴더트리, parent_id) · `file_versions`(파일당 다중 버전, `<project>/<file>/v<n>.<ext>`) ·
  `activity_log`(감사 이력) 신설 + `files` 에 `folder_id`(on delete set null=문서 보존) ·
  `status`(enum `file_status` WIP/Shared/Published/Archived, 기본 WIP) · `current_version_id`(FK) 추가.
  RLS는 **기존 `is_member`/`is_admin` 재사용**(file_versions 는 부모 파일의 project로 멤버십 판정).
  기존 S13 파일은 **v1 자동 백필** + `files_update` 정책 추가(상태/이동). `docs` 버킷 그대로 사용.
- ✅ **데이터층 `src/lib/cde.ts`**: 폴더 CRUD, `listCdeFiles`(폴더별), `uploadNewFile`(v1 생성),
  `uploadNewVersion`(v2+ 누적 + `files.storage_path` 최신 버전으로 재지정 → 뷰어는 항상 최신 열람),
  `listVersions`, `setFileStatus`, `moveFile`, `deleteCdeFile`(모든 버전+오브젝트, admin RLS),
  `signedUrl`, `logActivity`/`listActivity`, `buildFolderTree`.
- ✅ **화면 `/project/:id/docs`**(`src/pages/DocumentManager.tsx`) + 컴포넌트
  (`components/cde/FolderTree·StatusBadge·VersionHistory·ActivityLog`): 좌측 폴더트리(생성·이름변경·
  빈 폴더 삭제) + 우측 문서 테이블(상태 뱃지·상태 변경 select·이력·새 버전·삭제[admin]·새 탭 미리보기),
  브레드크럼, 활동 로그 모달. App.tsx 라우트 추가, 워크스페이스 상단 **`자료 관리`** 진입 버튼.
- ✅ **워크스페이스 연동**: 사이드바 `문서·미디어` 업로드를 `cde.uploadNewFile`(루트=미분류, v1+활동)로
  일원화 → 두 경로 모두 버전·활동이 일관. 기존 `/view/:fileId` 뷰어는 그대로(최신 버전 storage_path).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 25.68kB). 라이브 눈 검증은 `0005` 적용 후 권장.
- 📌 **배포 셋업 필요**: `0005_cde.sql` 실행(docs/OPERATIONS.md **0-C**). 새 버킷 불필요(0-B `docs` 재사용).
- 📌 한계/다음: 활동 로그는 actor를 username으로 미해석(profiles RLS=본인/admin만) → 시간+동작+대상명
  표시. 폴더 삭제는 빈 폴더만(클라 가드). 체크인/체크아웃·승인 워크플로우·자료전송(transmittal)·
  태그/검색은 후속. 문서 폴더 이동 UI는 데이터층(`moveFile`)만 준비(버튼 미노출).

## S24 결과 (branch: claude/busy-lovelace-cj8adq) — 권한: 쓰기는 admin만 (D11)
> 사용자 결정 "모든 건 admin 계정이 진행" → 포털·CDE·업로드의 모든 쓰기를 관리자 전용으로.
- ✅ **`0009_admin_writes.sql`**(추가형): folders·project_info·milestones·daily_logs·monthly_records·
  issues·posts·subcontracts 의 insert/update/delete + file_versions·issue_comments·files·models insert
  + Storage docs/models write 를 **`is_admin()`** 로 교체. **SELECT(멤버 열람) 전부 유지**. activity_log
  insert 만 멤버 허용(감사 기록 유지). → DECISIONS **D11** 기록.
- ✅ **UI 가드**: 비-admin 에는 모든 편집 컨트롤 숨김 — 대시보드 `편집`, 공사일보 폼/삭제, 이슈
  등록/상태/코멘트/삭제, 기성 도급액 저장, 하도급 등록/삭제, 게시판 글쓰기/삭제, CDE 폴더/업로드/
  새버전/상태/삭제, 워크스페이스 IFC·파일 업로드. 멤버는 읽기 전용으로 전 모듈 열람.
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0009_admin_writes.sql` 실행(0005~0008 이후).
- 📌 **머지**: S14·S21·S22·S23 = **PR #24 main 병합 완료**(사용자 확인용). 본 권한 변경은 별도 PR.

## S23 결과 (branch: claude/busy-lovelace-cj8adq, 주제: portal-modules-2) — Phase 13 기성·하도급·게시판
> P3 게시판 · P4 기성내역 · P5 하도급 완료 → **포털 좌측 메뉴 1차 전 모듈 동작**.
- ✅ **`0008_portal_extra.sql`**(추가형): `posts`(게시판/공지·고정) + `subcontracts`(협력사
  계약/지급/상태) + `project_info.contract_amount`(도급액). RLS 멤버 읽기/쓰기. 새 버킷 없음.
- ✅ **`src/lib/portal.ts`**: 게시판 CRUD · 하도급 CRUD · 도급액 get/save(대시보드 select 와
  **분리** → 0008 미적용 환경에서도 대시보드 안 깨짐).
- ✅ **기성내역 `Billing.tsx`**: 도급액 입력 + 누적 기성·기성률·잔여 요약 카드 + 월별 기성
  막대(MiniChart bar)·누적표(monthly_records 금액 재사용).
- ✅ **하도급내역 `Subcontracts.tsx`**: 협력사 등록/삭제 + 계약·지급 합계·지급률·협력사 수 요약.
- ✅ **게시판 `Board.tsx`**: 공지 글 작성/펼침/삭제·상단 고정.
- ✅ 좌측 메뉴: 사업개요·공정현황·공사일보·협업이슈·**기성내역·하도급내역·게시판**·모델뷰어·자료관리·구성원.
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0008` 실행(OPERATIONS 0-D 갱신).
- 📌 **남은(P6 폴리시)**: 마일스톤 드래그 정렬, 공사일보 사진 첨부(CDE 연계), 이슈↔문서 연결 UI,
  권한 세분화(viewer 읽기전용/editor 편집), 기성 공종별 상세, 게시판 첨부/댓글.

## S22 결과 (branch: claude/busy-lovelace-cj8adq, 주제: portal-modules) — Phase 12 공정현황 + 협업·이슈
> 사용자 지시 "다 해야 한다, 우선순위는 네가" → **P1 협업·이슈 + P2 공정현황** 먼저(핵심 협업 + 데이터 재사용).
- ✅ **P1 협업·이슈** — `0007_issues.sql`(추가형): `issues`(제목·내용·상태 open/in_progress/
  resolved/closed·우선순위·담당자·기한·관련문서 file_id) + `issue_comments`(코멘트 스레드).
  RLS 멤버 읽기/쓰기, 코멘트는 부모 이슈 프로젝트로 판정. actor는 텍스트(created_by_name/
  author_name, profiles RLS 회피 — 본인 username은 읽을 수 있어 저장). `src/lib/issues.ts` +
  `src/pages/Issues.tsx`(필터·등록 폼·상태 변경·코멘트·삭제). 대시보드에 **미해결 이슈 카드** 추가.
- ✅ **P2 공정현황** — 새 마이그레이션 없이 dashboard 데이터 재사용. `src/pages/Schedule.tsx`:
  **마일스톤 타임라인**(착공→준공 비례 위치 + 오늘 커서) + **진도 곡선(S-curve)** 계획 vs 실적
  (`MiniChart`) + 월별 차이 표 + **4D 시뮬레이션 바로가기**(viewer).
- ✅ 좌측 모듈 메뉴 확장: 사업개요·**공정현황**·공사일보·**협업·이슈**·모델뷰어·자료 관리·구성원.
  중첩 라우트 `/schedule`·`/issues` 추가.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과.
- 📌 **배포 셋업**: `0007_issues.sql` 실행(0005·0006 과 함께, OPERATIONS 0-D). 새 버킷 없음.
- 📌 **남은 모듈(다음 턴)**: P3 게시판/공지 · P4 기성내역 상세 · P5 하도급내역 · P6 폴리시
  (마일스톤 드래그 정렬·공사일보 사진 첨부(CDE 연계)·권한 세분화). 이슈 file_id 연결 UI는 후속.

## S21 결과 (branch: claude/busy-lovelace-cj8adq, 주제: pmis-portal) — Phase 11 사업관리 포털
> 사용자 목표 = **PROJECT WORKS형 사업관리 포털**(좌측 모듈 메뉴 + 사업개요 대시보드).
> 기존 "3D 뷰어 중심 작업화면"을 **포털**로 재편: 프로젝트 진입 첫 화면 = 사업개요 대시보드.
- ✅ **마이그레이션 `0006_dashboard.sql`**(추가형, 0001~0005 무수정): `project_info`(착공/준공/
  전체 진행률/개요) · `project_milestones`(노반·궤도·개통 등 D-day) · `daily_logs`(공사일보:
  일자별 인력·장비·날씨·내용) · `monthly_records`(월별 계획/실적%·기성금액). RLS는 멤버 읽기 +
  멤버/admin 쓰기(folders 패턴, `is_member`/`is_admin` 재사용). **데이터는 앱에서 직접 입력·편집**(사용자 결정).
- ✅ **데이터층 `src/lib/dashboard.ts`**: project_info upsert, 마일스톤 CRUD, daily_logs CRUD,
  monthly_records upsert/삭제 + D-day/날짜/금액 포맷 헬퍼.
- ✅ **포털 셸 `ProjectShell` + `ProjectNav`**: 좌측 모듈 레일(사업개요·공사일보·모델뷰어·자료 관리·
  구성원[admin]) + 상단 크롬. 라우팅 재편: `/project/:id`=대시보드(중첩 라우트, index),
  `/project/:id/logs`=공사일보, `/project/:id/viewer`=기존 3D 워크스페이스(풀스크린 이동),
  `/project/:id/docs`=CDE. ProjectSelect→`/project/:id`는 이제 대시보드로 진입.
- ✅ **사업개요 대시보드 `Dashboard.tsx`**: 착공 D+경과·마일스톤·준공 D-day 띠, 전체 진행률 바,
  공사일지 현황(인력 추이)·기성 현황(계획vs실적%) **경량 SVG 차트**(`MiniChart`, 무의존),
  투입인력·장비현황 스탯 카드, 모델뷰어 바로가기 카드. **편집 토글**로 사업정보/마일스톤/월별 실적
  인라인 입력·저장. **공사일보 `DailyLogs.tsx`** 일자별 등록/삭제(대시보드 인력·장비·일지 수치 연동).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 29.76kB, 차트 라이브러리 무추가).
- 📌 **배포 셋업**: `0006_dashboard.sql` 실행(0005 와 함께). 새 버킷·외부 의존 없음.
- 📌 다음 후속: 공사일보 사진/첨부(CDE 연계), 기성 금액 단위·통화, 마일스톤 정렬 드래그,
  4D 공정/협업(이슈)·물량 모듈은 별도 세션. 권한 세분화(현재 멤버=편집 가능).

## 다음 할 일 (우선순위)
1. **배포 셋업 + 라이브 검증**(사용자): `0005_cde.sql`·`0006_dashboard.sql` 실행 후
   대시보드 입력(착공/진행률/마일스톤/일보/월별실적)·CDE(폴더·버전·상태·활동) 동작 확인.
2. **S13 배포 셋업 완료**(사용자) — `docs` 버킷 + `0004_files.sql` 적용 후 **라이브 검증**:
   이미지·PDF·동영상·xlsx·docx 동작 확인. **품질 평가**: Word/Excel 충실도 보통, PPT/HWP 미지원.
   → **결정 D10(단기+장기)**. 후속: **S19(docx-preview 등 무료 클라 업그레이드)** /
   **S20(서버 변환→PDF, PPT·HWP)**.
3. **사용자 입력 필요**: S15(Navisworks 기능 목록), S16(장비 샘플 이미지), S17(APS 도입·예산 결정).
4. **S4 라이브 눈 검증** — 실 IFC 모델 + 샘플 CSV 임포트 → 순서배정 → 슬라이더/재생 확인.
5. (선택) up축 기억을 브라우저 localStorage→DB(models 컬럼)로 승격해 사용자/기기 간 공유.

## 미해결 질문 / 메모
- ✅ (해소) 사용자 생성 자동화 — S2 `api/admin.ts` service_role 함수 + `user_metadata.username`
  직접 주입으로 비-ASCII 보정 SQL 제거. 배포 환경 env 설정 후 라이브 검증만 남음.
- ✅ (해소) 콘솔의 username(로그인 아이디) **변경** — S9 `api/admin.ts` `renameUser`
  액션으로 username+내부 이메일 동기 변경 추가(사용자 탭 `아이디 변경` 버튼).
- 번들 크기 경고(three+web-ifc) → **S18(성능·코드 스플리팅)**. S13(PR #22)에서 무거운
  뷰어를 `React.lazy` 로 분리해 메인 번들 1006KB→650KB 로 **일부 선반영**됨.
- ✅ (해소) **뷰어 백로그**: 일부 교량 IFC 누움 → S10 에서 원인(web-ifc
  `COORDINATE_TO_ORIGIN` 의 첫 요소 회전 오염) 규명·수정. 실제 파일 눈 검증만 잔여.

## 다음 세션 인수인계 (한 줄)
> **S23 완료 → 포털 좌측 메뉴 모든 모듈 1차 동작**: 기성내역(`/billing`)·하도급(`/subcontracts`)·
> 게시판(`/board`) 추가(`0008_portal_extra.sql`: posts·subcontracts·project_info.contract_amount,
> `src/lib/portal.ts`). **배포: 0005+0006+0007+0008 순서대로 실행**(새 버킷 전혀 없음, OPERATIONS 0-C/0-D).
> **다음(P6 폴리시)**: 마일스톤 정렬·공사일보 첨부·이슈↔문서 연결·권한 세분화. 아래 S22/S21 기록 참고.

> (이전) **S22 완료**: 공정현황(`/schedule`, 마일스톤 타임라인+S-curve+4D 바로가기) + 협업·이슈
> (`/issues`, `0007_issues.sql`: issues+issue_comments, `src/lib/issues.ts`) 모듈 추가, 좌측
> 메뉴/대시보드(미해결 이슈 카드) 반영. **배포: 0005+0006+0007 실행**(새 버킷 없음, OPERATIONS 0-C/0-D).
> 사용자 지시="포털 전체 모듈 다 만들기, 우선순위는 Claude가". **남은 우선순위**: P3 게시판 ·
> P4 기성내역 상세 · P5 하도급 · P6 폴리시(마일스톤 정렬·일보 첨부·권한 세분화) — 다음 턴 진행.

> (이전) **S21(사업관리 포털) 완료**: 프로젝트 진입 첫 화면을 **사업개요 대시보드**로 재편 + 좌측
> 모듈 메뉴(사업개요·공사일보·모델뷰어·자료 관리). `0006_dashboard.sql`(project_info/
> milestones/daily_logs/monthly_records, 앱 내 직접 입력) + `src/lib/dashboard.ts` +
> `ProjectShell`/`ProjectNav`/`Dashboard`/`DailyLogs` + 무의존 `MiniChart`. 3D 뷰어는
> `/project/:id/viewer`로 이동. **배포 셋업**: `0005`+`0006` 실행(새 버킷 불필요).
> 다음 후속: 4D 공정·협업(이슈)·물량 모듈, 권한 세분화, 공사일보 첨부. 아래 S14 기록 참고.

> (이전) S11(UI)·S12(브랜딩)·S13(문서뷰어)·**S14(CDE 토대 + 파일 저장소 MVP) 완료**(branch
> `claude/busy-lovelace-cj8adq`). `0005_cde.sql`(folders/file_versions/activity_log + files 컬럼) +
> `src/lib/cde.ts` + `/project/:id/docs`(`DocumentManager`) + `components/cde/*`. 워크스페이스
> 상단 `자료 관리` 진입. **배포 셋업 잔여**: `0005_cde.sql` 실행(OPERATIONS **0-C**, 새 버킷 불필요).
> **다음**: S14 라이브 검증 + S13 배포 셋업(OPERATIONS 0-B). S15 NW·S16 장비는 입력 대기,
> S17 네이티브는 APS 결정 후. CDE 후속(체크인/락·승인 워크플로우·transmittal·검색)은 별도 세션.
> (뷰어) S10: 교량 누움은 up축 기본 Y-up 고정으로 해결(override 콘솔 `__mirUpAxis('z')`).
