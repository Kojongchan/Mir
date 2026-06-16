# SESSIONS — 멀티세션 작업 가이드

새 대화(=세션)는 이전 대화를 기억하지 못합니다. **맥락은 이 레포가 보관**합니다.
세션마다 아래 절차를 따르세요.

## 1. 새 세션 시작 — 첫 메시지에 복붙

```
MIR_VDC 작업. 먼저 CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md 를 읽고
현재 상태를 파악해.

이번 세션: <S4 — Phase 2 4D 시공 시뮬레이션>
브랜치: <feature/4d-simulation>  (main 에서 분기)
목표: <한두 줄 — 예: 공정 일정과 IFC 객체를 매핑해 타임슬라이더로 시공 순서 재생>

끝나기 전에 docs/STATUS.md 를 갱신하고 커밋·푸시한 뒤 main 으로 PR 열어줘.
```

세션명/브랜치/목표 **3줄만** 바꿔 끼우면 됩니다. (세션 목록은 `docs/ROADMAP.md`)

## 2. 진행 중
- main 에서 `feature/<주제>` 분기해서 작업.
- 커밋 전 `npm run typecheck` 통과. 화면 변경은 `npm run build`/`dev` 로 확인.
- DB 변경은 새 마이그레이션 파일(`supabase/migrations/000N_*.sql`)로 추가.

## 3. 세션 종료 — Claude가 자동 수행
1. `docs/STATUS.md` 갱신 (한 일 / 다음 할 일 / 미해결 질문 / 인수인계 한 줄).
2. 커밋·푸시.
3. main 으로 **PR** 생성 (사용자 요청 시). 리뷰 후 병합.

## 4. 병합 후
- 다음 세션은 다시 main 에서 분기 → 항상 최신 상태에서 시작.

## 세션 목록 (요약)
S1 Supabase 연동 · S2 관리자 콘솔 · S3 배포 · S4 4D · S5 장비운용 · S6 충돌검사 · S7 VR
추천 순서: S1 → S3 → S2 → S4 → S5 → S6 → S7
