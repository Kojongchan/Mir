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

## 0. 현재 위치 (요약)
- ✅ Phase 0 인증/권한(RLS)/저장 · Phase 1 3D IFC 뷰어 · Phase 2 4D 시뮬레이션(S4).
- 스택: Vite+React+TS / Three.js + web-ifc(WASM) / Supabase(Auth·PG·Storage·RLS) / Vercel.
- 뷰어는 **web-ifc 직접 사용**(D2) → 요소(expressID) 단위 정밀 제어가 4D/장비 시뮬의 핵심.

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
- **Redline / Markup / Comments**(지적·코멘트) → 이슈 모듈과 연계(이슈 핀/팝업 S33·S36). 🔄 마크업(redline) 미구현.
- **Saved Viewpoints / Animator**(저장 뷰·카메라 애니메이션) → 협업 핵심(🟢). ⏳ 미구현.
- **Quantification**(물량 산출) → 요소 속성 집계. ⏳ 미구현.
- **Appearance Profiler**(속성기반 색칠) → web-ifc 속성으로 가능(🟢). ⏳ 미구현.
- **Switchback / Federation**(원본 연동·모델 통합) → Phase 10(네이티브 업로드)과 연결.

> **남은 Navisworks 후보(S15)**: 마크업(redline)·저장 뷰포인트·물량 산출·속성기반 색칠.

---

## 6. 장비 시뮬레이션 (Phase 3 / S16) ⏳ 샘플 이미지 대기
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

**권장 착수 순서**: S11~S14✅ → S21~S29✅(포털·CDE·협업) → S15/S16(입력 대기) → S17(APS 결정 후).
**S14(CDE)~포털 1차 마무리.** 다음은 아래 백로그에서 선택.

---

## 9. 백로그 (S36 시점 — 다음 스텝 후보)
> ✅ 완료된 항목: 이슈 워크플로우(S30) · 문서 삭제 권한(S31) · 충돌검사(S32) · 3D 모듈 분리(S33·S34)
> · 간섭 UX(S35) · 측정/단면·이슈핀 팝업·표시 토글(S36). 아래는 **남은 후보**:
- **간섭검사 고도화**: 결과 **그룹화·정렬·필터**(Navisworks식, 상태 승계) · **간섭 보고서**(HTML/PDF)
  · 정기검사/규칙 세트 저장 · Clearance/Duplicate 확장.
- **저장 뷰포인트 / 마크업(redline)**: 카메라 뷰 저장·공유 + 화면 주석(Navisworks 남은 기능 = S15).
- **권한 일관성**: 0003(공정표) RLS 를 admin 전용으로 정리(현재 admin/member, D11 일관성). 마이그레이션 1개.
- **도면(2D/PDF) 이슈 핀**: 3D 객체 핀(S29)에 이어 2D 도면 좌표에 이슈 마커.
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
- **남음(백로그 §9)**: 결과 **그룹화·정렬·필터**(Navisworks식 상태승계) · **간섭 보고서(HTML/PDF)**
  · 규칙 세트/정기검사 · Duplicate · GUID 기준 비교 · 자동로드 점진 로딩.
