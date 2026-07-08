# ROADMAP — MIR_VDC

목표: 브라우저만으로 IFC 모델을 열고, 4D 시공·**장비운용** 시뮬레이션, 충돌검사,
VR 검토까지. 다중 사용자가 **본인 배정 프로젝트(공구)** 만 로그인해 접근.

## ⚡ 전략 전환 (S46, 2026-06) — 3D/저장소를 **APS + ACC** 로 (중요)
> **기획자 필독.** 이 전환으로 이후 기획 전제가 바뀝니다.

- **무엇을**: 3D 뷰어를 자체 엔진(ThatOpen/web-ifc) 대신 **Autodesk APS Viewer**로,
  파일 저장소를 **ACC(Autodesk Construction Cloud)** 로 전환하기 시작했다.
- **왜**: 자체 엔진으론 **텍스처·대용량(수십 GB)·rvt/nwd 네이티브**를 무료로 풀기 어려움.
  사용자가 **ACC를 이미 구독** → ACC가 자동 변환한 SVF2를 우리가 읽어 보여주면 3대 통증이
  한 번에 해결.
- **외부 사용자 = 오토데스크 계정 불필요**: 우리 서버가 **2-legged 토큰을 브로커링**하므로,
  외부인은 **MIR 로그인만** 하면 본다(ACC 좌석 미소모).
- **비용 0**: ACC 변환 결과를 읽기만 함(인증·DataManagement·SVF2 스트리밍·ACC 업로드 무료).
  유료는 *ACC 밖(우리 OSS)에서 우리가 직접 변환*할 때뿐 — **안 함**.
- **결과(S46 완료, PR #87 main 병합)**: `ACC 모델` 메뉴(`/project/:id/acc`) — 프로젝트별 ACC
  허브/프로젝트/시작폴더/기본모델 **관리자 고정**, 폴더 펼침 트리, **파일 종류별 분기**
  (모델=APS Viewer / PDF·이미지·오피스·영상=우리 뷰어), PDF 썸네일·페이지넘김.
- **남은 길**: ① 자료관리(CDE)를 **ACC 폴더로 일원화**(업로드까지 ACC로) ② 4D·간섭·이슈핀·
  물량을 **APS Viewer 위로 이식** 후 자체 IfcViewer 은퇴 ③ PPT(pptx) 뷰어 보강.
- **자체 IfcViewer/ThatOpen 경로**: 당분간 **무료·IFC 백업**으로 유지(점진 은퇴). 우리 고유
  기능(이슈·공정·물량·기성·CDE·권한)은 **Supabase 그대로**, APS 위에 얹는다.
- **운영 전제**: Vercel env `APS_CLIENT_ID`/`APS_CLIENT_SECRET`(Prod 포함) + ACC 커스텀 통합
  승인 + 마이그레이션 `0020`·`0021`. 상세 결정 근거: `docs/DECISIONS.md` **D18**.

## 기능 단계 (Phase)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 인증 + 프로젝트별 접근권한 + 데이터 저장 | ✅ 코드 완료 (Supabase 연결 대기) |
| 1 | 3D IFC 뷰어 (탐색·선택·속성·표시제어) | ✅ 완료 · **+APS Viewer(ACC) 병행 — 텍스처·대용량·rvt/nwd(S46)** |
| 2 | 4D 시공 시뮬레이션 (일정↔객체, 타임슬라이더) | ✅ 1차 완료 (S4) |
| 3 | 장비운용 시뮬레이션 (Rapier 물리, 강점) | ⏸ 기획안 최후로 연기 (S16, 사용자 결정) |
| 4 | 충돌 검사 (간섭 검출·리포트) | ✅ MVP 완료 (S32) · 보고서 S38(Word 양식) |
| 5 | VR (WebXR) | ⏳ |
| 6 | UI/UX 리뉴얼 (디자인 시스템) | ✅ 1차 화이트+네이비(S11·S12) · **2.0 토큰 디자인시스템 전면개편(U1~U4): 라이트/다크 토큰·커스텀 12아이콘·Bento 대시보드·Recharts·모바일 하단탭·a11y(axe 0)** · **모바일 마감 M1(뷰어/모듈 하단탭 겹침·모달 바텀시트·터치타깃)** |
| 7 | CDE 공통정보관리환경 (파일 저장소·버전/이력·정보구조 재편) | ✅ MVP 완료 (S14) |
| 11 | 사업관리 포털 (사업개요 대시보드 + 좌측 모듈 메뉴, PMIS형) | ✅ MVP 완료 (S21) |
| 12 | 포털 모듈 (공정현황·협업/이슈·기성내역·하도급·게시판) | ✅ 1차 완료 (S22·S23) |
| 8 | 문서·미디어 통합 뷰어 (`/view/:fileId`, 이미지·PDF·동영상·xlsx·docx) | ✅ 1단계 완료 (S13, 웹 단독) · 2단계(서버 변환) ⏳ |
| 9 | Navisworks 기능군 (측정·단면·마크업·뷰포인트·물량 등) | 🔄 자체뷰어 대부분 완료(S36·S37·S42) · **APS 측에선 표준 확장으로 다수 제공(S46)** · 남은: 속성색칠(S15) |
| 10 | 네이티브 BIM (DWG/RVT/NWD — 변환/APS) | ✅ **APS+ACC 채택·구현(S46)** — 2-legged, 외부 계정 불필요, 비용 0 (구 S17 결정 완료) |

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
| S33 | 3D 모듈 용도 분리 ✅ | (stoic-pasteur-mods) | 통합모델(3D)/공정관리(4D)/간섭검토 모델 세트 분리(models.purpose, 0016, D14) + 통합모델 이슈 핀 | S32 |
| S34 | 3D 모델 풀 공유 ✅ (S33 보정) | (share-model-pool) | 통합모델 업로드 1회 → 4D·간섭검토에도 같은 모델 표시(모듈 분리는 런타임/화면으로 유지) | S33 |
| S35 | 모듈 자동로드 + 간섭검토 UX 7건 ✅ | (clash-ux) | 진입 시 모델 자동로드·시뮬 격리·A초록/B빨강+ghost+줌·결과 창화·이슈 스냅샷 첨부·대상 2단계 선택 | S32 |
| S36 | 버그픽스 + 뷰어 리뷰도구 3종 ✅ | (clash-fix·pin-popup·visibility·measure-section) | 4D↔간섭 누수 픽스 + 이슈핀 클릭 팝업 + 모델/카테고리 표시 토글 + 📏측정·✂단면 | S32·S33 |
| S37 | 저장 뷰포인트 + 마크업(redline) ✅ | (viewpoints-markup) | 카메라·표시상태·2D 주석 저장/재호출/공유 + 뷰포인트↔이슈(0017) | 뷰어 |
| S39 | 마크업 개별 편집 + 카메라 애니메이션 ✅ | (markup-edit-animator) | 도형 선택/이동/삭제 + 저장 뷰포인트 순차 재생(워크스루). 마이그레이션 없음 | S37 |
| S40 | 간섭 결과 그룹화·정렬·필터·상태승계 ✅ | (clash-grouping) | 카테고리쌍/요소/상태 묶음 + 깊이·상태 정렬 + 상태칩 필터 + 재검사 상태승계. 마이그레이션 없음 | S32 |
| S41 | 2D 도면(PDF/DXF) + 이슈 핀 ✅ | (drawings-2d) | 도면 업로드·열람(줌/팬) + 도면 위 이슈 핀↔이슈. 0018_drawings. DWG는 S17 분리 | S7 |
| S42 | 5D 물량 산출·원가 연계 (Quantification) ✅ | `feature/quantities` | 카테고리/공종별 물량(개수·길이·면적·체적) 집계 + IFC 단위 정규화 → 기성내역(0011) 행 제안 (§12). 마이그레이션 없음 | 뷰어·S23 |
| S43 | CDE 고도화 (승인 워크플로우·자료전송) | `feature/cde-workflow` | 상태 승인 단계 + transmittal(정식 송부) + 검색/태그 (§13) | S14 |
| S38 | 간섭 보고서 — 사용자 Word 양식(D15) | `feature/clash-report` | docxtemplater 로 .docx 양식 채우기(표 반복·요약·스냅샷) | S32 (양식 대기) |
| S44 | 통합모델(3D) 뷰 환경·탐색 UX ✅ | (youthful-meitner) | 시작카메라·홈뷰·좌표HUD·격자/원점·이슈핀 비주얼·트리정리 + 좌표/Y-up 보정 | 뷰어 |
| S45 | 뷰어 고급기능 + CDE↔BIM 연동 ✅ | (cde-bim·viewer-adv) | 스냅·측정확장·공간트리·버전diff·CDE BIM폴더↔통합모델 미러·버전전환/중첩(0019) | S44 |
| **S46** | **APS/ACC 뷰어 전환 ✅ (PR #87)** | `feature/aps-viewer` | **APS Viewer 임베드 + ACC 2-legged 탐색·고정(0020·0021) + 파일 종류별 분기(모델=APS/문서=우리뷰어) + PDF 썸네일.** 위 '전략 전환' 참조 | S45 |
| **S47** | 자료관리 ACC 일원화(업로드까지) ✅ | (funny-bardeen) | ACC 쓰기=2-legged(D19) + Supabase 읽기 공존. 0022. **미병합** | S46 |
| **S48** | 4단계 RBAC + ACC 단독 파일관리자 ✅ | (funny-bardeen) | 뷰어/실무자/관리자/시스템관리자(0023·D20) + ACC식 파일관리자 UI(이름변경·삭제·이동·버전·다운로드). **미병합** | S47 |
| **선결** | **S47/S48 main 병합** ✅ | PR #89(`5de0d40`) | 두 트랙(A·B) 분기 전제. FF 병합·CI 통과 | S48 |
| **S49** | 🅰 매핑 레이어 + 4D/간섭 ACC 소스화 + 이슈핀 이식 | `feature/aps-mapping-pins` | dbId↔GlobalId↔expressID(apsMapping.ts) + **신규 BIM 업로드 경로 부재 해소** + 이슈핀 3D 앵커. 0024. **급소** | S48 |
| S50 | 🅰 4D APS 이식 | `feature/aps-4d` | 일정↔GlobalId, themingColor/표시제어 타임라인 | S49 |
| S51 | 🅰 물량(QTO) APS 이식 | `feature/aps-qto` | APS 속성DB 추출 또는 IFC 병행 | S49 |
| S52 | 🅰 간섭 스파이크 → 이식 | `feature/aps-clash` | Model Coordination vs fragment+BVH 택1 | S49 |
| S53 | 🅰 IfcViewer 은퇴 + IA 통합 | `feature/retire-ifcviewer` | 통합모델=ACC 모델. 패리티 증명 후 | S49~S52 |
| B1 | 🅱 모듈별 canEdit 게이팅 점검·보강 ✅ | (affectionate-babbage) | is_admin→useProjectRole().canEdit (이슈·공정·일보·기성·하도급·게시판·도면). Quantities는 A S51로 인계. 마이그레이션 없음 | S48 |
| B2 | 🅱 프로젝트 관리자 역할 배정 권한 ✅ | (S48 완료) | ProjectMembers=canManage 게이팅 + RLS members_*=is_project_admin. S48 9a2166c에서 이미 구현(추가작업 없음) | S48 |
| B3 | 🅱 ACC 파일관리자 보강 + 라이브 검증 ✅ | (affectionate-babbage) | '새 버전 올리기' UI(⋮·버전모달). 이동·버전이력 기존 유지. 실 PUT/CORS는 운영 라이브검증 인계 | S48 |
| B4 | 🅱 비-3D 뷰어 quick wins ✅ | (affectionate-babbage) | pptx 뷰어(pptx-preview) 추가. PDF 페이지 네비는 기존 완비 | S46 |
| U1~U4 | Ⓤ 디자인시스템 2.0 (Phase 6 개편) ✅ | (design-system-phase-1) | 토큰(라이트/다크)·공통컴포넌트·셸 라이트전환·커스텀 12+3 아이콘·Bento 대시보드·Recharts·모바일 하단탭·모션·a11y(axe 0)·코드스플리팅(5MB→93kB) (PR #105~#107) | S11 |
| M1 | Ⓤ 모바일 실사용 마감 ✅ | `claude/mobile-version-update-v810fd` | 뷰어/전체화면 모듈 하단탭 겹침 해소·뷰어 툴바 가로스크롤·모달 바텀시트·터치타깃/폼 16px (전부 <640 스코프) | U4 |

추천 순서(전환 후): **S46·S47·S48 ✅ → [선결] S47/S48 main 병합 → 두 트랙 병렬**:
**🅰 직렬(이어서)** S49(매핑+ACC소스+이슈핀) → S50(4D) → S51(물량) → S52(간섭 스파이크) → S53(은퇴) ·
**🅱 분리(2nd 계정)** B1(게이팅)·B2(역할배정)·B3(ACC관리자)·B4(quick wins).
이후 S43(CDE 고도화는 ACC 통합) · S38(간섭 보고서) · S15(속성색칠) → VR → S16 장비(최후).
> 트랙 분리·충돌 회피 규칙·열린 결정은 **PLANNING §0-B** 참조. A=0024~ / B=0030~ 마이그레이션 사전 배정.
> **자체 IfcViewer = 점진 이식·병행**(사용자 결정): APS 패리티 증명 전 은퇴 금지, IFC 백업 유지.
> **세션 묶음 메모**: S14(CDE)에서 시작한 작업 브랜치(`claude/busy-lovelace-cj8adq`)가
> PMIS 포털 전반(S21~S29)으로 확장됨. CDE/포털 1차 마무리. 다음 후보는 PLANNING 백로그 참조.
> **세션번호 메모**: main 이 S12 를 브랜딩으로 선점 → 초기 기획의 S12(CDE)는 **S14** 로 이동.

> 각 세션은 자기 마이그레이션을 추가하므로 서로 충돌이 적습니다.
> 세션 진행 방법은 `docs/SESSIONS.md`, 현재 상태는 `docs/STATUS.md` 참고.
