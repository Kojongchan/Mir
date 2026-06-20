# ROADMAP — MIR_VDC

목표: 브라우저만으로 IFC 모델을 열고, 4D 시공·**장비운용** 시뮬레이션, 충돌검사,
VR 검토까지. 다중 사용자가 **본인 배정 프로젝트(공구)** 만 로그인해 접근.

## 기능 단계 (Phase)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 인증 + 프로젝트별 접근권한 + 데이터 저장 | ✅ 코드 완료 (Supabase 연결 대기) |
| 1 | 3D IFC 뷰어 (탐색·선택·속성·표시제어) | ✅ 완료 |
| 2 | 4D 시공 시뮬레이션 (일정↔객체, 타임슬라이더) | ✅ 1차 완료 (S4) |
| 3 | 장비운용 시뮬레이션 (Rapier 물리, 강점) | ⏸ 기획안 최후로 연기 (S16, 사용자 결정) |
| 4 | 충돌 검사 (간섭 검출·리포트) | ✅ MVP 완료 (S32) · 보고서 S38(Word 양식) |
| 5 | VR (WebXR) | ⏳ |
| 6 | UI/UX 리뉴얼 (화이트+네이비 디자인 시스템) | ✅ 완료 (S11·S12) |
| 7 | CDE 공통정보관리환경 (파일 저장소·버전/이력·정보구조 재편) | ✅ MVP 완료 (S14) |
| 11 | 사업관리 포털 (사업개요 대시보드 + 좌측 모듈 메뉴, PMIS형) | ✅ MVP 완료 (S21) |
| 12 | 포털 모듈 (공정현황·협업/이슈·기성내역·하도급·게시판) | ✅ 1차 완료 (S22·S23) |
| 8 | 문서·미디어 통합 뷰어 (`/view/:fileId`, 이미지·PDF·동영상·xlsx·docx) | ✅ 1단계 완료 (S13, 웹 단독) · 2단계(서버 변환) ⏳ |
| 9 | Navisworks 기능군 (측정·단면·마크업·뷰포인트 등) | 🔄 대부분 완료 (측정·단면 S36 · 마크업·뷰포인트 S37) · 남은: 물량·속성색칠 (S15) |
| 10 | 네이티브 BIM 업로드 (DWG/RVT/NWD — 변환/APS) | 🧭 기획 (S17, 결정대기) |

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
| S11 | Phase 6 · UI 리뉴얼 ✅ | `feature/ui-refresh` | 화이트+네이비 디자인 토큰·리스킨·다크토글 | — |
| S12 | 브랜딩(MIR SMART) ✅ | (branding-rename) | 제품명/로고/쌍용 CI/로그인 홈 | S11 |
| S13 | Phase 8 · 문서/미디어 뷰어 ✅ | `feature/doc-viewers` | 새 탭 뷰어(이미지·PDF·동영상·xlsx·docx) 1단계 완료(PR #22) | S12 |
| S14 | Phase 7 · CDE 토대 ✅ | `feature/cde-foundation` | 자료 관리(`/docs`): 폴더트리·다중 버전·상태(WIP/Shared/Published/Archived)·활동로그 (MVP 완료) | S13 |
| S15 | Phase 9 · Navisworks 기능군 | `feature/nw-features` | 측정·단면·마크업·뷰포인트 (입력대기) | 뷰어 |
| S16 | Phase 3 · 장비운용 ⏸ 최후로 연기 | `feature/equipment-sim` | Rapier 물리·장비·경로/간섭 (이미지대기, 사용자 결정으로 맨 마지막) | S4 |
| S17 | Phase 10 · 네이티브 BIM | `feature/native-bim` | DWG/RVT/NWD 업로드·변환(APS 평가) | S14 |
| S18 | 성능 최적화 · 코드 스플리팅 | `feature/code-splitting` | 번들 분할(청크 경고). S13 에서 뷰어 lazy 분리로 일부 선반영 | — |
| S19 | 뷰어 충실도 · 단기(무료 클라) | `feature/viewer-fidelity` | Word `mammoth`→`docx-preview`, 엑셀 서식 개선 (D10) | S13 |
| S20 | 뷰어 충실도 · 장기(서버 변환) | `feature/doc-convert` | PPT/HWP/구포맷→PDF 헤드리스 변환(LibreOffice/Gotenberg) (D10) | S13 |
| S21 | 사업관리 포털 · 사업개요 대시보드 ✅ | `feature/pmis-portal` | 좌측 모듈 메뉴 + 대시보드(마일스톤 D-day·진행률·공사일지/기성 차트·인력/장비) + 공사일보. 데이터 앱 내 입력(0006) | S14 |
| S22 | 포털 모듈 · 공정현황 + 협업/이슈 ✅ | `feature/portal-modules` | 공정현황(마일스톤 타임라인·S-curve·4D 링크) + 이슈/지적 트래커(0007) | S21 |
| S23 | 포털 모듈 · 기성·하도급·게시판 ✅ | `feature/portal-modules` | 기성내역(도급액·기성률) + 하도급내역 + 게시판(0008). 포털 메뉴 1차 완성 | S22 |
| S24 | 권한 · 쓰기 admin 전용 ✅ | (busy-lovelace) | 포털/CDE/업로드 INSERT/UPDATE/DELETE 를 is_admin() 로(0009·D11). 멤버 읽기전용 | S23 |
| S25 | 셸 통합 레이아웃 ✅ | (busy-lovelace) | 모델뷰어·자료관리·구성원을 셸 안으로(좌측 레일 유지 + 2차 트리) | S21 |
| S26 | 첨부파일(사진/문서) ✅ | (busy-lovelace) | 공사일보·게시판·이슈 첨부(0010) + 뷰어 ResizeObserver | S23 |
| S27 | 피드백 1~5 ✅ | (busy-lovelace) | 메뉴명 공정관리(4D)·자료관리 인라인 뷰어·공정현황 입력·기성 공종별(0011)·4D 무클릭 영속화 | S21~26 |
| S28 | 사용자 생성/변경 무한대기 버그픽스 ✅ | `fix/admin-user-create-hang` | `api/admin.ts` Edge 런타임 전환 + 타임아웃 | S2 |
| S29 | 마일스톤 정렬 + 이슈↔3D 핀 ✅ | (busy-lovelace) | 마일스톤 드래그 정렬 + 이슈에 3D 객체 연결/위치보기(0012) | S22 |
| S30 | 이슈 워크플로우 ✅ | `feature/issue-workflow` | 상태 전이·담당자 배정·마감임박·인앱 알림(0013) | S22 |
| S31 | 문서 삭제 권한 완화(D12) ✅ | `feature/doc-delete-owner` | files/storage 삭제 정책을 업로더 본인+관리자로(0014) | S14 |
| S32 | Phase 4 · 충돌검사 ✅ | `feature/clash-detection` | IFC 간섭검출(three-mesh-bvh, D13)·결과패널·간섭→이슈(0015) | 뷰어·S30 |
| S33 | 3D 모듈 용도 분리 ✅ | (stoic-pasteur-mods) | 통합모델(3D)/공정관리(4D)/간섭체크 모델 세트 분리(models.purpose, 0016, D14) + 통합모델 이슈 핀 | S32 |
| S34 | 3D 모델 풀 공유 ✅ (S33 보정) | (share-model-pool) | 통합모델 업로드 1회 → 4D·간섭체크에도 같은 모델 표시(모듈 분리는 런타임/화면으로 유지) | S33 |
| S35 | 모듈 자동로드 + 간섭체크 UX 7건 ✅ | (clash-ux) | 진입 시 모델 자동로드·시뮬 격리·A초록/B빨강+ghost+줌·결과 창화·이슈 스냅샷 첨부·대상 2단계 선택 | S32 |
| S36 | 버그픽스 + 뷰어 리뷰도구 3종 ✅ | (clash-fix·pin-popup·visibility·measure-section) | 4D↔간섭 누수 픽스 + 이슈핀 클릭 팝업 + 모델/카테고리 표시 토글 + 📏측정·✂단면 | S32·S33 |
| S37 | 저장 뷰포인트 + 마크업(redline) ✅ | (viewpoints-markup) | 카메라·표시상태·2D 주석 저장/재호출/공유 + 뷰포인트↔이슈(0017) | 뷰어 |
| S39 | 마크업 개별 편집 + 카메라 애니메이션 ✅ | (markup-edit-animator) | 도형 선택/이동/삭제 + 저장 뷰포인트 순차 재생(워크스루). 마이그레이션 없음 | S37 |
| S40 | 간섭 결과 그룹화·정렬·필터·상태승계 ✅ | (clash-grouping) | 카테고리쌍/요소/상태 묶음 + 깊이·상태 정렬 + 상태칩 필터 + 재검사 상태승계. 마이그레이션 없음 | S32 |
| S38 | 간섭 보고서 — 사용자 Word 양식(D15) | `feature/clash-report` | docxtemplater 로 .docx 양식 채우기(표 반복·요약·스냅샷) | S32 (양식 대기) |

추천 순서: **… S34~S37 ✅ → 다음 S38(간섭 보고서, 양식 도착 시) → 백로그(§9) → S15(Navisworks 잔여)·S17 → S16 장비(최후)**
> **세션 묶음 메모**: S14(CDE)에서 시작한 작업 브랜치(`claude/busy-lovelace-cj8adq`)가
> PMIS 포털 전반(S21~S29)으로 확장됨. CDE/포털 1차 마무리. 다음 후보는 PLANNING 백로그 참조.
> **세션번호 메모**: main 이 S12 를 브랜딩으로 선점 → 초기 기획의 S12(CDE)는 **S14** 로 이동.

> 각 세션은 자기 마이그레이션을 추가하므로 서로 충돌이 적습니다.
> 세션 진행 방법은 `docs/SESSIONS.md`, 현재 상태는 `docs/STATUS.md` 참고.
