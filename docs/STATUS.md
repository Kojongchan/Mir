# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

**마지막 업데이트**: 2026-06-16 · 워크플로우/백본 셋업 세션

## 지금까지 한 일
- Phase 1: 3D IFC 뷰어 (Three.js + web-ifc) — 로드·탐색·선택·속성·표시제어.
- Phase 0: 인증(아이디 로그인) + 프로젝트별 권한(RLS) + 모델 저장(Storage) **코드 완료**.
  - DB 스키마/정책: `supabase/migrations/0001_init.sql`
  - 화면: 로그인 → 프로젝트 선택 → 작업공간(뷰어+모델 목록/업로드)
- 멀티세션 워크플로우 백본: `CLAUDE.md`, `docs/`, SessionStart 훅(`.claude/`).
- `main` 통합 브랜치 생성 + PR 병합 전략 채택.

## 검증 상태
- ✅ `npm run typecheck` 통과, ✅ `npm run build` 성공, ✅ SessionStart 훅 동작.
- ‼️ **미검증(런타임)**: Supabase 인증·RLS·Storage 실제 동작 → 실제 프로젝트 연결 후 확인 필요(=S1).

## 다음 할 일 (우선순위)
1. **S1 — Supabase 연동 & 인증 검증** (다음 세션)
   - 사용자: supabase.com 프로젝트 생성 → URL/anon key 발급 (README "Supabase 설정" 참고)
   - 작업: `.env` 연결, `0001_init.sql` 실행, `models` 비공개 버킷 생성,
     첫 관리자/테스트 사용자/프로젝트 생성, 로그인→업로드→뷰 end-to-end 확인·버그픽스
2. S3 배포(Vercel) → S2 관리자 콘솔 → S4 4D …

## 미해결 질문 / 메모
- 첫 관리자 사용자는 생성 후 `profiles.is_admin = true` 수동 설정 필요 (S2에서 UI화).
- 사용자 생성은 현재 Supabase 대시보드 수동 → S2에서 service_role 서버리스 함수로 자동화.
- 번들 크기 경고(three+web-ifc) → 추후 코드 스플리팅(별도 세션) 고려.

## 다음 세션 인수인계 (한 줄)
> Phase 0/1 코드 완료. 다음은 S1: 실제 Supabase 키로 연결해 로그인~모델열람을 띄우고 검증.
