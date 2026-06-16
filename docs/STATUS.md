# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

**마지막 업데이트**: 2026-06-16 · S3 Vercel 배포 설정 완료 (PR 대기) 🚀

## 지금까지 한 일
- Phase 1: 3D IFC 뷰어 (Three.js + web-ifc) — 로드·탐색·선택·속성·표시제어.
- Phase 0: 인증(아이디 로그인) + 프로젝트별 권한(RLS) + 모델 저장(Storage).
  - DB 스키마/정책: `supabase/migrations/0001_init.sql`
  - 화면: 로그인 → 프로젝트 선택 → 작업공간(뷰어+모델 목록/업로드)
- **S1: 실제 Supabase 프로젝트 연결·라이브 검증 완료** (아래 검증 상태 참고).
- **S3: Vercel 배포 설정** — `vercel.json`(SPA rewrites + WASM/asset 캐시 헤더),
  GitHub Actions CI(`.github/workflows/ci.yml`: typecheck+build), README 배포 가이드.
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
- 📌 **사용자 액션 필요**: Vercel 대시보드에서 레포 import 후 환경변수
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`(anon 키만!) 설정 → Deploy.
  배포 URL 에서 로그인→프로젝트→IFC 열람 라이브 확인 (README "배포(Vercel)" 참고).

## 다음 할 일 (우선순위)
1. (사용자) Vercel 환경변수 입력 후 실제 URL 라이브 검증(로그인→프로젝트→IFC).
2. S2 관리자 콘솔(프로젝트·사용자·멤버 UI, service_role 자동가입) → S4 4D …

## 미해결 질문 / 메모
- 사용자 생성은 현재 Supabase 대시보드 수동 → S2에서 service_role 서버리스 함수로 자동화
  (메타데이터로 username 직접 지정 → 비-ASCII 보정 SQL 불필요화).
- 번들 크기 경고(three+web-ifc) → 추후 코드 스플리팅(별도 세션) 고려.
- 🐛 **뷰어 백로그**: 일부 교량 IFC(예: Case Study Bridge A)가 "누워서" 렌더됨.
  뷰어는 이미 Z-up→Y-up 회전 적용(`IfcViewer.ts:130`)하므로, 원인은 교량 IFC의
  지오레퍼런싱/좌표 오프셋·회전(IfcMapConversion/TrueNorth) 가능성. S1 무관(뷰어
  영역). S4(4D, 뷰어 중심)에서 같이 보정하거나 짧은 단독 수정 세션으로 처리.

## 다음 세션 인수인계 (한 줄)
> S3 완료: vercel.json(SPA rewrites)+CI 추가, 빌드 통과, main 으로 PR. 남은 건 사용자가
> Vercel에서 레포 import + 환경변수(anon 키) 입력 후 Deploy → 실제 URL 라이브 확인.
> 다음은 S2(관리자 콘솔) 또는 S4(4D) 권장.
