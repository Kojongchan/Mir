# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

**마지막 업데이트**: 2026-06-16 · S1 Supabase 연동 (진행 중, 키 대기)

## 지금까지 한 일
- Phase 1: 3D IFC 뷰어 (Three.js + web-ifc) — 로드·탐색·선택·속성·표시제어.
- Phase 0: 인증(아이디 로그인) + 프로젝트별 권한(RLS) + 모델 저장(Storage) **코드 완료**.
  - DB 스키마/정책: `supabase/migrations/0001_init.sql`
  - 화면: 로그인 → 프로젝트 선택 → 작업공간(뷰어+모델 목록/업로드)
- 멀티세션 워크플로우 백본: `CLAUDE.md`, `docs/`, SessionStart 훅(`.claude/`).
- `main` 통합 브랜치 생성 + PR 병합 전략 채택.

## 검증 상태
- ✅ `npm run typecheck` 통과, ✅ `npm run build` 성공, ✅ SessionStart 훅 동작.
- ‼️ **미검증(런타임)**: Supabase 인증·RLS·Storage 실제 동작 → **실제 키 대기 중**.

## S1 진행 상황 (branch: feature/supabase-wiring)
- ✅ 셋업 도구 준비 (키 없이 가능한 부분):
  - `supabase/seed.sql` — 관리자 승격 + 프로젝트 생성 + 멤버 배정 (멱등, 복붙용).
  - `scripts/verify-e2e.mjs` (`npm run verify:e2e`) — 브라우저 없이 로그인→RLS
    프로젝트/모델 목록→Storage 업로드/다운로드 왕복을 헤드리스로 점검.
  - AuthProvider 버그픽스: 미설정 시 네트워크 호출 스킵, profile fetch 에러 처리.
  - README "Supabase 설정"에 seed/verify 절차 반영.
- ✅ 키 수령(URL/publishable key/admin/테스트 사용자) → 로컬 `.env`(gitignore) 작성.
- ‼️ **블로커(라이브 검증)**: 이 원격 환경의 네트워크 egress 허용목록에 `*.supabase.co`
  가 없어 컨테이너→Supabase 호출이 403(`host_not_allowed`)으로 차단됨.
  → (a) 환경 egress 설정에 supabase 호스트 추가 후 재시도, 또는 (b) 사용자가 로컬에서
  `npm run verify:e2e` 실행 후 결과 공유. **둘 중 하나 필요.**
- ‼️ **버그 후보**: 한글 아이디(`고종찬`) → 매핑 이메일 `고종찬@mir.local` 의 비-ASCII
  local-part 를 GoTrue 가 거부할 수 있음. 권고: 로그인 아이디는 ASCII(`gojongchan` 등),
  표시명은 `full_name='고종찬'` 으로(앱은 full_name 우선 표시). S2 자동가입에서 정책 확정.

## 다음 할 일 (우선순위)
1. **S1 마무리**: 위 "사용자 입력 대기" 항목 → 라이브 검증.
2. S3 배포(Vercel) → S2 관리자 콘솔 → S4 4D …

## 미해결 질문 / 메모
- 첫 관리자 사용자는 생성 후 `profiles.is_admin = true` 수동 설정 필요 (S2에서 UI화).
- 사용자 생성은 현재 Supabase 대시보드 수동 → S2에서 service_role 서버리스 함수로 자동화.
- 번들 크기 경고(three+web-ifc) → 추후 코드 스플리팅(별도 세션) 고려.

## 다음 세션 인수인계 (한 줄)
> S1 셋업 도구(seed.sql·verify:e2e)·버그픽스 완료. Supabase 키만 받으면 `.env`+0001+버킷
> +seed 후 `npm run verify:e2e` 로 라이브 검증하고 PR.
