# ROADMAP — MIR_VDC

목표: 브라우저만으로 IFC 모델을 열고, 4D 시공·**장비운용** 시뮬레이션, 충돌검사,
VR 검토까지. 다중 사용자가 **본인 배정 프로젝트(공구)** 만 로그인해 접근.

## 기능 단계 (Phase)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 인증 + 프로젝트별 접근권한 + 데이터 저장 | ✅ 코드 완료 (Supabase 연결 대기) |
| 1 | 3D IFC 뷰어 (탐색·선택·속성·표시제어) | ✅ 완료 |
| 2 | 4D 시공 시뮬레이션 (일정↔객체, 타임슬라이더) | ⏳ |
| 3 | 장비운용 시뮬레이션 (Rapier 물리, 강점) | ⏳ |
| 4 | 충돌 검사 (간섭 검출·리포트) | ⏳ |
| 5 | VR (WebXR) | ⏳ |

## 작업 세션 (= 대화창 = 브랜치 1개)

| # | 세션 | 브랜치(예) | 범위 | 의존 |
|---|---|---|---|---|
| S1 | Supabase 연동 & 인증 검증 | `feature/supabase-wiring` | .env 연결, 로그인→프로젝트→업로드→뷰 실동작 확인 | Phase 0 |
| S2 | 관리자 콘솔 ✅ | `feature/admin-console` | 프로젝트·사용자·멤버 관리 UI + service_role 자동가입 | S1 |
| S3 | 배포 & 빌드체크 | `feature/deploy-vercel` | Vercel 배포, 환경변수, CI | S1 |
| S4 | Phase 2 · 4D | `feature/4d-simulation` | 일정(Gantt)↔객체 매핑, 타임슬라이더 | 뷰어 |
| S5 | Phase 3 · 장비운용 | `feature/equipment-sim` | Rapier 물리, 장비 라이브러리, 경로/간섭 | S4 |
| S6 | Phase 4 · 충돌검사 | `feature/clash-detection` | 간섭 검출·리포트 | 뷰어 |
| S7 | Phase 5 · VR | `feature/webxr` | 몰입형 검토 | 뷰어 |

### 다듬기 세션 (기능 세션 사이에 끼워 진행 · 사용자 요청)

| # | 세션 | 브랜치(예) | 범위 | 의존 |
|---|---|---|---|---|
| S8 | UI 다듬기(오버플로우/반응형) | `feature/ui-polish` | 긴 텍스트 칸 넘침(모델명·프로젝트명·관리자 테이블 등), 좁은 화면 레이아웃 정리 | 뷰어/콘솔 |
| S9 | 콘솔: 로그인 아이디 변경 | `feature/admin-rename-username` | `username` + 인증 이메일 동기 변경(서버리스 액션 확장) | S2 |
| S10 | 교량 IFC 누움 보정 | `feature/ifc-georef` | 일부 교량 IFC가 누워 렌더되는 지오레퍼런싱(IfcMapConversion/TrueNorth·좌표 오프셋) 분석·수정 | 뷰어 |
| S11 | 번들 코드 스플리팅 | `feature/bundle-splitting` | three/web-ifc 동적 import·manualChunks로 빌드 경고 해소 | 빌드 |

추천 순서: **S1 → S3 → S2 → (S8 → S9 → S11 → S10) → S4 → S5 → S6 → S7**
(S1·S3·S2 완료. 사용자 요청으로 S8~S11 다듬기를 S4 4D 전에 먼저 진행.)

> 각 세션은 자기 마이그레이션을 추가하므로 서로 충돌이 적습니다.
> 세션 진행 방법은 `docs/SESSIONS.md`, 현재 상태는 `docs/STATUS.md` 참고.
