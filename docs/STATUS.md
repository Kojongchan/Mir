# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

**마지막 업데이트**: 2026-06-16 · S2 관리자 콘솔 **구현 완료** (typecheck/build 통과, 라이브 검증 대기)

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

## 다음 할 일 (우선순위) — 사용자 요청: S4 전에 다듬기 먼저
1. **S8 UI 다듬기** — 메인/워크스페이스/관리자 콘솔에서 긴 텍스트 칸 넘침·좁은 화면 정리.
2. **S9 콘솔 로그인 아이디 변경** — username+인증 이메일 동기 변경(서버리스 액션 확장).
3. **S11 번들 코드 스플리팅** — three/web-ifc 동적 import·manualChunks, 빌드 경고 해소.
4. **S10 교량 IFC 누움 보정** — 지오레퍼런싱(IfcMapConversion/TrueNorth) 분석·수정.
5. 이후 **S4 4D 시뮬레이션**(일정↔객체, 타임슬라이더).
> 각 항목은 독립 브랜치·대화로 진행(ROADMAP "다듬기 세션" 표 참고).

## 미해결 질문 / 메모
- ✅ (해소) 사용자 생성 자동화 — S2 `api/admin.ts` service_role 함수 + `user_metadata.username`
  직접 주입으로 비-ASCII 보정 SQL 제거. 배포 환경 env 설정 후 라이브 검증만 남음.
- 콘솔의 username(로그인 아이디) **변경**은 미구현(auth.users.email 동기 필요) — 필요 시
  서버리스 액션으로 추가. 현재는 표시이름/관리자플래그/비번/배정만 화면 관리.
- 번들 크기 경고(three+web-ifc) → 추후 코드 스플리팅(별도 세션) 고려.
- 🐛 **뷰어 백로그**: 일부 교량 IFC(예: Case Study Bridge A)가 "누워서" 렌더됨.
  뷰어는 이미 Z-up→Y-up 회전 적용(`IfcViewer.ts:130`)하므로, 원인은 교량 IFC의
  지오레퍼런싱/좌표 오프셋·회전(IfcMapConversion/TrueNorth) 가능성. S1 무관(뷰어
  영역). S4(4D, 뷰어 중심)에서 같이 보정하거나 짧은 단독 수정 세션으로 처리.

## 다음 세션 인수인계 (한 줄)
> S2 완료·배포·라이브 확인됨(PR #3 main 병합, admin 계정 is_admin=true, `관리자 콘솔` 동작).
> 사용자 요청으로 S4 전에 **다듬기 세션 S8~S11**(UI 오버플로우 / 콘솔 아이디변경 / 번들
> 스플리팅 / 교량 누움)을 추가, 각각 독립 브랜치·대화로 진행. 다음 권장: **S8 UI 다듬기**.
> (ROADMAP "다듬기 세션" 표 + 위 "다음 할 일" 참고.)
