# PLANNING — MIR_VDC 확장 기획창

> **이 문서는 "기획창"입니다.** S4(4D) 이후의 플랫폼 확장 방향을 한곳에 모읍니다.
> 아이디어 → 가능여부 판단 → 세션(브랜치)으로 분해 → `ROADMAP.md`/`STATUS.md` 반영.
> 새 세션은 `STATUS.md` 다음으로 이 문서를 읽고 어떤 확장 항목을 진행할지 고릅니다.

**레퍼런스 제품**: Autodesk Forma / Autodesk Docs(구 BIM 360) / Navisworks / Fuzor.
사용자가 공유한 화면(Forma Data Management 폴더트리 + 통합모델 뷰어)을 UI/정보구조의
북극성으로 삼는다.

상태 범례: 🟢 가능(웹 단독) · 🟡 부분/조건부(서버·외부 API 필요) · 🔴 어려움(전략 결정 필요)
· ⏳ 사용자 입력 대기

---

## ⚡ 0-A. 전략 전환 (S46, 2026-06) — 3D/저장소 = APS + ACC  ★기획 전제 변경★
> 기존 "web-ifc 자체 뷰어" 전제 위에 **Autodesk APS Viewer + ACC** 가 올라왔다.
> 자세한 배경·완료 범위는 `ROADMAP.md` 상단 '전략 전환' + `DECISIONS.md` D18.

- **이유**: 자체 엔진으론 텍스처·대용량·rvt/nwd 네이티브가 어렵다. 사용자가 **ACC 구독 보유** →
  ACC 변환 SVF2를 우리가 읽어 보여줌. **외부인은 오토데스크 계정 불필요(우리 서버가 토큰 브로커),
  비용 0(ACC 구독 재사용)**.
- **완료(S46, PR #87)**: `ACC 모델` 메뉴 — 프로젝트별 ACC 고정·폴더 트리·파일 종류별 분기
  (모델=APS Viewer / 문서=우리 뷰어).
- **앞으로 기획 시 전제**:
  - 무거운 모델/도면(rvt·nwd·dwg) = **APS**, 문서·PDF·미디어 = **우리 뷰어**.
  - 파일 저장소는 **ACC로 일원화** 방향(자료관리=ACC 폴더, 업로드도 ACC). 동기화 불필요.
  - 우리 고유 가치(4D·간섭·물량·이슈·기성·CDE·권한)는 **Supabase 유지**, APS 위에 이식/연계.
  - web-ifc 자체 뷰어는 **무료·IFC 백업**으로 점진 은퇴.
- **다음 기획 후보**: ① 자료관리 ACC 일원화(업로드 포함) ② 4D·간섭·이슈핀·물량 APS 이식
  ③ PPT(pptx) 뷰어 ④ 상단 PDF 페이지네비 등 ACC 앱 UI 보강.

## ⚡ 0-B. 전환 후 실행 로드맵 — 직렬(이어서) vs 병렬(분리) ★기획자 확정★
> S47(ACC 저장소 일원화)·S48(4단계 RBAC + ACC 단독 파일관리자)이 **완료**(branch
> `claude/funny-bardeen-d9s1af`, **아직 main 미병합**). 남은 일을 **두 트랙**으로 나눈다.
> 사용자가 **토큰 사용량 분산을 위해 별도 GitHub 계정/세션을 병렬 가동**하려 하므로,
> **서로 파일이 겹치지 않는** 단위로 분리한다.

### ⛓ 선결 (두 트랙 시작 전 1회)
- **S47/S48을 main에 병합**한다. 두 트랙 모두 이 위에서 분기해야 충돌이 없다(지금 main은
  S46까지라, 병합 없이 병렬 분기하면 RBAC·ACC 저장소가 없어 양쪽 모두 깨짐).
- **마이그레이션 번호 사전 배정**(추가형이라 번호만 안 겹치면 충돌 X): **Track A=0024~**,
  **Track B=0030~**.

### ⚠️ 회귀(둘 다 인지) — 신규 BIM 업로드 경로 일시 부재
S48에서 자료관리가 ACC 단독이 되며 **Supabase BIM(IFC) 업로드 UI가 제거**됨 → 4D·간섭용
**신규 모델 등록 경로가 현재 없음**(기존 모델은 동작). 이를 **Track A의 첫 작업(S49)에서
"4D·간섭 BIM 소스를 ACC로" 전환**하며 정식 해소한다(임시 복원은 throwaway라 지양).

### 🅰 Track A — "이어서 해야 하는 것"(직렬·메인 세션): ACC 모델 위로 고유기능 이식
> 모두 **APS Viewer + Workspace + 매핑 레이어**를 공유 → **서로 의존**하므로 한 세션이 직렬로.
> 급소: APS는 `dbId`, 우리는 `expressID`/`GlobalId` → **S49에서 매핑 레이어를 먼저** 깔고 재사용.

| 세션 | 범위 | 의존 | 마이그레이션 |
|---|---|---|---|
| **S49** | **dbId↔GlobalId↔expressID 매핑 레이어**(`src/viewer/apsMapping.ts`) + **4D·간섭의 BIM 소스를 ACC로**(신규 업로드 경로 부재 해소) + **이슈 핀 APS 이식** | S46/S48 | 0024(issues.global_id) |
| S50 | **4D APS 이식**: 일정↔GlobalId, `setThemingColor`/`hide·show`로 타임라인 색·표시 | S49 | — |
| S51 | **물량(QTO) APS 이식**: APS 속성DB(`getProperties`) 추출 또는 IFC 병행 산출 | S49 | — |
| S52 | **간섭 스파이크 → 이식**: (A) ACC Model Coordination 결과 읽기 / (B) fragment 지오 추출+three-mesh-bvh 택1 | S49 | 미정 |
| S53 | **IfcViewer 은퇴 + IA 통합**(통합모델=ACC 모델) — S49~S52 패리티 증명 후에만 | S49~S52 | 정리형 |

### 🅱 Track B — "분리해서 할 수 있는 것"(병렬·2nd 계정): 권한·관리·문서뷰어
> 포털 페이지 / Admin / AccBrowser / 문서뷰어만 건드림 → **Track A의 3D 뷰어 코드와 파일이
> 분리**되어 병렬 가능. 항목들끼리도 대체로 독립.

| 세션 | 범위 | 주요 파일(겹침 적음) | 마이그레이션 |
|---|---|---|---|
| **B1** | **모듈별 `canEdit` 게이팅 점검·보강**(이슈·공정·기성·게시판·일보 등 — 뷰어/실무자 구분 누락 없는지) | 포털 페이지들 + `useProjectRole` | 없음 |
| B2 | **프로젝트 관리자도 역할 배정 가능**(현재 구성원 화면=시스템관리자 전용) | `Admin.tsx` + RLS | 0030(role 부여 정책 완화) |
| B3 | **ACC 파일관리자 보강**: 이동(move)·새 버전 업로드 UI + **라이브 검증**(폴더 쓰기권한 후 실제 PUT/CORS/item) | `AccBrowser.tsx`·`api/aps-*`·`lib/aps.ts` | 없음 |
| B4 | **비-3D 뷰어 quick wins**: pptx 뷰어 + PDF 상단 페이지 네비 | 문서 뷰어 컴포넌트 | 없음 |

### 🚧 병렬 충돌 회피 규칙 (양쪽 세션 필독)
- **파일 분리**: A=`IfcViewer.ts`·`Workspace.tsx`·`apsMapping.ts`·`AccModels.tsx`(뷰어) /
  B=`Admin.tsx`·포털 페이지·`AccBrowser.tsx`·문서뷰어. 교차 거의 없음.
- **공유 위험 파일**: `useProjectRole.ts`(B 주도, A는 읽기만) · `lib/aps.ts`(B3 주도) ·
  `index.css`(섹션 분리해 추가) · **`STATUS.md`/`ROADMAP.md`(양쪽 수정 → 각자 자기 섹션만,
  사소한 머지 충돌은 감수)**.
- **마이그레이션**: A=0024~, B=0030~ (번호 사전 배정, 기존 파일 수정 금지).
- **병합 리듬**: 작은 Track B부터 자주 main 병합 → Track A는 수시로 main rebase로 따라가기.

### 열린 결정(기획자 추적)
1. **간섭 방식**(S52): Model Coordination vs fragment+BVH(스파이크 후).
2. **ACC 미보유 프로젝트**: 병행 결정상 IFC 백업 경로 유지(모든 프로젝트 ACC 강제 보류).
3. **S43 CDE 고도화**(승인·transmittal·검색)는 ACC 메타(0022) 위에서 재설계 — S47과 통합 검토.

## ⚡ 0-C. S52 완료 현황 + 다음 개발 스텝 (2026-06-29) ★현재 위치★

### ✅ S49~S52 까지 이식 완료(🅰 Track A)
- **통합모델(3D)·공정관리(4D)·간섭검토 = 모두 APS(ACC) 뷰어**로 통일. 구 IFC 뷰어
  (`Workspace`)와 `ACC 모델` 단독 메뉴 제거(라우트 해제, 파일은 백업 보존).
- **세 메뉴 완전 독립**: 각자 전용 고정 모델(`acc_default`/`acc_4d`/`acc_clash`, 0030·0031)을
  자료관리 ACC 모델 또는 각 뷰 ⭐ 버튼에서 지정. 라우트별 `key` 로 인스턴스 분리(연동 버그 해결).
- **고유기능 APS 이식**: 이슈 핀(S49)·4D 시뮬 isolate/도색(S50)·간섭(S49)·홈뷰/관측점(S52).
- **공통 레이아웃 픽스**: `.portal-main` grid 자식 `min-width:0` — 표/차트 넓은 모듈
  (물량·도면·일보·이슈·기성·하도급·게시판)이 뷰포트 밖으로 삐져나가던 문제 해결.

### 🔜 다음 개발 스텝(우선순위 제안)
1. **S53 IfcViewer 은퇴 마무리(IA 통합)** — 통합모델=ACC 단일 경로 확정. 남은 IFC 전용
   기능(측정·단면·마크업) 중 실사용분을 APS 표준확장으로 매핑하거나 보류 정리. 죽은 코드
   (`Workspace.tsx`·`IfcViewer.ts` 등) 의존성 점검 후 단계적 제거(패리티 확인 전 삭제 금지).
2. **관측점·홈뷰 팀 공유(DB 이관)** — 현재 localStorage(브라우저 로컬) → `viewpoints` 테이블에
   APS state 컬럼 추가(추가형 마이그레이션)로 팀 공유·썸네일 영속화. 이슈 연동까지.
3. **S51 물량(QTO) APS 이식** — APS 속성DB(getBulkProperties2/Model Properties API)로 개수·
   길이·면적·체적 집계 → 기성내역 행 제안. IFC QTO 병행 정리.
4. **간섭 검토 본이식(S52 본체)** — 현재 GlobalId 기반 결과/핀은 동작. APS Model Coordination
   API 연동 또는 fragment+BVH 스파이크 중 택1로 "검출"까지 APS 위에서. (열린 결정 #1)
5. **S43 CDE 고도화** — 승인 워크플로우·transmittal·검색/태그를 ACC 메타(0022) 위 재설계.
6. **품질/UX 잔여** — 비-3D 모듈 반응형 추가 점검(좁은 폭 표 가로 스크롤 일관화), 번들
   코드스플리팅(S18, 청크 5MB 경고), 도면 목록 "Invalid Date" 표기 버그.

> 마이그레이션 사전 배정: 다음 추가 컬럼/테이블은 `0032_` 이후로(관측점 DB 이관 등).

## 0. 현재 위치 (요약)
- ✅ Phase 0 인증/권한(RLS)/저장 · Phase 1 3D IFC 뷰어 · Phase 2 4D 시뮬레이션(S4).
- 스택: Vite+React+TS / Three.js + web-ifc(WASM) **+ APS Viewer/ACC(S46)** / Supabase / Vercel.
- 뷰어는 **web-ifc 직접 사용**(D2) → 요소(expressID) 단위 정밀 제어가 4D/장비 시뮬의 핵심.
  (S46 이후 무거운 모델은 APS로 분담, 자체 뷰어는 IFC 백업.)

---

## 1. UI/UX 리뉴얼 — "세련되게, 화이트+네이비" (Phase 6 / S11·S12) ✅ 완료
> **상태**: S11(디자인 토큰·다크토글·Pretendard·리스킨) + S12(브랜딩 MIR SMART·쌍용 CI)
> 로 완료. 설계는 `docs/DESIGN.md`. 아래는 당시 제안 기록(보존).
**문제**: 현재 테마가 어두운 차콜/네이비(`--bg:#1e2430`) 단색이라 칙칙함.

**제안(권장): 라이트 베이스 + 네이비 구조색 + 단일 강조색**. Forma 화면처럼
흰 배경에 네이비 사이드바/헤더, 밝은 블루 강조. 디자인 토큰을 도입해 다크모드도 토글 가능.

### 제안 디자인 토큰 (초안)
| 역할 | 라이트(기본) | 비고 |
|---|---|---|
| `--bg` (캔버스) | `#F4F6FA` | 살짝 푸른 회색 |
| `--surface` (카드/패널) | `#FFFFFF` | |
| `--surface-2` | `#EEF2F8` | 서브 패널·hover |
| `--nav` (사이드바/헤더) | `#0F1E3D`(네이비) | 텍스트는 흰색 |
| `--primary` (강조/버튼) | `#2563EB`(블루) | 링크·주요 액션 |
| `--text` | `#1B2333` | |
| `--muted` | `#5B6B85` | |
| `--border` | `#D8E0EC` | |
| `--success/warn/danger` | `#16A34A / #D97706 / #DC2626` | 4D 상태색과 일관 |

- **폰트**: 한글 가독성 위해 **Pretendard**(또는 Noto Sans KR) + 숫자/영문 system-ui.
- **컴포넌트 원칙**: 8px 그리드, 라운드 8px, 옅은 그림자 1단계, 아이콘 라인스타일.
- **밀도**: BIM 툴 특성상 정보 밀도 높게(행 높이 32~36px), 그러나 여백·구분선으로 정돈.
- **다크모드**: 토큰만 교체(`[data-theme="dark"]`). 기존 다크값을 다크 프리셋으로 보존.

**작업 범위(S11)**: `src/index.css` 토큰화 → 라이트 기본 적용 → 로그인/프로젝트선택/
워크스페이스/관리자/타임라인 순차 리스킨. **기능 변경 없이 표현만**(S8과 동일 원칙).
디자인 시스템 문서는 `docs/DESIGN.md`로 분리(S11에서 생성).

---

## 2. (예약)
> 사용자가 비워둔 항목. 추후 채움.

---

## 3. 문서·미디어 뷰어 (새 탭으로 열기) (Phase 8 / S13) ✅ 1단계 완료(PR #22) · 품질개선 S19/S20
> **상태**: 1단계(웹 단독) **완료**(PR #22 병합) — 라우트 `/view/:fileId`, PDF.js·SheetJS·
> mammoth·native img/video, 다운로드 폴백, `0004_files.sql`(`files` 테이블 + `docs` 버킷).
> **품질 평가(라이브)**: PDF·이미지·동영상은 우수, **Word/Excel 충실도 보통, PPT/HWP 미지원
> (다운로드)**. → 충실도 개선 결정 **D10**(아래).
**목표**: 저장소의 파일을 클릭하면 **새 탭/라우트(`/view/:fileId`)** 에서 미리보기.

### 포맷별 가능여부
| 포맷 | 가능 | 방식 | 메모 |
|---|---|---|---|
| 이미지 jpg/png/webp/gif | 🟢 | 네이티브 `<img>` | 즉시 |
| PDF | 🟢 | **PDF.js**(클라이언트) | 표준, 텍스트/검색 지원 |
| 동영상 mp4(H.264)/webm | 🟢 | 네이티브 `<video>` | 가장 흔한 케이스 커버 |
| 동영상 avi/mov/mkv/wmv | 🟡 | **서버 트랜스코딩(ffmpeg)** → mp4 | 브라우저가 코덱 미지원, 변환 필요 |
| Excel xlsx/xls | 🟢 | **SheetJS(xlsx)** → HTML 표 | 읽기전용 그리드, 수식 결과값 |
| Word docx | 🟢 | **mammoth.js**(docx→HTML) | 텍스트 충실, 복잡 레이아웃 일부 손실 |
| Word doc(구 바이너리) | 🟡 | 서버 변환(LibreOffice) | 클라 라이브러리 빈약 |
| PowerPoint pptx | 🟡 | 서버 변환→PDF/이미지 권장 | 클라 렌더러 품질 낮음 |
| 한글 hwp/hwpx | 🟡 | hwpx는 XML(파싱 쉬움), hwp5는 `hwp.js`(제한) / **서버 변환→PDF 권장** | 한국 현장 필수 포맷 |

### 충실도 개선 결정 (D10 · 사용자 확정) — "단기 + 장기 둘 다"
- **단기(S19, 무료 클라 업그레이드, 서버 0원)**: Word `mammoth` → **`docx-preview`**
  (페이지·스타일 반영으로 워드에 근접). Excel 은 SheetJS 서식 렌더 개선(단, 패치판이
  `cdn.sheetjs.com` 전용이라 네트워크 정책 허용 시). **PPT/HWP 는 여전히 한계** → 다운로드.
- **장기(S20, 서버 변환→PDF)**: pptx/doc/hwp/avi 등을 **헤드리스 변환**으로 PDF/mp4 정규화 후
  PDF.js 로 **일관 고품질** 표시. 변환기: **LibreOffice headless / Gotenberg / unoserver**
  (무료 SW, 변환 컨테이너 1개 운영). hwp 정확도 필요 시 한컴 변환 보강.
- **비채택**: MS Office Online / Google Docs **온라인 임베드** — 원본급 품질이지만 **파일이
  공개 접근 + 외부(MS/Google) 서버로 전송**되어 기밀 도면에 부적합(D10).
- **공통 폴백**: 미지원/변환 전 파일은 **다운로드 버튼** 제공(절대 막다른 길 X).
- **보안**: Supabase Storage **서명 URL(짧은 만료)** 로만 접근. 뷰어는 권한(RLS) 확인 후 발급.

**작업 범위(S13)**: 파일 메타에서 mime 판별 → 뷰어 라우트 분기 → 위 1단계 라이브러리 통합.
변환 파이프라인(2단계)은 별도 세션으로 분리.

---

## 4. CDE — 공통정보관리환경 + 좌측 정보구조 재편 (Phase 7 / S14) ✅ MVP 완료
> **상태**: MVP 완료 — `0005_cde.sql`(folders/file_versions/activity_log + files
> 컬럼) · `src/lib/cde.ts` · `/project/:id/docs`(`DocumentManager`) · `components/cde/*`.
> 폴더트리 CRUD · 다중 버전 업로드/이력 · 상태 뱃지(WIP→Shared→Published→Archived) ·
> 활동 로그. 워크스페이스 상단 `자료 관리` 진입. 후속(체크인/락·승인 워크플로우·
> transmittal·태그/검색·폴더 이동 UI)은 별도 세션. 배포 셋업은 OPERATIONS 0-C.
**CDE(Common Data Environment, ISO 19650)**: 프로젝트 정보를 한곳에서 **버전·상태·이력**과
함께 관리하는 단일 출처. 현재의 "모델 목록"을 **문서/데이터 관리 체계**로 확장한다.

### 좌측 네비게이션 재편(제안) — 폴더가 아니라 "모듈 + 폴더트리"
```
┌ MIR_VDC (프로젝트: 평택-오송 2복선화 제5공구)
│
├─ 📁 파일 저장소(Documents)        ← CDE 본체: 폴더트리 + 버전/상태/이력
├─ 🧊 BIM 모델(Models)              ← 3D 뷰어 (현재 워크스페이스)
├─ ⏱ 4D 시뮬레이션                  ← S4
├─ 🚜 장비 시뮬레이션               ← Phase 3 (S15)
├─ 🔍 검토·간섭(Clash/Review)       ← Phase 4 + Navisworks 기능군 (S14)
├─ 📝 이슈/마크업(Issues)           ← RFI·지적사항·뷰포인트
├─ 📤 자료전송(Transmittals)        ← 정식 송부 이력 (ISO 19650)
├─ 📊 보고서(Reports)               ← 진척·물량·반출입
└─ 👥 구성원/권한                    ← 기존 관리자 콘솔 연계
```
> 이름·범위는 확정 아님(껍데기부터 만들어도 OK). 우선 **파일 저장소 + 모델**을 본궤도로.

### CDE 핵심 개념(ISO 19650 상태)
파일/모델마다 **승인 상태**를 가진다: `WIP(작업중) → Shared(공유) → Published(승인/발행)
→ Archived(보관)`. 상태 전이 = 검토·승인 워크플로우 + 감사이력.

### 데이터 모델(설계 초안, 새 마이그레이션으로 추가)
> ⚠️ **S13(PR #22)이 이미 `0004_files.sql` 로 `files` 테이블 + `docs` 버킷을 생성**한다.
> S14 CDE 는 그 위에 폴더/버전/상태/이력을 **얹는 형태**로 `0005_cde.sql` 에 추가한다
> (기존 `files` 에 `folder_id`·`status`·`current_version_id` 컬럼 추가 + 신규 테이블).
- `folders(id, project_id, parent_id, name, path)` — 트리.
- `files`(기존, PR #22) + `folder_id` / `status` / `current_version_id` 컬럼 보강.
- `file_versions(id, file_id, version_no, storage_path, size, uploaded_by, created_at, note)`.
- `activity_log(id, project_id, actor, action, target_type, target_id, meta, created_at)` — 이력.
- (옵션) `transmittals`, `issues` 는 후속 세션.
- RLS는 기존 `is_member`/`is_admin` 패턴 재사용. 추가형 마이그레이션(`0005_cde.sql`+).

### CDE 기능 단계
- **MVP(S14)**: 폴더트리 CRUD · 업로드(다중 버전) · 버전 이력 보기 · 상태 뱃지 · 활동로그.
- **다음**: 체크인/체크아웃(락), 승인 워크플로우, 자료전송(transmittal), 검색/필터·태그.

---

## 5. Navisworks 기능군 (Phase 9 / S15) ⏳ 사용자 입력 대기
**상태**: 사용자가 "몇 가지 Navisworks 기능"의 구체 내용을 제공하면 그에 맞춰 기획.

참고로 Navisworks의 대표 기능(우리가 매핑할 후보):
- **Clash Detective**(간섭 검출) → ✅ **S32 완료**(Phase 4, three-mesh-bvh). UX 보강 S35.
- **TimeLiner**(4D) → ✅ S4 에서 구현.
- **Measure / Sectioning**(측정·단면) → ✅ **S36 완료**(📏 거리 측정 + ✂ 클리핑 단면).
- **Redline / Markup / Comments**(지적·코멘트) → 이슈 모듈과 연계(이슈 핀/팝업 S33·S36). ✅ **S37 마크업(redline) 완료**(2D 주석 오버레이→뷰포인트 저장·이슈 첨부).
- **Saved Viewpoints / Animator**(저장 뷰·카메라 애니메이션) → 협업 핵심(🟢). ✅ **S37 저장 뷰포인트 + S39 Animator 완료**(카메라·표시상태·마크업 저장/재호출/공유 + 순차 워크스루 비행).
- **Quantification**(물량 산출) → 요소 속성 집계. ⏳ 미구현.
- **Appearance Profiler**(속성기반 색칠) → web-ifc 속성으로 가능(🟢). ⏳ 미구현.
- **Switchback / Federation**(원본 연동·모델 통합) → Phase 10(네이티브 업로드)과 연결.

> **남은 Navisworks 후보(S15)**: 물량 산출(Quantification)·속성기반 색칠(Appearance Profiler).
> (마크업·저장 뷰포인트는 **S37 완료**, 측정·단면은 S36 완료.)

---

## 6. 장비 시뮬레이션 (Phase 3 / S16) ⏸ 기획안 **최후로 연기**(사용자 결정) · ⏳ 샘플 이미지 대기
> **우선순위**: 사용자 결정으로 다른 항목을 모두 진행한 뒤 **맨 마지막**에 착수(샘플 이미지도 그때).
**가능여부**: 🟢 웹에서 가능. 기존 로드맵의 Phase 3(Rapier 물리)와 동일 선상.
- **Rapier(WASM 물리엔진)**: 강체·관절(joint)로 굴착기 붐/암/버킷, 크레인 회전/인양,
  덤프트럭 주행 등 **관절 기구학 + 충돌**을 표현 가능.
- **경로/작업 시퀀스**: 장비 이동 경로, 작업 반경, 4D 일정과 연동(어느 공정에 어느 장비).
- **간섭/안전**: 장비 작업반경 vs 구조물/타 장비 간섭 경고(Phase 4와 연계).

> 사용자가 샘플 이미지를 주면: 대상 장비 종류·동작·검증 포인트를 확정해 S15 범위 확정.

---

## 7. 네이티브 BIM 원본 업로드 (Phase 10 / S17) 🔴 전략 결정 필요
**질문**: Revit(.rvt) / Navisworks(.nwd·.nwc) / Civil 3D / DWG 도 업로드·열람 가능한가?
**핵심 사실**: 이들은 **독점 바이너리 포맷**이라 브라우저에서 직접 파싱 불가.

| 포맷 | 브라우저 직접 | 현실적 경로 |
|---|---|---|
| IFC | 🟢 web-ifc | ✅ 이미 지원 |
| DXF | 🟢 `dxf-parser`+three | 2D/3D 일부, 쉬움 |
| DWG(.dwg, Civil 3D 포함) | 🔴 | **DWG→DXF 변환**(ODA File Converter) 후 표시, 또는 APS |
| Revit(.rvt) | 🔴 | **APS Model Derivative**(SVF2)+APS Viewer, 또는 Revit에서 IFC export |
| Navisworks(.nwd/.nwc) | 🔴 | APS, 또는 IFC export, 또는 원본 다운로드 보관만 |

### 전략 선택지
- **(A) 오픈포맷 표준화**: 사용자가 IFC/DXF/glTF로 내보내 업로드. **무료·풀컨트롤**
  (4D/장비 시뮬에 필요한 expressID 정밀제어 유지). 단, 사용자 변환 수고.
- **(B) Autodesk Platform Services(APS) Viewer 통합**: rvt/nwd/dwg/dgn 등을 **클라우드
  번역(translation)** 후 APS Viewer로 열람. Forma/BIM360과 동일 경험. 단, **유료(번역+저장)
  · 벤더 종속 · APS 객체모델(dbId)은 web-ifc(expressID)와 별개** → 4D/장비 시뮬과의
  통합 비용 발생.
- **(C) 하이브리드(권장)**:
  - IFC = web-ifc(정밀 4D/장비 시뮬용, 무료) **유지(D2)**.
  - 네이티브 원본(rvt/nwd/dwg) = **저장소(CDE)에 원본 보관 + 다운로드** 우선 제공,
    열람은 (i) APS Viewer 통합(예산 승인 시) 또는 (ii) "IFC로 내보내 등록" 안내.
  - 즉 **"원본은 보관·전달, 시뮬레이션은 IFC"** 로 역할 분리.

### 결정 필요 사항(사용자 합의)
1. APS(유료 클라우드) 도입 여부 — 예산/계정. → B/C 갈림.
2. 네이티브 모델도 4D/장비 시뮬 **대상**인지, **열람만**인지.
3. DWG는 우선순위 높음(현장 2D 도면) → DWG→DXF 변환 파이프라인 우선 검토 가치.

> 이 항목은 비용·아키텍처 영향이 커서 **사용자 결정 후** 세션 착수. 결정은 `DECISIONS.md`에 기록.

---

## 확장 세션 목록 (재정렬 반영)
> main 이 **S12 를 브랜딩(MIR SMART)** 으로 선점 → 초기 기획의 S12(CDE)는 **S14** 로 이동.
| # | 세션 | 브랜치(예) | 의존 | 상태 |
|---|---|---|---|---|
| S11 | UI/디자인 시스템 리뉴얼(화이트+네이비) | `feature/ui-refresh` | — | ✅ 완료 |
| S12 | 브랜딩(MIR SMART·쌍용 CI·로그인 홈) | (branding-rename) | S11 | ✅ 완료 |
| S13 | 문서·미디어 뷰어(새 탭) | `feature/doc-viewers` | S12 | 🔄 진행(PR #22) |
| S14 | CDE 정보구조 재편 + 파일 저장소 MVP | `feature/cde-foundation` | S13 | ✅ 완료 |
| S15 | Navisworks 기능군 | `feature/nw-features` | 뷰어 | ⏳ 입력대기 |
| S16 | 장비 시뮬레이션(Rapier) | `feature/equipment-sim` | S4 | ⏳ 이미지대기 |
| S17 | 네이티브 BIM 업로드/변환(APS 평가) | `feature/native-bim` | S14 | 🔴 결정대기 |
| S18 | 성능 최적화·코드 스플리팅 | `feature/code-splitting` | — | S13서 일부 선반영 |
| S19 | 뷰어 충실도 — 단기(무료 클라) | `feature/viewer-fidelity` | S13 | docx-preview 등 |
| S20 | 뷰어 충실도 — 장기(서버 변환→PDF) | `feature/doc-convert` | S13 | PPT·HWP 포함 |
| S21 | 사업관리 포털 — 사업개요 대시보드 + 모듈 메뉴 | `feature/pmis-portal` | S14 | ✅ 완료 (PROJECT WORKS형) |
| S22 | 포털 모듈 — 공정현황 + 협업/이슈 | `feature/portal-modules` | S21 | ✅ 완료 |
| S23 | 포털 모듈 — 기성·하도급·게시판 | `feature/portal-modules` | S22 | ✅ 완료 (포털 메뉴 1차 전부). 남은: P6 폴리시 |
| S24 | 권한 — 쓰기 admin 전용(D11) | (busy-lovelace) | S23 | ✅ 완료 |
| S25 | 셸 통합 레이아웃(2차 트리) | (busy-lovelace) | S21 | ✅ 완료 |
| S26 | 첨부파일(사진/문서) + 뷰어 리사이즈 | (busy-lovelace) | S23 | ✅ 완료 |
| S27 | 사용자 피드백 1~5(메뉴명·인라인뷰어·공정입력·기성공종별·4D영속화) | (busy-lovelace) | S21~26 | ✅ 완료 |
| S29 | 마일스톤 정렬 + 이슈↔3D 객체 핀 | (busy-lovelace) | S22 | ✅ 완료 |
| S30 | 이슈 워크플로우(상태·담당자·마감·알림) | `feature/issue-workflow` | S22 | ✅ 완료 |
| S31 | 문서 삭제 권한 완화(D12) | `feature/doc-delete-owner` | S14 | ✅ 완료 |
| S32 | 충돌검사(Phase 4) | `feature/clash-detection` | 뷰어·S30 | ✅ 완료 |
| S33·34 | 3D 모듈 분리 + 모델 풀 공유 | (mods·share-pool) | S32 | ✅ 완료 |
| S35·36 | 간섭 UX + 리뷰도구(측정·단면·핀팝업·표시토글) | (clash-ux·…) | S32 | ✅ 완료 |
| **S37** | **저장 뷰포인트 + 마크업(redline)** ✅ | (viewpoints-markup) | 뷰어 | ✅ 완료 (0017) |
| **S38** | **간섭 보고서 — 사용자 Word 양식(docxtemplater, D15)** | `feature/clash-report` | S32 | ⏳ 양식 대기 |

**권장 착수 순서**: …S32~S37✅ → **다음 S38(간섭 보고서, 양식 도착 시)**
→ 백로그(§9: 마크업 도형 개별 편집·카메라 애니메이션·간섭 그룹화/필터·2D 도면 핀·모바일)
→ S15(Navisworks 잔여=물량·속성색칠)·S17(APS) → **S16 장비(최후)**.

---

## 9. 백로그 (S36 시점 — 다음 스텝 후보)
> ✅ 완료된 항목: 이슈 워크플로우(S30) · 문서 삭제 권한(S31) · 충돌검사(S32) · 3D 모듈 분리(S33·S34)
> · 간섭 UX(S35) · 측정/단면·이슈핀 팝업·표시 토글(S36). 아래는 **남은 후보**:
- **간섭검사 고도화**: 결과 **그룹화·정렬·필터·상태승계** ✅ **S40 완료**(카테고리쌍/요소A/상태 묶음 ·
  깊이·상태 정렬 · 상태칩 필터 · 재검사 rerun 상태승계). 남은 후보: **간섭 보고서**(S38·Word양식 대기) ·
  그룹 단위 격리/일괄 상태변경 · 레벨/그리드 묶음 · 정기검사/규칙 세트 저장 · Duplicate 확장.
- ✅ **저장 뷰포인트 / 마크업(redline)** — **S37 완료**(0017) + **S39**(마크업 도형 개별 선택/이동/삭제 ·
  카메라 애니메이션 워크스루) 완료. 후속: 끝점 리사이즈·다중선택·워크스루 속도UI·뷰포인트 순서변경·
  표시상태 복원을 4D/간섭 모드까지 확장.
- **권한 일관성**: 0003(공정표) RLS 를 admin 전용으로 정리(현재 admin/member, D11 일관성). 마이그레이션 1개.
- ✅ **도면(2D) 이슈 핀** — **S41 완료**(0018, PDF=pdf.js·DXF=자체 렌더·줌/팬·핀↔이슈, A안).
  후속: DXF INSERT/블록 전개·SPLINE · 핀 멤버 작성 권한 · 도면↔3D 위치 양방향 · **DWG는 S17(APS)**.
- **공정 고도화**: 공정표 이력관리(버전별 비교), GUID 기반 정밀 매핑.
- **활동/감사 통합 뷰**: CDE activity_log + 이슈/일보 변경을 프로젝트 타임라인으로.
- **모바일 현장 모드**: 공사일보·사진 첨부·이슈 등록을 모바일 우선 화면으로.
- **성능**: 자동로드 점진 로딩(S35 자동로드 후속) · 코드 스플리팅(S18).
- (대기) S16 장비 시뮬(Rapier, 샘플 이미지) · S17 네이티브 BIM(APS 결정) · S19/S20 뷰어 충실도.

---

## 10. 충돌검사 (Phase 4 / S32) ✅ MVP 완료
> **상태**: MVP 완료(branch `feature/clash-detection`) — `three-mesh-bvh`(D13) 엔진 +
> `src/lib/clash.ts`(광역 AABB → 협역 BVH, 진행률 청크) + `ClashPanel`(4D 뷰어 우측 드로어:
> 대상 A/B[전체·모델·카테고리]·유형[Hard/Clearance]·허용오차·결과표[상태]·격리·CSV) +
> 간섭→이슈 모달(S30 `createIssue` + 0012 객체 핀) + `0015_clash.sql`(clash_tests/clashes,
> RLS 읽기멤버/쓰기admin) 결과 저장/불러오기. 배포=`setup_all.sql`(0003~0015).
> 후속: Duplicate 유형·규칙세트·GUID 비교·관측점·Web Worker 분리·정밀 관통깊이.
**목표**: 로드된 IFC 요소 사이의 **간섭(clash)** 을 검출해 목록·뷰어로 검토하고, 간섭을
**이슈로 전환**(S30 워크플로우 연결)한다. Navisworks Clash Detective 의 웹 버전.

### 가능성 (확인 완료)
- `IfcViewer.elementMeshes: Map<expressID, THREE.Mesh[]>` 로 **요소별 지오메트리 접근 가능**.
- 네비게이트: 기존 `focusElement`(S29) 재사용 → 간섭 객체로 카메라 이동·하이라이트.
- 엔진: **`three-mesh-bvh`**(D13) 추가 — AABB 광역 → BVH 메시-메시 협역.

### 검사 방식
1. **대상 집합(Set A vs Set B)** 선택: (a) 두 모델(예: 구조 vs 설비), (b) 카테고리/공종,
   (c) 현재 선택 그룹. MVP 는 **두 모델 또는 두 카테고리** 부터.
2. **광역단계(broad)**: 각 요소 월드 AABB 로 후보쌍만 추림(전수 비교 회피).
3. **협역단계(narrow)**: 후보쌍을 `three-mesh-bvh` `intersectsGeometry`/shapecast 로 정밀 교차.
   대형 모델은 **Web Worker + 청크**로 끊어 UI 프리징 방지(진행률 표시).
4. **간섭 종류**: **Hard(하드, 겹침)** 우선. 이후 **Clearance(이격, 허용거리 내 근접)**·
   **Duplicate(중복)**. 허용오차(tolerance) 슬라이더.

### 결과 / UX
- **결과 패널**: 간섭 목록(요소A↔요소B, 간섭 지점, 관통깊이/거리), 그룹핑, **상태**
  (신규/활성/검토됨/해결/승인 — Navisworks 유사), 행 클릭 → **양쪽 객체 포커스**(focusElement
  확장: 2개 동시 하이라이트 + 카메라 fit). 간섭 지점 마커.
- **간섭 → 이슈**: 행에서 `이슈 생성` → S30 이슈(담당자·마감·알림)로 전환, 0012(객체 핀)로
  해당 객체 연결.
- **리포트**: 표 내보내기(CSV) + (후속) 스냅샷.

### 데이터 (선택 — 영속화)
- `0015_clash.sql`: `clash_tests`(project_id, name, set_a, set_b, tolerance, type, created_by)
  + `clashes`(test_id, model_a, express_a, model_b, express_b, point xyz, distance, status, issue_id?).
  RLS 쓰기 admin(D11), 읽기 멤버. setup_all.sql 갱신.

### 범위 (S32 MVP) — ✅ 완료
1. ✅ 두 집합 선택 + 허용오차로 **Hard/Clearance clash 실행**(BVH, 청크+진행률).
2. ✅ 결과 패널 + 양쪽 객체 포커스(A초록/B빨강+ghost+줌, S35) + 간섭 지점.
3. ✅ **간섭 → 이슈 생성**(S30 연결 + 4각도 스냅샷 첨부, S35).
4. ✅ 결과 DB 저장(`0015_clash.sql`) + CSV 내보내기.

### 후속 (완료/남음)
- ✅ **S33·S34** 3D 모듈 분리(통합모델/4D/간섭) + 모델 풀 공유. ✅ **S35** 자동로드·UX 7건.
  ✅ **S36** 4D↔간섭 누수 픽스 · 이슈핀 팝업 · 모델/카테고리 표시 토글 · 측정/단면.
- **남음(백로그 §9)**: 결과 **그룹화·정렬·필터**(Navisworks식 상태승계) · **간섭 보고서(→§11)**
  · 규칙 세트/정기검사 · Duplicate · GUID 기준 비교 · 자동로드 점진 로딩.

---

## 11. 간섭 보고서 — 사용자 Word 양식 채우기 (S38 / D15) ⏳ 사용자 양식 대기
**가능여부**: 🟢 가능. `docxtemplater`(브라우저, 무료/MIT)로 사용자가 만든 `.docx` 양식의
자리표시자에 간섭 데이터·스냅샷을 주입해 완성본을 내려준다. (S35 에서 4각도 스냅샷 이미 캡처)

### 사용자가 만들 양식(.docx) 자리표시자 규칙
- **단일 값(텍스트)**: `{project_name}` `{report_date}` `{tolerance}` `{total_count}`
  `{open_count}` `{resolved_count}` 등 — 원하는 위치에 그대로 입력.
- **표 반복(간섭 목록)**: 표의 **데이터 행 한 줄**을 만들고 첫 셀 앞에 `{#clashes}`, 마지막 셀
  뒤에 `{/clashes}`. 셀 안에는 `{idx}` `{name_a}` `{cat_a}` `{name_b}` `{cat_b}`
  `{depth}` `{status}` 등. → 간섭 수만큼 행 자동 증식.
- **이미지(선택)**: `{%image_a}` (무료 image module). 제약 시 텍스트·표 먼저.
- 저장은 `.docx`(Word 표준). 앱이 양식을 업로드받아 채운 뒤 완성 .docx 다운로드.

### 범위 (S38)
1. 양식 업로드(또는 프로젝트에 등록) → 현재 간섭 결과(0015)로 채우기 → 완성 .docx 다운로드.
2. 표 반복 + 요약 값. 3. (가능 시) 스냅샷 이미지 삽입. 4. PDF 는 Word 또는 S20.
> **선행**: 사용자가 양식 .docx 1개 제공. 그 전까지 텍스트/표 더미로 파이프라인만 구현 가능.

---

## 12. 5D 물량 산출·원가 연계 (Quantification) (S42) ✅ MVP 완료
**목표**: BIM 요소에서 **물량(개수·길이·면적·체적)** 을 카테고리/공종별로 집계(QTO)하고,
기존 **기성/원가(billing_items, 0011)** 와 연계해 5D(원가) 흐름을 완성한다. Navisworks
Quantification 의 웹 버전 + 우리 포털 원가 모듈 연결.

### S42 구현 결과 (branch `feature/quantities`) ✅
- **IfcViewer 확장**: `getLengthUnitToMeters`(IfcSIUnit/IfcConversionBasedUnit → 미터 환산 계수, 캐시) ·
  `getElementBaseQuantities`(IfcRelDefinesByProperties 1회 순회로 요소→IfcElementQuantity 인덱스, Net>Gross
  우선) · `getMeshQuantities`(삼각형 적분 체적·표면적·bbox).
- **`lib/quantities.ts`**: `computeQuantities`(단위 정규화 + 청크 진행률) · `aggregateByCategory` ·
  `quantitiesToCsv` · `fmtQty`. 카테고리=`getElementMeta`(S32) 재사용.
- **`pages/Quantities.tsx`** + 라우트 `/project/:id/quantities` + 좌측 메뉴 `🧮 물량 산출 (QTO)`. 대상 집합
  (모델→카테고리) 2단계(ClashPanel 패턴) · 단위 자동/m/mm 토글 · 공종별 물량표+합계 · CSV · 행 클릭 포커스 ·
  **기성내역 행 제안**(createBillingItem, admin). 마이그레이션 없음(계산만으로 MVP 충족).
- **후속**: 단가 DB(물량→금액 자동) · 기성 quantity 컬럼(0019) · QTO_* 표준 수량셋 매핑 · 기간별 투입물량 곡선.

### 가능성 (🟢)
- web-ifc 로 요소별 **IfcElementQuantity(BaseQuantities)** 읽기 가능. 없으면 메시에서
  **체적/면적/바운딩 근사** 계산(`elementMeshes`, D2). 카테고리=`getElementMeta`(S32) 재사용.
- 4D 공정 매핑(S4)·간섭 집합 선택기(S35) 와 동일 패턴으로 **공종/기간별 물량** 산출.

### 범위 (S42 MVP)
1. 모델의 **카테고리/공종별 물량 표**(개수·길이·면적·체적) + CSV 내보내기.
2. 선택 집합(모델/카테고리) 기준 집계 + 요소 클릭→포커스.
3. (연계) 산출 물량을 **기성내역(billing_items) 행 채우기 보조** — 자동 제안, 확정은 관리자.
4. (선택) 4D 일정과 묶어 **기간별 투입 물량** 곡선.
- **데이터**: 계산은 클라이언트. 영속화 필요 시 `0019_quantities.sql`(quantities 캐시, RLS D11).
- **다음**: 단가 DB 연동(복합단가) · 자동 수량-원가 산출서 · IFC 표준 수량셋(QTO) 매핑 정교화.

### 구현 메모 (S42 — 재사용/주의)
- **물량 소스 우선순위**: ① IFC `IfcElementQuantity`(BaseQuantities: `Q_GrossVolume`/`NetVolume`/
  `GrossArea`/`Length` 등)를 `ifcAPI.GetLine`(IfcViewer 내부, `getProperties` 패턴)으로 읽기 →
  ② 없으면 **메시 기반 근사**(`elementMeshes` 삼각형 적분 체적·면적·bbox) → ③ 항상 **개수**는 집계.
- **⚠ 단위 처리(정확도 핵심)**: IFC 길이단위(mm/m)가 모델마다 달라 체적이 10^9 배 틀어질 수 있음.
  `IfcUnitAssignment`/`IfcSIUnit`(LENGTHUNIT prefix)로 **스케일을 읽어 m·m²·m³ 로 정규화**.
  자동 추정 실패 시 **수동 단위 토글**(mm/m) 폴백 제공.
- **재사용**: 카테고리=`IfcViewer.getElementMeta()`(S32) · 집합 선택기=ClashPanel 의 (모델→카테고리)
  2단계 UI(S35) · 모델 목록=`getLoadedModels()` · 포커스=`focusElement`(S29).
- **기성 연계**: `src/lib/portal.ts` `listBillingItems/createBillingItem`(0011: `category`·
  `contract_amount`·`prev_amount`·`current_amount`)에 **공종(category) 매핑으로 물량 행 제안**.
  쓰기는 관리자(D11). 물량→금액은 단가 입력이 있어야 하므로 MVP 는 **수량 제공 + 수동 단가**.
- **위치**: 새 데이터층 `src/lib/quantities.ts` + 좌측 모듈 메뉴 `물량 산출(QTO)` 페이지
  (`/project/:id/quantities`), 기성내역에서 링크. 색은 `index.css` 토큰만.

---

## 13. CDE 고도화 — 승인 워크플로우·자료전송 (S43) ← 신규 기획
**목표**: S14 CDE(MVP: 폴더·버전·상태뱃지·활동로그)를 **ISO 19650 운영 수준**으로 끌어올린다.

### 범위 (S43)
1. **승인 워크플로우**: 상태 전이(WIP→Shared→Published→Archived)에 **검토자/승인자 단계**와
   승인 이력(누가·언제·코멘트). 상태 변경 시 알림(S30 notifications 재사용).
2. **자료전송(Transmittal)**: 여러 문서를 묶어 **정식 송부**(수신자·목적·기한) + 수신 확인 + 이력.
3. **검색·태그·필터**: 파일명/태그/상태/기간 검색, 폴더 이동 UI.
4. (선택) **체크인/체크아웃(락)**: 편집 충돌 방지.
- **데이터**: `0019_transmittals.sql`(transmittals/transmittal_items + approvals), files 에 tags.
  RLS 쓰기 admin(D11), 승인자 단계는 역할 확장 검토. setup_all.sql 갱신.
- **연계**: 활동/감사 통합 뷰(백로그)와 자연 연결 — CDE activity_log + 이슈/일보 타임라인.
