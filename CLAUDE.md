# CLAUDE.md — MIR_VDC

웹 기반 BIM 시각화 · 4D/장비운용 시뮬레이션 협업 플랫폼 (Fuzor 유사). 이 파일은
모든 세션이 자동으로 읽습니다. **이 레포가 세션 간 기억장치입니다.**

## 세션 시작 시 (필수)
1. `docs/STATUS.md` 를 먼저 읽어 현재 상태·다음 할 일·미해결 질문을 파악한다.
2. `docs/ROADMAP.md` 로 전체 계획과 이번 세션 위치를 확인한다.
3. 확정된 설계는 `docs/DECISIONS.md` 를 따른다 (임의로 뒤집지 않는다).

## 세션 종료 시 (필수)
1. `docs/STATUS.md` 갱신: **한 일 / 다음 할 일 / 미해결 질문 / 다음 세션 인수인계 한 줄**.
2. 의미 단위로 커밋하고 현재 작업 브랜치에 푸시한다.
3. 작업이 끝난 기능 브랜치는 `main` 으로 PR을 연다 (사용자가 요청할 때).

## 브랜치 전략
- `main` = 통합 브랜치(안정). 직접 커밋 금지.
- 세션마다 `feature/<주제>` 브랜치를 **main에서 분기** → 작업 → **PR로 main 병합**.

## 명령어
```bash
npm install        # SessionStart 훅이 자동 실행 (웹 세션)
npm run dev        # 개발 서버 http://localhost:5173
npm run build      # 프로덕션 빌드 (= 검증)
npm run typecheck  # 타입체크 (= 린트 역할, 커밋 전 통과 필수)
```

## 스택 / 구조
- Vite + React + TypeScript + react-router / Three.js + web-ifc / Supabase / Zustand
- `src/viewer/` 3D·IFC 엔진 · `src/auth/` 인증 · `src/lib/` supabase·api · `src/pages/` 화면
- `supabase/migrations/` DB 스키마(추가형: `0002_`, `0003_` …)

## 규칙
- **비밀키·.env 절대 커밋 금지** (`service_role` 키는 프론트엔드에 절대 X).
- DB 스키마 변경은 새 마이그레이션 파일로 추가 (기존 파일 수정 X).
- 커밋·PR 본문에 모델 식별자/내부 정보 넣지 않기.
- 작업 범위를 벗어나는 대규모 리팩터링은 먼저 사용자에게 확인.
