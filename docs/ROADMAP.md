# ROADMAP — MIR_VDC

목표: 브라우저만으로 IFC 모델을 열고, 4D 시공·**장비운용** 시뮬레이션, 충돌검사,
VR 검토까지. 다중 사용자가 **본인 배정 프로젝트(공구)** 만 로그인해 접근.

## 기능 단계 (Phase)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 인증 + 프로젝트별 접근권한 + 데이터 저장 | ✅ 코드 완료 (Supabase 연결 대기) |
| 1 | 3D IFC 뷰어 (탐색·선택·속성·표시제어) | ✅ 완료 |
| 2 | 4D 시공 시뮬레이션 (일정↔객체, 타임슬라이더) | ✅ 1차 완료 (S4) |
| 3 | 장비운용 시뮬레이션 (Rapier 물리, 강점) | ⏳ (S15) |
| 4 | 충돌 검사 (간섭 검출·리포트) | ⏳ |
| 5 | VR (WebXR) | ⏳ |
| 6 | UI/UX 리뉴얼 (화이트+네이비 디자인 시스템) | 🧭 기획 (S11) |
| 7 | CDE 공통정보관리환경 (파일 저장소·버전/이력·정보구조 재편) | 🧭 기획 (S12) |
| 8 | 문서·미디어 통합 뷰어 (PDF/이미지/영상/오피스/HWP, 새 탭) | 🧭 기획 (S13) |
| 9 | Navisworks 기능군 (측정·단면·마크업·뷰포인트 등) | 🧭 기획 (S14, 입력대기) |
| 10 | 네이티브 BIM 업로드 (DWG/RVT/NWD — 변환/APS) | 🧭 기획 (S16, 결정대기) |

> Phase 6~10 의 상세 기획·가능여부·전략은 **`docs/PLANNING.md`(기획창)** 참조.

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
| S11 | Phase 6 · UI 리뉴얼 | `feature/ui-refresh` | 화이트+네이비 디자인 토큰·리스킨 | — |
| S12 | Phase 7 · CDE 토대 | `feature/cde-foundation` | 좌측 정보구조 재편 + 파일 저장소(버전/이력) | S11 |
| S13 | Phase 8 · 문서/미디어 뷰어 | `feature/doc-viewers` | PDF/이미지/영상/오피스/HWP 새 탭 뷰어 | S12 |
| S14 | Phase 9 · Navisworks 기능군 | `feature/nw-features` | 측정·단면·마크업·뷰포인트 (입력대기) | 뷰어 |
| S15 | Phase 3 · 장비운용 | `feature/equipment-sim` | Rapier 물리·장비·경로/간섭 (이미지대기) | S4 |
| S16 | Phase 10 · 네이티브 BIM | `feature/native-bim` | DWG/RVT/NWD 업로드·변환(APS 평가) | S12 |

추천 순서: **S1 → S3 → S2 → S4 → (확장) S11 → S12 → S13 → S14/S15 → S16**
(확장 단계 S11~S16 의 상세는 `docs/PLANNING.md`. S14/S15 는 사용자 입력 도착 시, S16 은 전략 결정 후 착수.)

> 각 세션은 자기 마이그레이션을 추가하므로 서로 충돌이 적습니다.
> 세션 진행 방법은 `docs/SESSIONS.md`, 현재 상태는 `docs/STATUS.md` 참고.
