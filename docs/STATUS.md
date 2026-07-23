# STATUS — MIR_VDC

> 매 세션 종료 시 이 파일을 갱신하세요. 새 세션은 여기부터 읽습니다.

---
## 📋 T1 — 3D뷰(신규 테스트) 네이티브 메뉴: xeokit로 스택 교정 (2026-07-21)
> branch `claude/3d-view-testing-hlrugl`. typecheck·build 통과. **확정 전까지 main 미머지**(협의됨).

### ⛔ 초판 실패 → 교정 (핵심)
- **초판(폐기): Three.js + web-ifc** — 브라우저에서 IFC 런타임 파싱. 527MB 터널 IFC 드롭 시
  회전/확대가 안 될 정도로 렉(=논문 때 That Open 실패 + ACC 렉의 재현). **금지 스택**이었음.
- **교정: xeokit(더블프리시전) + 서버 사전변환 XKT**. 엔진만 xeokit, IFC는 브라우저에서 파싱하지
  않고 서버 `convert2xkt`로 XKT를 구워 스트리밍(문서 V1_INTEGRATION.md §0·§5·§1-3 확정 설계).

### ✅ 한 일
- `npm install @xeokit/xeokit-sdk`(^2.6.112). **`src/pages/ThreeDTest.tsx` 전면 재작성** —
  xeokit `Viewer({dtxEnabled:true})` + `XKTLoaderPlugin`. 로컬 **`.xkt`** 드롭/선택 →
  `loader.load({xkt: ArrayBuffer})`(브라우저 파싱 없음) → `cameraFlight.flyTo` → **클릭 픽**
  (entity.id + metaObject 이름/유형 → MIR_SMART DB 조인 지점). IFC 드롭 시 "서버 변환 후 XKT" 안내.
- 라우트 `/project/:projectId/model-test`(lazy 코드스플릿, xeokit는 이 청크에만 896kB — 초기
  번들 무영향) + 좌측 네비 '3D뷰 (신규 테스트)'. CSS `.threed-test*`(캔버스·속성패널) 갱신.
- web-ifc/three 는 **다른 메뉴(자료관리 파일 열기 IfcModelViewer 등)가 여전히 사용** → 전역 제거 X.
  이 테스트 메뉴에서만 잘못된 스택을 걷어냄.

### ✅ 한 일 (2차 — ACC→변환→xeokit 배선, 사용자 결정 'A로 시작')
- **주 시나리오 구현**: 드랍이 아니라 **ACC(자료관리)에 올라간 rvt·nwd·dwg·ifc 를 선택 → 서버 변환
  (SVF→glTF→XKT) → xeokit 로드**. ThreeDTest.tsx 에 기존 `AccFilePicker` 재사용 '**ACC에서 열기**'
  버튼 + 변환 상태 흐름(캐시조회→변환→로드) + 클릭 픽. 로컬 `.xkt` 드롭은 보조로 유지.
- **신규 서버리스 변환기 `api/aps-convert.ts`(Node 런타임)**: 매니페스트에서 SVF 뷰어블 GUID 추출 →
  `svf-utils`(SVFReader.FromDerivativeService + GLTFWriter, center:false 실좌표 유지) → `@xeokit/
  xeokit-convert`(convert2xkt, 단일 XKT) → Supabase `models` 버킷 `aps-xkt/{urn해시}/model.xkt` 로
  **캐시 업로드** → 서명 URL 반환. GET=캐시조회, POST=변환. 원본 크기 상한(200MB) 초과 시 413(오프라인 유도).
  기존 `/api/aps-*` 인증(Supabase 세션 bearer)·토큰(2-legged) 패턴 재사용. deps: `svf-utils@8`,
  `@xeokit/xeokit-convert@1.3`(서버 전용 — 프런트 번들에 안 들어감).

### 🔜 다음 할 일 / 미해결 (배포 환경에서 실검증 필요 — 샌드박스는 APS 크리덴셜·실행 불가)
- **배포 검증 항목**: ① `api/aps-convert` 가 Vercel **nodejs 런타임 + Web 핸들러(Request/Response)**로 뜨는지
  (기존 함수는 전부 edge라 이 조합은 이 레포 첫 사례 — 안 뜨면 `(VercelRequest,res)` 시그니처로 전환).
  ② env `APS_CLIENT_ID/SECRET`·`SUPABASE_SERVICE_ROLE_KEY` 서버 설정. ③ `models` 버킷에 service_role
  업로드 RLS 허용. ④ 중소형 ACC 모델로 변환→로드→클릭 픽 눈확인. ⑤ 좌표(R4): center:false glTF 가
  실좌표로 나오는지(지형 정합 관건).
- **초대형(527MB급)**: serverless 한도 초과(413) → 오프라인/배치 변환(ingest)로 XKT 굽고 같은 캐시 경로에
  올리는 경로(B) 후속. 캐시 키(urn 해시)·버킷 경로는 이미 맞춰둠.
- 확장: 지형 glTF·DWG 선형을 같은 xeokit 씬에 실좌표 정합(문서 §1~§5).

### ✅ 한 일 (3차 — 변환 워커 분리: 모두에게 자동·큰 파일 커버)
- 서버리스 동기 변환이 **504 타임아웃**(큰 모델은 60초 초과 — 구조적 한계) → 사용자 결정대로
  **변환을 장시간 실행 컨테이너(A: Railway 등)로 분리**. 변환은 **모델당 1회, 공용 캐시 공유**라
  누가 한 번 열면 이후 **모든 사용자**가 캐시에서 즉시 로드.
- **`worker/`(신규 배포 단위)**: Node HTTP 서버(`server.mjs`, 무프레임워크). `POST /convert {urn}`
  → 즉시 `{status:'processing'}` + **백그라운드** 변환(svf-utils→convert2xkt, `deduplicate:false`
  속도 우선) → Supabase `models` 버킷 `aps-xkt/{sha1(urn)}/model.xkt` 업로드. 진행중 URN 메모리
  중복 방지. `x-worker-secret` 인증. 자체 `package.json`(svf-utils·xeokit-convert). `README.md` 포함.
- **`api/aps-convert.ts` 를 edge 로 경량화**: 무거운 변환기 제거 → GET=캐시조회(존재확인+서명URL),
  POST=캐시 확인 후 **워커에 위임**(WORKER_URL/SECRET). 500/504 원인(무거운 import·nodejs런타임) 소거.
- **프런트 폴링**: POST 후 `{status:'processing'}` 면 4초 간격으로 GET 캐시 폴링(최대 20분, 경과초 표시)
  → XKT 뜨면 자동 로드. 로컬 `.xkt` 드롭 보조 유지.
- 루트 `package.json` 에서 svf-utils·xeokit-convert 제거(워커로 이동) → Vercel 번들 경량.

### ✅ 한 일 (4차 — 기존 변환 파이프라인 재사용, 무료·검증됨: 'A로 시작')
- **발견**: 레포에 **이미** ACC→GLB 변환기가 있음 — `.github/workflows/convert-4d.yml` +
  `scripts/convert4d.mjs`(main 존재·dispatch 가능·GitHub Actions 무료·거대모델 데시메이션·
  **CI SVF 다운로드 타임아웃 해결 완료**). 3차의 자체 워커는 `FromDerivativeService`를 써서
  CI에서 같은 타임아웃을 다시 밟을 방식이라 **폐기**(worker/ 삭제).
- **재사용 배선**: `api/aps-convert.ts`(edge) — GET=캐시조회(`models4d/<urn40>/model.glb` 서명URL),
  POST=캐시 없으면 **`convert-4d.yml`을 urn으로 workflow_dispatch**(GH_REPO/GH_TOKEN/GH_REF) → processing.
  캐시 키·버킷을 convert4d.mjs와 **동일 규약**으로 맞춤.
- **프런트**: XKT→**GLB 로드**(`GLTFLoaderPlugin`, GLB는 plain glTF라 디코더 불필요). ACC 선택→
  캐시조회→(없으면 dispatch)→5초 폴링(최대 30분)→자동 로드. 로컬 `.glb` 드롭 보조.
- **main 변경 0** — convert-4d.yml이 이미 main에 있어 dispatch만 하면 됨. worker/·XKT 잔재 제거.

### 🔜 다음 할 일 / 미해결 (사용자 설정 최소)
- **Vercel env 2개만**: `GH_REPO`=`Kojongchan/Mir`, `GH_TOKEN`=워크플로 dispatch PAT(classic `repo`
  또는 fine-grained Actions:write). (`GH_REF` 기본 main.) SUPABASE_URL/SERVICE_ROLE는 이미 있음.
- **GitHub Actions Secrets**(APS·SUPABASE)는 convert-4d.yml이 이미 쓰므로 **대개 설정돼 있음** — 없으면 추가.
- 검증: 'ACC에서 열기'→(캐시 없으면)Actions 변환→GLB 캐시 히트→**xeokit 렌더**. 먼저 `models4d`에 4D용으로
  이미 구운 GLB 있으면 그 urn으로 바로 로드 테스트 가능.
- **판단 대기**: GLB는 병합+데시메이션(4D용) → ①객체별 클릭 granularity ②형상 정밀도 확인 후,
  필요하면 convert4d 다운로더 재사용한 **XKT 변형(B)**으로 갈지 결정.

### ✅ 라이브 검증 완료 (5차 — 4포맷 실렌더 + 변환 버그 격파)
사용자 설정(Vercel `GH_REPO/GH_TOKEN/GH_REF`=브랜치, GitHub Actions Secrets)이 완료돼 **실 ACC 모델을
xeokit로 여는 것을 4포맷 모두 실측 확인**: IFC·RVT·NWD·DWG. 그 과정에서 convert4d.mjs 버그 연쇄 격파:
1. **공유 속성DB `../` 404**(RVT) → URN 정규화. → 그래도 **DWG는 존재하지 않는 속성DB(objects_avs) 404**.
   최종해결: **`read({skipPropertyDb:true})` + objects_*.json.gz 다운로드 제외**(속성DB는 지오메트리에
   불필요, dbId는 fragment에서). 두 실패 모드 근본 제거 + 변환 소폭 가속.
2. **GLB > 50MB(Supabase 무료 상한) 업로드 실패**(NWD 94.8MB) → **gltf-pipeline Draco 압축**(94.8→~7MB,
   position 14bit). xeokit는 KHR_draco 디코드 지원(meshopt은 xeokit 미지원 KHR_mesh_quantization 요구라 배제).
3. **업로드 실패를 삼켜 run이 가짜 success** → **치명적 처리(throw/exit1)**. 이제 실패는 Actions에서 실패로.
4. **모든 모델 90° 눕힘(Z-up vs Y-up)** → 프런트 로드 시 **rotation [-90,0,0]**(GLTFLoaderPlugin).
- 이 convert4d.mjs 수정들은 **브랜치 한정**(GH_REF=branch) — main의 4D 기능(비-Draco 로더)엔 영향 없음.
  (나중 main 머지 시 4D 뷰어의 Draco 지원 필요 — 주의.)
- 디버깅은 GitHub MCP(actions_list/get_job_logs/run_trigger)로 Actions 로그 직접 조회하며 진행.

### 🔜 다음 할 일 / 미해결
- **①실패 감지**: 잡이 실패해도 프런트가 최대 30분 헛폴링 → api가 최근 run 상태를 봐서 실패를 즉시 알리기.
- **②사전변환(대기 0)**: 업로드/프로젝트 진입 시 백그라운드 프리페치 → 첫 열람도 캐시 히트.
- (검토) GLB 병합+데시메이션이라 **객체별 클릭 granularity / 형상 정밀도** 충분한지 → 부족하면 XKT 변형.
- (검토) 첫 변환 속도: 러너 `npm install`(~12s) 매번 고정비 — 캐시로 단축 가능(main 워크플로 수정 필요).

### 인수인계 한 줄
**ACC 4포맷(IFC·RVT·NWD·DWG) → GitHub Actions 변환(속성DB 스킵·Draco 압축) → Supabase 캐시 →
xeokit 렌더(Z-up 보정)** 실동작 확인 완료. convert4d 수정은 브랜치 한정, 확정 전 미머지. 다음은
실패 감지 + 사전변환(대기 0).

### ✅ 한 일 (6차 — R2 이전 + DWG 색상/선 복원 + IFC 잡음선 제거)
- **저장소 R2 이전**: Supabase 50MB 벽(대형 NWD 등) 회피 → Cloudflare R2(무료 10GB·egress 무료).
  `scripts/convert4d.mjs` S3Client 업로드, `api/aps-convert.ts`(edge) aws4fetch 서명·캐시조회. 9GB
  부터 경고배너(ackOverage 확인 후 진행 — 자동결제 방지). xeokit 캐시버스터가 presign 서명 깨던
  문제는 커스텀 fetch dataSource 로 우회.
- **🐞 DWG 전부 흰색 → 실제 색 복원(핵심)**: SVF DWG 는 재질(diffuse)이 흰색이고 **실제 ACI 색이
  정점색(getColors)** 에 실려 온다(로그 확인: 변환 전 `재질그룹 1 · mat 1 rgb=(1,1,1)`). 그런데
  xeokit GLTFLoaderPlugin 은 **정점색(COLOR_0)을 렌더하지 않음**(POSITION/NORMAL/TEXCOORD/uniform
  color 만). → `mergeGlb.mjs` 를 **(재질 + 대표 정점색)별 그룹핑**으로 재작성: 프래그먼트 대표
  정점색을 재질 baseColor 로 승격 → 각 색이 고유 uniform 재질로 렌더. 검증(같은 DWG 재변환 로그):
  `재질그룹 7 · 색그룹 15`, rgb=(0,1,0)초록·(0.64,0.40,0.32)탠·(0.48,0.64,0.32)올리브 등 실색 확인.
- **DWG 선/점 유지 vs IFC 잡음선 제거(포맷 인지)**: 파일 확장자로 `include_lines` 판단 —
  DWG=선 유지, 그 외=엣지선 제외. 프런트(name)→api(include_lines)→convert-4d.yml(INCLUDE_LINES)→
  mergeGlb. 또한 xeokit **합성 엣지선(edges) 전 포맷 off**(원본 아님) — IFC 불필요 선 소거, DWG
  진짜 선형은 line 프리미티브(mode:1, 색 포함)로 유지.
- 디버깅은 GitHub MCP 로 Actions 로그 직접 조회하며 진행(사용자에게 로그 요청 X).

### 🔜 다음 할 일 / 미해결
- **초대형 IFC "Too many properties to enumerate"**(PO05_F_AB_BR02.ifc): xeokit metaModel JS 한계.
  메타(속성) 없이 지오메트리만 로드하거나 메타 분할 필요 — 별도 대응.
- (검토) 텍스처 재질(RVT 등 maps.diffuse) 지원 — 현재는 diffuse 단색만.
- 사용자 눈확인 대기: DWG 색/선, IFC 잡음선 제거(R2 캐시 이미 갱신됨 — 재변환 없이 열면 반영).

### 인수인계 한 줄 (6차)
R2 이전 + DWG 색상(정점색→재질 승격) · 선/점(포맷별) 복원 · IFC 합성 엣지선 제거 완료(같은 DWG
재변환 로그로 실색 검증). 다음은 초대형 IFC 메타 한계 대응. 브랜치 한정·미머지 유지.

### ✅ 한 일 (7차 — 토목 DWG '콩알' 렌더/네비게이션: 거대 측량좌표 대응)
- **증상**: 토목 DWG(토공_갱구부 사면 등)가 화면 중앙 콩알로 뜨고 줌으로 다가가지지 않음.
- **원인(변환 로그 bbox 로 확진)**: 실측좌표(X≈225km·폭 20.7km × 10.2km). ① near/far 범위가
  극단이라 전체를 담으면 가까이 못 가고 ② flyTo 가 20km 전체(대부분 빈 공간)를 맞춰 콩알 ③
  흩어진 측량선이 bbox 를 20km 로 부풀림(실제 밀집부는 5.7km).
- **해결**:
  1) Viewer `logarithmicDepthBufferEnabled:true` — km~m 스케일 한 화면에서 오감(클리핑/콩알).
  2) `cameraControl.followPointer=true`(+smartPivot) — 줌이 커서 아래 지오메트리로 다가감.
  3) **focus 박스**(변환기가 프래그먼트 중심점의 가중치 85% 최소구간=밀집영역 계산 →
     `<key>/focus.json` R2 업로드 → api 가 cacheState 에 실어줌 → 프런트가 로드 회전과 같은
     축변환 후 그 박스로 flyTo). 이 DWG 는 focus half (8800→2830)로 실제 밀집부만 잡힘 확인.
  4) Draco 위치 14→16bit — 20km 범위에서 1.2m→0.3m 형상 보존.
- **적용 범위**: ①②는 프런트(전 모델 즉시 개선), ③④는 재변환 필요(focus.json 은 새 변환부터
  생김). 이 DWG 는 재변환 완료(캐시에 focus 반영). 기존 캐시 모델은 focus 없이도 로그깊이+
  followPointer 로 네비 개선됨(원하면 재변환).
- 검증: 변환 로그 bbox/focus 직접 조회. **사용자 액션: Vercel 재배포 후 DWG 다시 열기(캐시 즉시).**

### 인수인계 한 줄 (7차)
토목 DWG 콩알/줌불가 = 거대 측량좌표(20km) 문제. 로그깊이버퍼+followPointer+밀집 focus 박스
(focus.json)+Draco 16bit 로 해결. 프런트 재배포 필요. 다음은 초대형 IFC 메타 한계.

---
## 📋 F2 — 협업·이슈 고도화(타입 분화·3뷰·뷰포인트·출력·현장등록) (2026-07-10)
> branch `claude/issue-collaboration-upgrade-o4uzc0`. typecheck·build 통과.
> .docx/xlsx 생성은 node 스모크 테스트로 실검증(3종 양식 렌더·이스케이프·잔여태그 0 확인).

### ✅ 한 일
1. **마이그레이션 0038_issue_types.sql(추가형)**: `issues.type`(general·rfi·punch·safety·quality) +
   `issues.meta jsonb`(타입별 필드·현장 GPS 태그) + **`issue_viewpoints`**(camera_state jsonb·
   markup jsonb·snapshot 데이터URL) + issue_events kind 확장(meta·viewpoint_add/del).
   RLS 읽기=is_member·쓰기=is_editor.
2. **타입 분화(`lib/issueTypes.ts` 선언형 레지스트리)**: 타입별 라벨·아이콘·색 + 전용 필드 스키마
   (RFI=상대처·응답기한·응답 / 하자=위치·협력사·심각도 / 안전=위험요소·조치 / 품질=기준·부적합) +
   타입별 워크플로우 상태 라벨(RFI: 질의 등록→회신 대기→회신 완료→종결 등 — DB 상태 키는 공통 유지).
   폼·상세·칸반·엑셀·양식이 이 스키마 하나를 읽음(하드코딩 분산 없음).
3. **3뷰 전환(`Issues.tsx` 개편)**: ☰ 리스트(유형 컬럼+**검색**(제목·내용·담당·타입필드)+**정렬**
   (최신/오래된/마감임박/우선순위)+타입 칩 필터) · 📋 **칸반**(상태 5열, HTML5 DnD 카드 드래그로
   상태 이동, 권한=canEdit 또는 담당자 본인) · 📍 **핀 뷰**(3D GlobalId 앵커 이슈 + 도면핀(0018)
   이슈를 위치별로 모아 상호 점프). 뷰 선택은 localStorage 유지. 칸반/핀 뷰 상세=넓은 모달.
4. **협의 완결 — 3D 뷰포인트/마크업**(`lib/issueViewpoints.ts`): 통합모델(3D)에서 이슈 생성 시
   **현재 뷰 자동 저장**(카메라 getState+스냅샷), 이슈 핀 팝업에 '📌 현재 뷰 저장'. 이슈 상세
   뷰포인트 그리드(스냅샷+마크업 오버레이) → **3D에서 열기**(navigation state `applyApsState` 로
   restoreState — AccModels 가 마운트/기존화면 양쪽 처리) · **✏ 마크업 편집기**(MarkupOverlay 재사용,
   선/사각형/화살표/텍스트+5색, markup jsonb 저장) · 삭제. 전부 변경이력 기록.
5. **연결(상호 점프)**: 이슈 상세 '위치 보기' 의 **잔존 버그 수정 — 존재하지 않는 `/acc` 라우트 →
   `/model`**. 이슈↔간섭(focusClashA/B, 기존 유지)·이슈↔도면(**listPinsForIssue** → '📐 도면에서
   보기', Drawings 가 `openDrawingId` state 수용)·핀 뷰에서 3D/도면 진입. (이슈↔회의록은 회의록
   기능(R2) 자체가 미구현이라 보류.)
6. **출력/양식(`lib/issueExport.ts`)**: **엑셀 export**(xlsx, 현재 필터·정렬 그대로 반영, 타입별 정보·
   GPS 컬럼 포함) + **RFI 질의서/지적통보서 .docx**(docxtemplater+pizzip — 런타임 생성 템플릿,
   회사 양식 확정 시 템플릿만 교체) + **인쇄용 양식**(A4 CSS, 첨부사진·뷰포인트 스냅샷 포함 →
   브라우저 'PDF로 저장'). 전부 dynamic import 로 코드 스플리팅 유지.
7. **현장(모바일) 등록 + 오프라인**(`lib/issueDrafts.ts`): '📷 현장 등록' 모달 — 사진 촬영
   (capture=environment, 1280px 다운스케일)·**GPS·시각 자동 태깅**(meta.site, 상세·엑셀·양식에 표시).
   오프라인/실패 시 **localStorage 초안 큐** → 온라인 복귀·재진입 시 자동 동기화(이슈 생성+사진
   attachments 업로드). 상단에 '초안 N건 대기' 뱃지.
8. **기존 유지(회귀 방지)**: 코멘트 @멘션·읽음/안읽음·관련자료(ACC)·간섭 이미지·변경이력·담당/마감
   편집 전부 그대로. `listIssues` 는 0038 미적용 DB 폴백(type=general·meta={}) — 마이그 전에도 동작.
   '간섭 검토 이미지' 섹션은 현장 사진도 담게 되어 '사진·이미지'로 명칭 변경.

### ⚠️ 적용/검증 필요 (이 샌드박스는 auth·Supabase·ACC 불가)
- **0038 적용 필수**. 적용 전에도 기존 기능은 폴백으로 동작하나 타입/뷰포인트는 저장 안 됨.
- 라이브 눈확인 권장: 칸반 드래그(담당자 본인 상태변경 포함), 3D '현재 뷰 저장'→상세 썸네일→
  '3D에서 열기' 복원, 도면핀 상호 점프, 모바일 사진+GPS(HTTPS 필요), 오프라인 초안 동기화,
  .docx 를 MS Word/한컴에서 열어 서식 확인(node 검증은 XML 유효성까지).
- 신규 npm 의존성: docxtemplater·pizzip (양식 .docx).

### 🔁 라이브 피드백 반영 (2026-07-10)
- 뷰 명칭 변경: 리스트 / **카드**(구 칸반) / **핀(간섭)**.
- 양식 출력 2종(.docx·인쇄/PDF)을 **'📑 보고서' 드롭다운 하위로 묶음**(`ReportMenu` 신설,
  속성 섹션에 `--pop` 부여로 드롭다운 클리핑 방지).
- **이슈 '항목'(공종·대상 분류) 추가 — 0039_issue_category.sql**: `issue_category`(프로젝트별
  이름·정렬, RLS 읽기=멤버·쓰기=is_editor) + `issues.category_id`(FK, 삭제 시 미지정) +
  이력 kind 'category'. 현장마다 공종이 달라 **하드코딩 대신 프로젝트별 관리**(`lib/issueCategories.ts`):
  이슈 화면 ⚙ 로 추가/이름변경/삭제, **기본 세트 원클릭**(보고서·토공·교량·터널·가시설·도면·
  기타 문서·시뮬레이션). 등록폼·현장등록(초안 포함)·상세 속성(편집)·리스트 컬럼·카드 칩·
  툴바 필터(전체/미지정/항목별 건수)·엑셀 '항목' 컬럼·보고서 양식(.docx/인쇄)에 반영.
  0039 미적용 DB 는 3단 폴백(full→typed→legacy)으로 무회귀. **0039 적용 필요.**
- **모든 이슈 생성 경로에 항목·유형 반영**(사용자 요청): ①간섭검토 '간섭 → 이슈' 모달
  (ApsClashPanel — 항목·유형 셀렉트 추가, 유형 기본=품질) ②통합모델(3D) '＋ 이슈' 버튼
  (AccModels — 제목만 묻던 window.prompt 를 **폼 모달**로 교체: 제목·항목·유형). 두 경로 모두
  프로젝트 항목 목록을 불러와 선택.
- **이슈 등록을 인라인 섹션 → 팝업 모달로 통일**(현장 등록과 동일 방식): 협업·이슈 상단
  '＋ 이슈 등록' 이 dash-edit 섹션 대신 modal 로 뜬다(제목·항목·유형·우선순위·담당·마감·
  타입필드·내용).
- **현장 등록(모바일 사진·GPS·오프라인 초안) 제거**(불필요 판단): 버튼·QuickFieldRegister·
  초안 큐(`lib/issueDrafts.ts` 삭제)·동기화 effect·초안 뱃지 CSS 모두 제거. 이슈 상세의
  기존 site(GPS) 표시는 하위호환으로 조건부 유지(데이터 있을 때만).
- **이슈 툴바 정리(사용자 선택: 유형 칩 유지 + 상태 드롭다운)**: 비슷하게 생긴 칩 두 줄
  (유형·상태)이 무겁고 '전체 48'이 중복이던 문제 해소. ①1행=뷰 전환·검색(넓게)·정렬,
  ②2행=유형 칩(분포 한눈에, **0건은 opacity 0.4로 옅게**, 카운트는 볼드+옅은 색) + 우측에
  **상태·항목 드롭다운**(상태를 칩 → 드롭다운으로, 칸반에선 상태가 열이라 숨김) + ⚙.
  중복 '전체' 제거, 미사용 `.issue-filters` CSS 정리. 목업 스크린샷으로 시각 확인.

- **아이콘 통일(이모지 → 커스텀 SVG, 사용자 요청)**: 이슈 화면이 이모지(🗂❓🔧⚠️✅📍⚙…)라
  "노션 스타일"로 겉돌던 문제 해소. 기존 디자인 시스템 아이콘 세트를 재사용/확장:
  ①**유형 아이콘 5종**을 도메인 `Icon.tsx`에 추가(일반=문서·RFI=말풍선+?·하자=깃발·안전=경고삼각·
  품질=체크원, 레드닷 생략하고 **타입색 currentColor tint**). `issueTypes.ts`의 이모지 `TYPE_ICON`
  제거 → `TYPE_ICON_NAME`(IconName)로 교체(중복 제거). ②**범용 UI 아이콘 15종**을 `UiIcon.tsx`
  스프라이트에 추가(list·columns·pin·search·download·settings·edit·bookmark·file-text·printer·
  eye·user·clipboard·cube·ruler) — 단일 정의 참조라 중복 없음. ③Issues.tsx 전 구간(툴바·칩·뱃지·
  상세·모달·항목관리·보고서메뉴·마크업툴) 이모지를 `<Icon>`/`<UiIcon>`로 교체, `<option>` 내부는
  SVG 불가라 텍스트만. `.ic`/`.ic-only`/검색아이콘 CSS 유틸 추가. ApsClashPanel·AccModels의
  유형 option도 텍스트화(TYPE_ICON import 제거). 아이콘 목업 스크린샷으로 시각 확인.
  (EmptyState 대형 이모지는 앱 전역 패턴이라 이번 범위 밖.)
- **유형 아이콘 의미색(사용자 요청)**: 단어 특징을 살린 색 — 안전=빨강(#dc2626)·하자지적=앰버
  (#f59e0b)·RFI=파랑(#2563eb)·품질=초록(#16a34a), 일반(문서)=중립(특징색 없음). `TYPE_ICON_COLOR`
  추가 + `TypeIcon`(의미색 span, 활성 칩은 invert로 흰색). 칩·뱃지·상세 헤더에 적용해 한눈에 구분.

### 인수인계 한 줄
이슈 고도화 완결(0038/0039: 타입 5종+항목+meta+뷰포인트 / 리스트·카드·핀(간섭) 3뷰 / 뷰포인트·마크업 /
보고서(엑셀·RFI·지적통보서) / 이모지→커스텀 SVG 아이콘 통일). typecheck·build·docx/xlsx·아이콘 목업 OK.
다음은 0038·0039 적용 후 라이브 검증.

---
## 📋 C12 — 첨부 파일크기 저장 → 다운로드 % 계산(우회) (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과.

### ✅ 한 일 (Content-Length 미유지 우회)
1. **ACC 파일 크기 확보**: `api/aps-acc` contents 응답의 `included`(tip 버전)에서 `storageSize` 를 읽어 각
   item 에 `size` 추가. `AccItem.size` 필드 추가.
2. **첨부 시 크기 저장(0037_issue_file_size.sql)**: `issue_file_link.size_bytes`. 피커 `PickedAccFile.size` →
   `addIssueFile(sizeBytes)`.
3. **다운로드 % 계산**: `downloadAccItemProgress(..., knownTotal)` — XHR onprogress 에서 서버 Content-Length 가
   없으면(edge 버퍼링) 저장된 `size_bytes` 를 총량으로 써서 `loaded/total` 로 % 표시.

### ⚠️ 주의
- **0037 적용 + 서버 재배포(api/aps-acc·aps-file) 필요.**
- **기존에 첨부된 링크는 size_bytes=null** → 재첨부해야 % 나옴(신규 첨부부터 적용). Content-Length 가 살아있으면
  기존 것도 % 표시됨.
- 그래도 0/100 만 보이면 edge 가 응답을 통째 버퍼링해 onprogress 가 1회만 발생하는 극단 케이스 — 이 경우
  네트워크 계층 한계라 클라이언트로는 더 못 쪼갬(서버에서 청크 스트리밍 조정 필요).

### 인수인계 한 줄
ACC 파일크기(storageSize)를 첨부 시 저장(0037)하고 다운로드 % 총량으로 사용. 서버 재배포+0037 적용, 재첨부부터 %.

---
## 📋 C11 — 다운로드 진행률 XHR·동시 다운로드·미리보기 버튼 정리 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과.

### ✅ 한 일
1. **다운로드 진행률 XHR 전환**: fetch 스트림 리더 → `XMLHttpRequest`(다운로드 `onprogress` 이벤트가 주기적으로
   발생해 **중간 %가 매끄럽게** 갱신). Content-Length 있으면 loaded/total, 없으면 `…`.
2. **동시 다운로드 지원**: 진행률 상태를 단일 슬롯 → **파일별 맵**(`dls[fileId]`)으로 변경. 한 파일 받는 중에 다른
   파일을 눌러도 **기존 다운로드가 끊기지 않고** 각자 % 표시. 같은 파일 중복 클릭은 무시.
3. **인라인 3D 미리보기의 '3D 뷰어로 열기' 버튼 제거**(요청) — 미리보기 창에서 바로 3D 로 보므로 불필요.
   `AccFilePreview` 에서 navigate/projectId 제거.

### 🔜 미해결
- 중간 %가 여전히 0/100 만 보이면 **서버 버퍼링 가능성**(edge 가 응답을 한 번에 전달) — 그 경우 대안은 첨부 시
  ACC 파일크기 저장 후 그 값으로 계산. 서버(api/aps-file) 재배포 필요.

### 인수인계 한 줄
다운로드 XHR 진행률 + 파일별 동시 다운로드 + 미리보기 3D열기 버튼 제거. typecheck·build OK. 서버 재배포 필요.

---
## 📋 C10 — 관련자료 모델 인라인 3D 미리보기 + 다운로드 % 실동작 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 UX 피드백.

### ✅ 한 일
1. **모델(rvt·nwd·ifc…) 인라인 3D 미리보기**: 관련 자료 '미리보기'가 이제 파일의 **3D 뷰를 그 자리 오버레이에
   직접 렌더**(ACC 처럼). 신규 `ApsMiniViewer`(GuiViewer3D, 스크립트/Initializer 페이지당 1회 로드, urn 로드).
   `AccFilePreview` 가 모델이면 `ApsMiniViewer` 를 띄우고, urn 없으면 '변환 전' 안내. (기존 '3D 뷰어로 열기'
   전체화면 버튼은 헤더에 유지.)
2. **다운로드 진행률 % 실동작**: 프록시(`api/aps-file`)가 스트림만 넘기고 **content-length 를 안 넘겨** 항상
   불확정(`…`)이던 문제 → S3 원본의 `content-length` 를 응답에 그대로 전달하도록 수정 → 클라이언트가 총량을
   알아 `⬇ N%` 표시. (플랫폼이 청크 전송으로 재작성하면 여전히 `…` 폴백.)

### 🔜 다음 할 일 / 미해결 (실 ACC 검증)
- 인라인 3D: 대형 모델 로드 성능·토큰 만료, 여러 번 열고 닫을 때 뷰어 정리(finish) 확인.
- 다운로드 %: Vercel edge 가 content-length 를 유지하는지(안 되면 대안 = ACC 파일크기 메타 저장 후 전달).

### 인수인계 한 줄
관련자료 모델 미리보기를 인라인 3D(ApsMiniViewer)로, 다운로드 %는 프록시 content-length 전달로 실동작.
typecheck·build OK. 실 ACC 눈확인.

---
## 📋 C9 — 내용편집 양식통일·다운로드 진행률·미리보기·더보기(10) (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 UX 피드백.

### ✅ 한 일
1. **내용 편집 버튼 우측 정렬(속성 양식과 통일)**: `.issue-block__chev` 를 전역 `margin-left:auto` 로 바꿔
   내용의 '✏ 편집'도 속성의 '설정 편집'처럼 헤더 우측에 배치.
2. **관련 자료 다운로드 진행률(0~100%)**: `downloadAccItemProgress`(스트림 리더로 loaded/total) 추가 → 버튼에
   `⬇ N%` 표시(Content-Length 없으면 `⬇ …` 불확정). 완료 시 저장.
3. **관련 자료 인라인 미리보기**: 다운로드 **좌측에 '👁 미리보기'** → `AccFilePreview`(신규) 오버레이. AccBrowser
   문서 미리보기와 동일 경로(blob/서명/리다이렉트 + 우리 뷰어). 모델은 '3D 뷰어로 열기' 안내.
4. **헤더 표기 통일**: '관련 자료 (파일 개수 : N)' → **'관련 자료 · N'**(코멘트·변경이력과 동일 양식).
5. **코멘트·변경이력 더보기(기본 10)**: 각각 최근 10개만 보이고 '이전 … 더 보기'로 전체 펼침
   (`showAllComments`/`showAllEvents`). 변경이력 넘버링은 전체 기준 유지.

### 🔜 다음 할 일 / 미해결
- **실 ACC 환경 검증**: 미리보기(이미지/PDF/office/영상), 다운로드 진행률(프록시 Content-Length 여부), 폴더 딥링크.
- 반영된 추가제안: 코멘트/이력 페이지네이션·관련자료 미리보기(완료). 나머지 제안은 사용자 기각.

### 인수인계 한 줄
내용편집 우측정렬·다운로드 진행률·관련자료 인라인 미리보기(AccFilePreview)·헤더 '· N' 통일·코멘트/이력 더보기(10)
완료. typecheck·build OK. 실 ACC 눈확인.

---
## 📋 C8 — 이슈 상세 개선 8건(내용편집·관련자료·다운로드·이력확장·섹션순서) (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 UX 피드백.

### ✅ 한 일
1. **내용 편집**: 내용 섹션 헤더에 '✏ 편집' → textarea 인라인 편집·저장(`updateIssueMeta` description).
2. **섹션 명칭/문구**: '자료관리 파일'→**'관련 자료 (파일 개수 : N)'**, '이미지·자동 캡처(기존)'→**'간섭 검토 이미지'**
   + "간섭 검토에서 이슈 생성 시 자동으로 추가됩니다." 안내 문구.
3. **관련 자료 다운로드 + 위치**: 각 파일 우측에 **⬇ 다운로드**(`downloadAccItem`) + **파일 위치 : 폴더경로 칩**
   (클릭 시 자료관리 해당 폴더 딥링크, C7 그대로).
4. **섹션 순서 재배치**: **속성 → 내용 → 간섭 검토 이미지 → 관련 자료 → 코멘트 → 변경이력**(속성 맨 위).
5. **변경이력 확장(0036_issue_event_kinds.sql)**: kind 체크에 content·priority·due·file_add·file_download·comment
   추가. `updateIssueMeta`(우선순위/마감/내용)·`addComment`·`addIssueFile`·파일 다운로드에서 이력 기록.
   `logIssueEvent` 공개 헬퍼 + `eventText` 새 종류 문구. 각 변경 후 `refreshEvents` 로 이력 즉시 갱신.
6. `Attachments` 에 label='' 지원(헤더 숨김) — '간섭 검토 이미지' 섹션이 자체 헤더·문구를 갖도록.

### 🔜 다음 할 일 / 미해결
- **0035·0036 적용 필요**. 실 ACC 환경에서 관련자료 다운로드·위치 이동, 변경이력 각 항목 기록 눈확인.
- 추가 제안(사용자 검토): ①코멘트/이력 페이지네이션(길어질 때) ②이슈 목록에 관련자료·코멘트 수 뱃지
  ③변경이력에 '되돌리기' ④@멘션 시 이메일(인프라 필요) — 별도 논의.

### 인수인계 한 줄
이슈 상세 8건 개선(내용편집·관련자료 다운로드/위치·섹션순서·변경이력 6종 확장 0036) 완료. typecheck·build OK.
0035/0036 적용 후 실 ACC 눈확인.

---
## 📋 C7 — 이슈 첨부 = 자료관리(ACC) 파일 링크 + 폴더 딥링크 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. **ACC 의존 → 실환경 검증 필요**.
> 사용자 결정: (1) 전면 전환(개인 업로드 X, 자료관리 파일만 링크) (2) 클릭 시 정확한 폴더까지 이동.

### ✅ 한 일
1. **마이그레이션 0035_issue_file_link.sql(추가형)**: `issue_file_link`(issue↔ACC 아이템 링크) —
   acc_project_id·acc_item_id·acc_urn·name + **폴더 경로(folder_ids[]·folder_names[])** 로 딥링크 지원.
   RLS: 읽기=멤버, 쓰기=is_editor.
2. **`lib/issueFiles.ts`**: list/add/removeIssueFile.
3. **`components/AccFilePicker.tsx`(신규)**: 자료관리(ACC) 폴더 탐색 → 파일 선택(폴더 경로 함께 반환). 실무자는
   **현재 폴더로 직접 업로드**(uploadToAcc)→즉시 링크. getProjectAcc 로 ACC 프로젝트/루트 확인, 미지정 시 안내.
4. **이슈 상세**: '첨부 문서·사진(직접 업로드)' → **'자료관리 파일'** 섹션으로 전환. 파일별 **폴더 경로 칩**(클릭 시
   자료관리 해당 폴더로 이동) + 해제(실무자). '＋ 자료관리에서 첨부' 로 피커. 기존 직접첨부(간섭 자동캡처 등)는
   **읽기전용 '이미지·자동 캡처(기존)'** 섹션으로 보존(회귀 방지).
5. **자료관리 폴더 딥링크**: `AccBrowser` 에 `initialPath`(폴더 id 체인) 추가 — 진입 시 그 폴더까지 순차 펼쳐 선택.
   `DocumentManager` 가 라우트 state(`openFolderIds`)를 받아 전달. 이슈 첨부의 '위치 열기'가 정확한 폴더를 연다.

### 🔜 다음 할 일 / 미해결 (라이브 검증 — 이 샌드박스는 ACC 불가)
- **0035 적용 + 실 ACC 환경 검증 필수**: 피커에서 폴더 탐색·파일 선택·현재폴더 업로드, 첨부 링크 표시, '위치
  열기'가 자료관리의 정확한 폴더를 펼치는지, 대형 폴더 성능. ACC 미지정 프로젝트에선 피커가 안내만 표시.
- 클래시 자동캡처 스냅샷은 여전히 attachments(docs) 경로 — '기존' 섹션에 읽기전용 노출. 필요 시 ACC 이관은 후속.

### 인수인계 한 줄
이슈 첨부를 자료관리(ACC) 파일 링크로 전면 전환(0035) + ACC 폴더 피커 + 정확 폴더 딥링크(AccBrowser initialPath).
typecheck·build OK. 실 ACC 환경 눈확인 필요.

---
## 📋 C6 — 이슈 상세 UX 보정(멘션 잘림·속성 접기·위치보기 이동) (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 UX 피드백.

### ✅ 한 일
1. **@멘션 드롭다운 잘림 수정**: 코멘트 블록이 `overflow:hidden` 이라 입력창 위로 뜨는 후보 목록이 잘렸음
   → 코멘트 섹션에 `.issue-block--pop`(overflow visible + 헤더 라운드) 부여해 온전히 표시.
2. **속성 접기/펼치기**: 속성 섹션을 변경이력처럼 토글. 요약(상태·우선순위·담당·마감)은 **항상 표시**,
   담당자 배정·우선순위·마감일 **편집 컨트롤은 펼쳐야** 보이게(기본 접힘, 깔끔).
3. **위치 보기 → 내용 섹션으로 이동**: 위치 보기 버튼을 속성 → 내용 블록으로 옮김.

### ⏳ 다음(큰 작업, 사용자 확인 대기) — 자료관리(ACC) 연동 첨부
- 이슈 첨부를 **자료관리(ACC)에 있는 파일만** 링크하도록 전환 요청. 파일 위치(폴더) 표시 + 클릭 시 해당
  폴더로 이동, 직접 업로드 시 ACC 폴더 선택 후 업로드·링크. **자료관리=ACC(Autodesk)** 기반이라 신규 링크
  테이블 + ACC 폴더 브라우저 피커 + AccBrowser 딥링크(폴더 열기)까지 필요한 큰 기능 → 접근 방식 확인 후 착수.

### 인수인계 한 줄
멘션 잘림·속성 접기·위치보기 이동 완료(typecheck·build OK). 자료관리 연동 첨부는 접근 방식 확인 후 다음 착수.

---
## 📋 C5 — 이슈 상세 보고서형 UI · 인라인 @멘션 · 변경이력 접기 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 UX 피드백 반영.

### ✅ 한 일
1. **@멘션 인라인 하이라이트**: 코멘트 본문 안의 `@이름`(구성원 일치·경계)을 **그 자리에서 파랗게**
   표시(`renderCommentBody` + `.mention-tag`). 기존처럼 본문 뒤에 `@이름` 을 **따로 붙이던 줄 제거**.
2. **이슈 상세 = 보고서형 블록**: 상세를 **섹션 카드**(내용 / 속성 / 첨부 / 코멘트 / 변경이력)로 재구성.
   각 섹션에 헤더(좌측 accent 바 + 배경 구분)로 딱딱 나뉘게. 상태·우선순위는 뱃지로 표기. 구성 일관성 확보.
3. **변경이력 접기/펼치기**: 자주 바뀌면 길어져서 **기본 접힘**, 헤더 클릭으로 토글(▸/▾). 각 이력 앞에 **넘버링
   (#1..)**, **시간·작성자는 코멘트처럼 우측 정렬**(`.issue-event-no`/`.issue-event-meta`).
4. CSS: `.issue-report`/`.issue-block(__h/__b/__toggle)` 신설, 첨부 블록은 Attachments 자체 헤더를 섹션 헤더로
   스타일. 라이트/다크 토큰 사용.

### 🔜 다음 할 일 / 미해결
- 실 로그인 화면에서 눈확인(이 샌드박스는 auth 불가). 0033/0034 적용 후 담당자·멘션 최종 확인.
- 메일 발송은 인프라 부재로 인앱 알림 유지.

### 인수인계 한 줄
이슈 상세를 보고서형 섹션 카드로 재구성 + 코멘트 @멘션 인라인 파란 하이라이트 + 변경이력 넘버링·우측시간·접기.
typecheck·build OK. 실 화면 눈확인만 남음.

---
## 📋 C4 — 협의=이슈 단일화 · 담당자 목록 버그픽스 · 이슈 상세 강화 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 피드백 반영.

### ✅ 한 일
1. **간섭 '협의' → '이슈'로 단일화**(사용자 판단: 둘이 같은 내용): 간섭 결과 행의 **💬 협의 버튼·
   코디네이션 룸(ApsClashCoordination)·요약 뱃지 전부 제거**. 이제 간섭은 **"이슈로 등록"** 하나로만 협업
   진입 → 담당·코멘트·멘션·상태·마감은 **협업·이슈 화면**에서 완결. 미사용 파일 삭제
   (`ApsClashCoordination.tsx`·`clashCoordination.ts`). 0032 마이그레이션 테이블은 남지만 미사용(무해).
2. **간섭→이슈 첨부 1컷만**: 4각도 캡처는 뷰가 엇나가고 느려서 **현재 뷰 1장만** 캡처
   (`captureClashAngles(...,1)`). 캡처 시간↓.
3. **간섭→이슈 모달 강화**(협업 팝업 수준): 제목·내용·우선순위에 더해 **마감일 + 담당자**(구성원 드롭다운,
   `표시이름 - 소속 - 담당업무` 라벨) 추가. `createIssue` 에 assignee/ due 전달 → 생성 즉시 담당·기한 지정.
4. **이슈 상세 강화**: 상단에 **상태·우선순위·담당(소속/담당업무)·마감 요약줄**(`issue-facts`) + 편집행에
   **우선순위·마감일 인라인 편집**(`updateIssueMeta`). 담당자 드롭다운도 `표시이름 - 소속 - 담당업무`.
5. **🐞 담당자에 사람 안뜨던 버그 수정(핵심)**: `Issues.tsx` 가 `if(canEdit) listProjectMembers` 를
   `[projectId]` deps effect 에서만 호출 → **역할 로딩 후 canEdit=true 로 바뀌어도 재호출 안 돼** 목록이
   비어 있었음. **`[projectId, canEdit]` 별도 effect 로 분리** → 역할 확정 시 반드시 로드. 이 버그가
   @멘션 드롭다운이 안 뜨던 원인도 겸함(후보 0건이라). 이제 담당자·멘션 모두 정상.
6. **담당자/멘션 라벨 통일**: `members.memberLabel(m)` = `표시이름 - 소속 - 담당업무`(있는 것만). 이슈 생성폼·
   상세 배정·간섭→이슈 모달 전부 적용. 멘션 드롭다운은 이름+소속 표기.

### 🔜 다음 할 일 / 미해결
- **0033·0034 적용 필요**(담당자 목록 개방·소속/담당업무). 적용+역할확정 후 실무자 계정에서 담당자 뜨는지 재확인.
- 메일 발송은 여전히 인프라 부재로 인앱 알림 대체.
- 0032(clash 코디네이션) 테이블은 미사용 잔존 — 정리 원하면 후속 드롭 마이그(선택).

### 인수인계 한 줄
협의를 이슈로 단일화 + 간섭→이슈 모달/이슈 상세 강화(담당·마감·우선순위) + **담당자 목록 안뜨던 버그
(canEdit effect deps) 수정** + 라벨 통일. typecheck·build OK. 0033/0034 적용 후 라이브 검증.

---
## 📋 C3 — 알림→이슈 링크 · @멘션 자동완성 · 구성원 소속/담당업무 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과. 라이브 피드백 반영.

### ✅ 한 일
1. **알림 클릭 → 해당 이슈로 이동**: `NotificationBell` 이 이슈 알림 클릭 시 `/issues` 로 가며
   `state.focusIssueId` 전달 → `Issues` 가 그 이슈를 펼치고 **읽음 처리**. (간섭 알림은 `/clash`.)
2. **@멘션 자동완성**(`components/MentionInput.tsx` 신규): 코멘트에서 `@` 입력 시 현재 프로젝트 구성원이
   드롭다운으로 뜨고, `@관` 처럼 이어 치면 이름으로 좁혀짐(↑↓/Enter/Tab 선택, 클릭 선택, 그냥 타이핑도 허용).
   본문에 실제 남은 `@이름` 을 사용자 id 로 해석(`mentionsInText`, 이름 경계 검사로 부분일치 오탐 방지)해
   멘션 발송. `Issues.tsx` 코멘트 입력을 칩 방식 → MentionInput 으로 교체. 드롭다운에 **소속** 함께 표시.
3. **구성원·권한 재구성**(요청 반영):
   - 마이그레이션 **0034_member_org.sql**(추가형): `project_members.company`(소속)·`duty`(담당업무).
   - 표 컬럼: **표시이름(=full_name‖username 통합) · 소속 · 권한 · 담당업무 · 관리**. 소속/담당업무는 인라인
     입력(blur 저장, 낙관적 갱신). '역할' 명칭 → **'권한'**. 예시 placeholder(쌍용건설(주)/현장 공무팀).
   - 설명란: **소속**(발주처·감리단·시공사·BIM 협력업체 …) / **권한**(뷰어·실무자·관리자·시스템 관리자 설명) /
     **담당업무**(발주처·감리단·현장 공무/공사팀·본사 BIM 담당자·BIM 관리자/실무자 …) 안내.
   - `admin.ts` `MemberRow`+`listMembers`(company/duty, 0034 미적용 폴백)·`setMemberOrg`.
   - `members.ts listProjectMembers` 에 소속/담당업무 포함(폴백) → 담당 배정·멘션 드롭다운에 "이름 · 소속" 표시.

### ⚠️ 메일 발송 — 여전히 미구현(인프라 부재, C2 참고). 인앱 알림(종·클릭 이동)으로 대체.

### 🔜 다음 할 일 / 미해결 (라이브 검증)
- **0034 적용 필요**(0032·0033 과 함께). 적용 후: 알림 클릭→이슈 펼침·읽음, @자동완성(관→관리자), 소속/담당업무
  입력·저장, 배정/멘션 드롭다운의 "이름 · 소속" 눈확인.
- 간섭 코디네이션 룸(C1)은 아직 칩 방식 멘션 — 원하면 MentionInput 으로 통일(후속).
- "아이디=표시이름 통합"은 표시를 full_name‖username 으로 일원화. 로그인 아이디 자체 편집은 '아이디 변경'
  (계정 op) 유지 — 표시이름(full_name) 직접 편집 UI 는 profiles 쓰기 권한(시스템관리자/서버) 필요라 후속.

### 인수인계 한 줄
알림→이슈 링크 + @멘션 자동완성(MentionInput) + 구성원 소속/담당업무(0034)·권한 표 재구성 완료. typecheck·build OK.
다음은 0032~0034 적용 후 라이브 검증.

---
## 📋 C2 — 협업 강화: 담당 배정 개방 · @멘션 · 읽음/안읽음 (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과.
> 사용자 라이브 피드백(협업·이슈 화면 스크린샷) 반영. **이슈 화면이 실사용 협의 표면**이라 여기에 반영.

### ✅ 한 일
1. **마이그레이션 0033_issue_collab.sql(추가형)**:
   - **`shares_project(uid)` 헬퍼 + `profiles_select` 확장** — 같은 프로젝트 구성원끼리 서로의 표시이름을
     읽을 수 있게 개방(0001 은 본인·시스템관리자만). 담당 배정·@멘션 후보 목록이 비-관리자(실무자)에게도 보임.
   - **`members_select` 확장(is_member 추가)** — 실무자도 자기 프로젝트 구성원 목록 조회 가능(배정/멘션 후보).
     역할 부여(insert/update/delete)는 0023 그대로 **관리자만**.
   - **`issue_comments.mentions uuid[]`** + **`issue_read`(issue_id·user_id·last_read_at, 읽음)**.
2. **담당자 배정 = 뷰어 뺀 모두**: 권한은 이미 `canEdit`(is_editor, 뷰어 제외)로 맞았고(0023), 위 RLS 개방으로
   실무자도 **후보 목록이 채워져 실제 배정 가능**해짐(기존엔 profiles RLS 로 관리자만 목록 보였음).
3. **@멘션(이슈 코멘트)**: `issues.ts addComment(…, mentions)` — 멘션 대상엔 `issue_mention` 알림, 담당자·작성자
   (멘션 제외)엔 `issue_comment` 알림. `Issues.tsx` 코멘트 작성기에 **멘션 칩**(구성원 토글) + 코멘트에 `@이름` 표시.
4. **읽음/안읽음**: `listUnreadIssues`(내 마지막 열람 이후 새 코멘트면 안읽음) + `markIssueRead`(상세 열람 시 upsert).
   리스트 제목에 **빨간 점 + 볼드**로 안읽음 표시, 상세를 열면 읽음 처리·배지 해제. (0033 미적용 시 무해하게 스킵.)
5. **간섭검토 창 체감 지연 완화**: `/clash` 진입 시 `clashOpen` 을 즉시 열림으로 시작 + **로딩 셸**("모델 트리
   준비 중…") 을 먼저 띄운다. 트리·매핑 준비되면 실제 `ApsClashPanel` 로 교체. (근본 지연=APS 객체트리/속성DB
   로드가 3D 지오메트리보다 늦게 끝나는 것 — 트리는 A/B 선택에 필수라 단축 불가. 창이 '즉시 뜬 뒤 로딩' 체감으로 개선.)

### ⚠️ 메일 발송 — 미구현(인프라 부재)
- "배정 시 지정 메일주소로 메일" 은 SMTP/Supabase Edge Function 등 **메일 인프라가 이 레포에 없어 미구현**
  (사용자 승인: "메일연동까지 안되면 빼고"). 대신 **인앱 알림(로그인 시 상단 종 + `/clash`·`/issues` 이동)** 은
  배정·멘션·코멘트·검증 전부 동작. 메일이 필요하면 후속으로 Edge Function(`notify-email`) + 트리거/pg_net 배선 필요.

### 🔜 다음 할 일 / 미해결 (라이브 검증 필요)
- **0033 적용 필수**. 적용 후: 실무자 계정으로 로그인해 담당 배정 후보가 뜨는지, @멘션·안읽음 점·읽음 해제,
  멘션/배정 시 상대 계정 종 알림을 눈확인.
- 간섭 코디네이션 룸(C1)도 같은 profiles/members 개방 덕에 실무자에게 구성원 드롭다운이 채워짐(보너스).
- 남은 고도화: #2 회사양식 보고서·#3 규칙셋/재검사·#4 리스트↔3D 좌측 도킹·#5 BCF import·3D 뷰포인트/마크업.

### 인수인계 한 줄
협업 강화 완료(0033: 담당 배정 개방·@멘션·읽음/안읽음) + 간섭검토 창 로딩 셸. 메일은 인프라 부재로 인앱 알림으로
대체(사용자 승인). typecheck·build OK. 다음은 0033 적용 후 실무자 계정 라이브 검증.

---
## 📋 C1 — 간섭 코디네이션 룸(플랫폼 내 완결 #1 핵심) (2026-07-09)
> branch `claude/interference-coordination-platform-0nusd9`. typecheck·build 통과.
> **대전제**: MIR SMART 안에서 간섭 협의·해소·검증·이력까지 끝낸다(Navisworks/Solibri 왕복 X).
> 우선순위 #1 항목 5개 중 **#1 코디네이션 룸(핵심)** 을 완결 슬라이스로 구현. 나머지(#2 회사양식
> 보고서·#3 규칙셋 재검사·#4 뷰어중심 UI·#5 BCF import)는 후속.

### ✅ 한 일
1. **마이그레이션 0032_clash_coordination.sql(추가형)**:
   - `clashes` 확장: `assignee`(담당 FK)·`assignee_label`(관계사/역할 자유텍스트 R12)·`due_date`(기한)·
     `resolved_by/at`·`verified_by/at`(해소→검증 감사).
   - `clash_comment`(clash_id·author·author_name·body·`mentions uuid[]`·created_at) — 간섭별 코멘트 스레드.
   - `clash_read`(clash_id·user_id·last_read_at, PK 복합) — 스레드 **읽음** 표시(사용자별).
   - `notifications.clash_id` 추가 — 배정·코멘트·멘션·검증 알림도 상단 종에 뜨고 클릭 시 `/clash` 이동.
   - RLS: 쓰기 = **is_editor**(0023), 읽기 = 멤버(부모 clashes→clash_tests.project_id 로 판정). clash_read 는 본인만.
2. **`lib/clashCoordination.ts`(신규)**: 담당 배정(`assignClash`)·기한(`setClashDue`)·코멘트
   (`list/add/deleteClashComment`, @멘션→알림)·읽음(`markClashRead` upsert)·해소(`resolveClash`)·
   검증(`verifyClash`)·재오픈(`reopenClash`)·요약(`listCoordSummaries` = 담당/기한/코멘트수/미읽음). 알림은
   `notifications`(clash_id) 재사용 — 배정 시 담당자, 멘션 시 멘션대상, 코멘트 시 담당자, 검증 시 담당자에게.
3. **`components/ApsClashCoordination.tsx`(신규)**: 저장된 간섭 1건의 협의 상세(우측 시트).
   담당자(구성원 드롭다운)+관계사/역할 라벨+기한 · 상태흐름(신규→검토중→**해결**(담당)→**승인**(검토자 검증),
   해소/검증 감사줄·해소처리/검증완료/재검토 버튼) · **코멘트 스레드**(작성자·시각·@멘션 칩·삭제, 열람 시 읽음처리).
4. **`ApsClashPanel` 연동**: 각 결과 행에 **💬 협의** 버튼(dbBacked 일 때) + 코멘트수/미읽음(●)·담당·기한 뱃지.
   저장 직후 **DB 재로드**로 행 id 를 실 `clashes.id` 로 교체(협의·상태갱신이 실 행을 가리키도록 — 기존
   changeStatus id 불일치 잠재버그도 함께 해소). 코디네이션 변경 시 요약 재조회 + 리스트 상태 승계.
   `NotificationBell` 이 `clash_id` 알림을 `/clash` 로 라우팅.

### 🔜 다음 할 일 / 미해결 (라이브 검증 필요 — 이 샌드박스는 auth·ACC·Supabase 없음)
- **0032 마이그레이션 적용 필수**. 적용 후 라이브에서: 간섭 저장→💬 협의→담당/기한/코멘트/멘션 알림/해소→검증
  전 과정이 플랫폼 안에서 도는지, 재검사 상태승계(S40)와 협의 상태가 함께 유지되는지 눈확인.
- **구성원 드롭다운·@멘션 대상은 profiles RLS(본인+admin) 상 관리자/PM 에게만 채워짐**. 비-admin 실무자는
  **관계사/역할 라벨(자유텍스트)** 로 담당 표기(기존 issues 배정과 동일 제약). 멤버 이름 공유가 필요하면
  후속 마이그(멤버 간 profiles 이름 SELECT 허용) 검토.
- **기한 알림**은 배정/기한설정 시 담당자 인앱 알림으로 구현(즉시성). 기한 임박 스케줄 리마인더(cron)는 후속.
- 남은 고도화: #2 회사양식 보고서(docxtemplater, S38 양식 대기)·#3 규칙셋 저장/정기 재검사(clash_rule)·
  #4 리스트↔3D 동기화 좌측 도킹 UI·#5 BCF import(선택). 3D 뷰포인트/마크업 저장은 코멘트 다음 슬라이스.

### 인수인계 한 줄
간섭 코디네이션 룸(#1 핵심) 완결: 0032(담당·기한·코멘트@멘션·읽음·해소/검증 감사)+API+우측시트 UI, 알림
연동, 저장 후 DB 재로드로 실 행 id 정합. typecheck·build OK. 다음은 라이브 검증 + #3 규칙셋/재검사 또는 뷰포인트/마크업.

---
## 📋 M1 — 모바일 실사용 마감(뷰어 크롬·바텀시트·표·터치타깃) (2026-07-04)
> branch `claude/mobile-version-update-v810fd`. typecheck·build 통과. Playwright(390px) 계산스타일 +
> 시각 캡처로 모바일 규칙 실적용 확인, 데스크톱(1200px)은 무영향 확인. U4(하단탭)에 이은 후속 마감.
> **모든 변경은 `@media (max-width:640px)` 안이라 데스크톱/태블릿 레이아웃 무영향.**

### ✅ 한 일 (`src/index.css` 말미 M1 블록 + `src/pages/AccModels.tsx`)
1. **3D 뷰어 하단탭 겹침 해소**: AccModels 뷰어 루트(inline `absolute;inset:0`)를 `.acc-viewer-root`
   클래스로 승격 + 툴바를 `.viewer-topbar` 클래스로. 모바일에서 `.acc-viewer-root`/`.mod-fill`(자료관리·
   물량·구성원 등 전체화면 모듈)의 `bottom` 을 `calc(64px + safe-area)` 로 올려 **하단 탭바 위로** 띄움
   (absolute inset:0 자식이 portal-main 패딩을 무시해 컨트롤이 탭 뒤로 숨던 문제).
2. **뷰어 툴바 버튼 클립 → 가로 스크롤**: `.viewer-topbar` 가 좁은 폭에서 `overflow-x:auto`(관성,
   스크롤바 숨김)로 버튼이 잘리지 않고 스와이프. 데스크톱은 기존대로 한 줄.
3. **공용 모달 → 바텀 시트**: `.modal`/`.acc-modal` 이 모바일에서 전체폭·하단 도달(`align-items:flex-end`)·
   상단만 라운드·`max-height:92dvh`·safe-area 패딩. `.modal-foot` 는 세로 스택·전체폭 버튼(엄지 도달).
4. **터치 타깃·폼**: `.btn` min-height 40px(`--sm` 34px), `input/select/textarea` 16px(iOS 포커스 자동
   확대 방지), `body{overflow-x:hidden}`(가로 넘침 차단), 표 래퍼 관성 스크롤(`-webkit-overflow-scrolling`).

### 🔜 다음 할 일 / 미해결 (실 인증 환경 눈확인 권장)
- 바텀시트·뷰어 툴바 스크롤·하단탭 겹침 해소는 auth 뒤 화면이라 이 샌드박스에선 합성 DOM/계산스타일로만
  검증 — **실 로그인 후 각 모달·3D 뷰어(통합/4D/간섭)·자료관리에서 눈확인** 권장.
- 뷰어 좌측 ACC 폴더/카테고리 트리 패널의 모바일 폭(현재 데스크톱 폭 유지)은 이번 범위 밖 — 필요 시 후속에
  드로어(오버레이) 전환 검토. Lighthouse 모바일 실측도 실 프리뷰에서.

### 인수인계 한 줄
M1 모바일 마감 완료(뷰어/전체화면 모듈 하단탭 겹침 해소·툴바 가로스크롤·모달 바텀시트·터치타깃/폼 16px,
전부 <640 스코프라 데스크톱 무영향). 실 인증 화면 눈확인 + 뷰어 좌측 트리 드로어화가 후속.

---
## 📋 상단바 개선 + Lighthouse 실측 (A·C·D) (2026-07-03)
> branch `claude/design-system-phase-1-lgw4oz`(PR #107). 사용자 라이브 피드백 반영. typecheck·build 통과,
> /styleguide 미리보기 라이트/다크 + Lighthouse(로컬 프로덕션 빌드) 확인.

### ✅ 한 일
1. **상단바 사용자 전체 이름 노출**: 아바타 이니셜만 보이던 것 → 이름 전체를 아바타 옆에 표시(요청).
2. **A. 아바타 계정 드롭다운 메뉴**(`TopUserMenu.tsx`): 아바타+이름 트리거 → 클릭 시 이름·**역할 뱃지**
   (뷰어/실무자/관리자/시스템관리자, `useProjectRole`)·로그아웃 메뉴(외부클릭/Esc 닫힘). 별도 로그아웃
   아이콘 통합. **버그 수정**: `.app-topbar` 의 `overflow:hidden` 제거 — 알림·계정 드롭다운(하단 펼침)이
   잘리던 문제(알림 종도 영향). 모바일 트리거 `aria-label`(이름 숨김 시 접근 이름 확보).
3. **C. Admin 콘솔·문서뷰어 상단바 라이트 전환**: `.admin-top`/`.admin-title`/`.doc-viewer-bar`/title/size 를
   옛 네이비(--chrome*) → 라이트 토큰. 남은 --chrome = 3D 좌표 HUD(의도적 다크)·백업 Workspace(미라우팅)·
   dash-ms(U2 대체 죽은 CSS). ⚠️ Admin/문서뷰어는 auth 뒤라 실 눈확인 권장(토큰 스왑 저위험).
4. **D. Lighthouse 실측(로컬 프로덕션 빌드, chromium)**:
   - **/login: Perf 91 · A11y 100 · BestPractices 96** — U4 목표(Perf≥90/A11y≥95) **충족** ✓ (LCP 2.8s·TBT 0·CLS 0)
   - **/styleguide: Perf 75 · A11y 100 · BP 96** — 데모 페이지(전 컴포넌트+차트 2개 동시 로드 + 로컬 CDN 폰트
     차단으로 FCP/LCP 부풀려짐)라 Perf 낮음. a11y 는 button-name 수정 후 100.
   - ⚠️ 포털 내부 화면은 auth 필요라 미측정 — 실 배포 프리뷰(로그인)에서 측정 권장. 로컬은 Pretendard/Inter
     CDN 이 프록시 차단이라 폰트 로드 실패(실 배포는 정상 → Perf 더 좋을 것).

### 🔜 다음 할 일 / 미해결 (실 환경 검증 필요)
- U3 V2/V3(APS 카메라 프리셋·표시품질)·F1·F2 = 실 ACC/데이터. B(역할 뱃지)는 A 메뉴에 포함됨.
- E(프로젝트 스위처 인라인 드롭다운) 미착수. 포털 내부 Lighthouse 실측(로그인 후).

### 인수인계 한 줄
상단바 이름 노출 + 아바타 메뉴(역할·로그아웃) + 드롭다운 클리핑 버그 수정 + Admin/문서뷰어 라이트 전환 +
Lighthouse(/login Perf91·A11y100) 완료(PR #107). 남은 건 실 인증·ACC 환경.

---
## 📋 Q1 — 코드 스플리팅(초기 번들 5MB→93kB) (2026-07-02)
> branch `claude/design-system-phase-1-lgw4oz`(U-Shell·U2·U4 병합된 main 위 재분기). typecheck·build 통과,
> dev 서버로 지연 라우트 렌더 스모크(에러 0) 확인.

### ✅ 한 일
1. **라우트 지연 로드**: `App.tsx` 에서 무거운 의존성 페이지(AccModels/Drawings/Quantities/DocumentManager/
   FileViewer/Admin/StyleGuide)를 `React.lazy` + `<Suspense fallback>`(skeleton)로 분리. 셸·경량 포털 페이지
   (Dashboard/Schedule/일보/이슈/기성/하도급/게시판/구성원)는 즉시 로드 유지.
2. **벤더 청크 분리**: `vite.config.ts` `manualChunks` — recharts→charts, pdfjs→pdf, web-ifc→webifc,
   three(+mesh-bvh)→three, mammoth/xlsx→docs, @supabase→supabase, react/router→react.
3. **결과(빌드 실측)**: 단일 `index.js` **5,064kB → 93kB**(gzip 26kB). web-ifc(3,070kB)·three(543kB)·
   pdf(364kB)·docs(332kB)·charts(370kB)는 해당 기능 진입 시에만 로드. 초기 로드 = index+react+supabase+css
   ≈ gzip ~140kB. (500kB 경고는 지연 벤더 청크에 남지만 초기 로드엔 영향 없음.)

### 🔜 다음 할 일 / 미해결 (대부분 **실 환경 검증 필요** — 이 샌드박스는 auth·ACC·Supabase 없음)
- **U3 V2/V3**(APS 뷰어 카메라 프리셋·표시품질): 실 ACC 모델 필요 → 실 환경에서 구현·검증 권장.
- **F1**(관측점 DB 이관 0032~) · **F2**(이슈 협업) · **Q2**(canEdit 감사) · **Q3**(버그 스윕): 라이브 데이터/역할 필요.
- **Lighthouse**(Perf≥90/A11y≥95): 실 배포 프리뷰 측정. axe 0 은 확인 완료.
- 뷰어 툴바는 이미 토큰 기반(라이트/다크 적응) — 디자인 톤 큰 문제 없음(이모지→커스텀 아이콘 교체는 선택).

### ✅ 안전 슬라이스 추가(Q2·Q3 — 코드/빌드로 검증 가능한 것만, 사용자 결정 "안전한 것만 지금")
- **Q3 도면 'Invalid Date' 수정**(`lib/dashboard.formatDate`): `created_at` 같은 전체 타임스탬프에
  `T00:00:00` 을 덧붙여 Invalid Date 가 되던 버그 → date-only 만 로컬 자정 파싱, 타임스탬프는 그대로,
  실패 시 '미정'. 단위 검증(타임스탬프/date-only/쓰레기 입력) 통과.
- **Q2 게이팅 감사 → 사업개요 정정**: RLS(0023) `project_info/project_milestones/monthly_records` 쓰기는
  `is_editor`(실무자+) 허용인데 Dashboard 편집 버튼만 `is_admin`(시스템관리자) 한정 → 실무자·프로젝트관리자
  편집 불가 회귀(B1). `useProjectRole().canEdit` 로 정정(RLS 일치). 다른 페이지는 이미 canEdit, AccModels 의
  `isAdmin` 은 모델 고정·홈뷰 등 관리 설정(정당), Quantities 기성제안은 S51 의도적 admin — 변경 안 함.
- **잔여 라이트 전환(문서뷰어 바·Admin 상단바 네이비→라이트)**: 이 샌드박스에서 시각 검증 불가 + STATUS 상
  의도적 보류 항목이라 **미적용**(후속). 뷰어 툴바는 이미 토큰 기반이라 큰 문제 없음.

### 인수인계 한 줄
Q1 코드 스플리팅(5MB→93kB) + Q2 사업개요 게이팅 정정 + Q3 도면 날짜 버그 완료(PR #107). 남은 U3-V2/V3·
F1·F2·Lighthouse·잔여 라이트 전환은 실 인증·ACC 환경 검증 필요.

---
## 📋 U4 — 디자인 시스템 Phase 4 마감: 다크·반응형·모션·a11y (2026-07-02)
> branch `claude/design-system-phase-1-lgw4oz`. typecheck·build 통과. **axe-core 0 violations**
> (/styleguide·/login 라이트·다크 모두 critical·serious·moderate 전부 0). U3(뷰어)는 이번 묶음에 없음.

### ✅ 한 일
1. **다크 마감 — 시스템 선호 초기값**: `theme.ts` `getStoredTheme` 이 저장값 없으면 `prefers-color-scheme`
   따름 + `initTheme` 이 명시적 선택 없는 동안 시스템 테마 변경 실시간 반영. (localStorage 토글 유지.)
2. **반응형 — 모바일 하단 탭바**: `BottomTabBar.tsx`(주요 5메뉴: 사업개요/공정/3D/일보/이슈, aria-current) +
   `.app-bottom-tabbar` CSS. <640: 사이드바 숨김·본문 풀폭·하단탭 노출(fixed, z-fixed, safe-area 대응)·
   토바 압축. 641~1024 사이드바 64px collapse(기존). >1440 풀폭 유지.
3. **모션(transform/opacity만)**: `fade-in`(포털 본문 `.dash` 진입) + `modal-in`(모달/ACC모달 scale .96→1).
   `@media (prefers-reduced-motion: reduce)` 전역 가드(애니메이션/전환 축소).
4. **a11y QA(axe-core) — 전부 해소**: 초기 스캔 serious(대비)·moderate(landmark/heading/region) →
   - **대비 안전 토큰화**: KPI 시맨틱 수치·`.field__error` → badge-fg(짙은 시맨틱), `.kpi__meta`·`.field__helper`·
     `.empty-state`·`.bottom-tab`·`.project-switcher__code` 를 tertiary→secondary(tertiary=placeholder 전용, 짙은표면 4.5:1 미달).
   - **brand-solid 신설**: 흰 글자 채움(버튼·아바타)은 다크에서 밝아지는 `--color-brand-primary`(텍스트용) 대신
     짙게 고정한 `--color-brand-solid`(#2563EB) 사용 → `.btn--primary`/`.primary`/`.avatar` 흰 글자 대비 확보.
     `.btn--danger` 도 red-600 급으로 짙게(color-mix). hover 는 color-mix 로 일관 다크닝.
   - **다크 활성 nav/탭**: `.nav-item.is-active`/`.bottom-tab.is-active` 텍스트를 밝은 blue(hover 토큰)로.
   - **랜드마크/제목**: `StyleGuide`·`Login` 을 `<main>` + `<h1>` 로(landmark-one-main·page-has-heading-one·
     region 해소), 데모 Section 을 `<h2>`(heading-order). `.auth-warn code` 대비 개선.
5. **데모**: /styleguide 에 모바일 하단 탭바 미리보기 섹션 추가.

### 🔜 다음 할 일 / 미해결
- Lighthouse(Perf≥90/A11y≥95) 는 이 샌드박스(원격·auth 없음)에서 미측정 → **실 배포 프리뷰에서 측정·기록 필요**.
  axe-core 는 0(critical/serious/moderate) 확인 완료.
- U3(3D 뷰어 UI 톤·V2 카메라 프리셋·V3 표시품질)은 별도 단계로 남음.
- tertiary 는 이제 placeholder 전용 관례 — 신규 텍스트에 tertiary 쓰지 말 것(secondary 사용).
- 모바일 하단탭/모션/다크는 auth 뒤라 실 포털에선 로그인 후 눈확인 권장.

### 인수인계 한 줄
U4 마감 완료(시스템 다크 초기값·모바일 하단탭·모션·reduced-motion, axe 0 violations, brand-solid 로 다크 버튼
대비 해결). Lighthouse 는 실 프리뷰 측정만 남음. 후속은 U3(뷰어).

---
## 📋 U2 — 디자인 시스템 Phase 3: 사업개요 Bento 대시보드 + Recharts (2026-07-02)
> branch `claude/design-system-phase-1-lgw4oz`. typecheck·build 통과, /styleguide Bento 미리보기 라이트/다크 확인.
> 기준: DESIGN_SYSTEM §2(Bento)·§3(KPI Card) + dataviz 스킬 원칙.

### ✅ 한 일
1. **Bento Grid 재배치**: `Dashboard.tsx` 를 6×1 균등그리드 → `.bento-grid`(12칸)로. hero(진행률, span6/row2,
   그라데이션) + small×6(준공 D-day/착공 후/미해결 이슈/투입 인력/장비/통합모델, span2) + chart×2(span6/row2) +
   wide(마일스톤 칩, span12). 반응형 ≤1024 6칸·≤640 1칸.
2. **KPI 카드 + 컬러 시맨틱**: `.kpi-card`(__label/__value.tabular/__meta) + `.kpi--danger/warning/success`.
   준공 D-day 임박도(`ddayKpiClass`: D-30↓ 위험/D-180↓ 주의/그 외 안전)로 색 자동. hero 는 `<progress
   class="progress-bar">`(PDF §4.10). 전 수치 `.tabular`.
3. **Recharts 도입**: `recharts` 설치. 인력 추이=AreaChart(단일 계열, 범례 없음, 그라데이션 fill),
   기성 계획vs실적=LineChart(2계열, **one-axis**). **dataviz 원칙 준수**: 축/그리드=ink 토큰(`--chart-axis/grid`),
   시리즈 색은 **검증 통과 팔레트**(`--chart-1`=brand 실적 solid, `--chart-2`=teal #0D9488 계획 dashed —
   `validate_palette.js` 라이트/다크 ALL PASS) + **색+선유형 이중 인코딩** + 커스텀 HTML 범례. 툴팁 토큰색.
   빈 데이터는 `.empty-state`.
4. **정리**: 옛 `MiniChart` 사용 제거(대시보드), 옛 `.dash-progress/.dash-grid/.dash-stat/MilestoneCard` 경로 삭제.
   /styleguide 에 Bento 대시보드 미리보기 섹션 추가(샘플 데이터, 라이트/다크 both).

### 🔜 다음 할 일 / 미해결
- 축 라벨 클리핑 회피 위해 기성 Y축 `unit="%"` 제거(제목이 % 명시). 실 데이터에서 축 눈금 범위 확인 권장.
- U3(3D 뷰어 UI·V2/V3)는 이번 묶음에 없음 → 후속. U4(다크 마감·모바일 하단탭·모션·a11y)로 진행.
- 번들 5MB 경고(recharts 포함 더 커짐) → Q1 코드 스플리팅 후속 과제.

### 인수인계 한 줄
U2 완료(Bento 대시보드·KPI 컬러시맨틱·Recharts 2차트, dataviz 팔레트 검증). /styleguide 미리보기 OK. U4로.

---
## 📋 U-Shell — 디자인 시스템 Phase 2: 셸 라이트 전환 + 커스텀 12 아이콘 (2026-07-02)
> branch `claude/design-system-phase-1-lgw4oz`(U1 병합된 main 위 재분기). typecheck·build 통과,
> /styleguide 셸 미리보기로 라이트/다크·확장/collapse 확인. 기준: DESIGN_SYSTEM §2·§3·§4 + PDF §5.2.

### ✅ 한 일
1. **커스텀 도메인 아이콘 12종 + 확장 3종**: `src/components/icons/Icon.tsx` — PDF §5.2 실동작 SVG 12개
   (dashboard/schedule/model-3d/schedule-4d/clash/qto/drawing/daily-report/weather/subcontract/board/files)를
   React 컴포넌트로 wrap(Solid Geometric, stroke=currentColor, fill-opacity 0.12, 레드닷=`var(--color-brand-accent)`,
   레드닷 위 흰 체크=`var(--color-text-on-brand)`). 메뉴가 14개라 세트에 없는 협업·이슈/기성내역/구성원은 동일
   톤(레드닷·currentColor)의 확장 아이콘 `issue/billing/members` 신설. size·color props, currentColor 상속.
   ⚠️ weather 는 현재 메뉴엔 없으나 세트 완성 위해 포함(추후 기상 모듈용).
2. **Generic UI 스프라이트**: `src/components/icons/UiIcon.tsx` — chevron-down/-left·folder·bell·sun·moon·plus·x·
   menu·logout 를 `<symbol>` defs 로 묶고 `<use href="#ui-*">` 참조(단일 정의). `<UiIconSprite/>` 를 App 루트에
   1회 마운트.
3. **사이드바 라이트 전환**: `.portal-nav*` → `.app-sidebar`/`.nav-item`(index.css). 배경 `--color-bg-surface`,
   우측 border `--color-border-default`, 기본 텍스트 secondary, hover `--color-bg-subtle`. **활성만 brand 강조**
   (`.is-active` 배경 `#EFF6FF`/다크 rgba(37,99,235,.18), 텍스트·아이콘 brand). NavLink 기본 `aria-current="page"` +
   sr-only "(현재 페이지)".
4. **collapse(240↔64)**: `.portal-body[data-sidebar]` grid-columns 전환(transition), collapse 시 `.nav-item__label`
   숨김·아이콘 중앙정렬. TopBar 메뉴(≡) 버튼으로 토글, localStorage(`mir.sidebar.collapsed`) 기억. 태블릿(≤1024)
   자동 collapse(모바일 하단탭은 U4).
5. **TopBar 56px 재구성**: `.app-topbar` — 사이드바 토글(menu) + 브랜드 + **프로젝트 스위처**(btn--ghost, folder +
   이름 + code + chevron-down → '/') + spacer + 알림(NotificationBell) + 테마토글 + 로그아웃(icon, aria-label) +
   **아바타**(사용자 이니셜). 포털 grid-rows 48→56px(1fr 흡수). icon-only 버튼 aria-label + 내부 아이콘 aria-hidden.
6. **데모**: /styleguide 에 아이콘 갤러리(15종 + UI 스프라이트) + Shell 미리보기(TopBar+사이드바 활성/일반)
   섹션 추가 — 라이트/다크 both 확인.

### 🔜 다음 할 일 / 미해결
- U2(Bento 대시보드·Recharts) → U3(뷰어 UI·V2/V3) → U4(다크 마감·모바일 하단탭·모션·a11y QA).
- 셸이 auth 뒤라 이 샌드박스(Supabase env 없음)에선 실 포털 진입 불가 → /styleguide 미리보기로 검증. 실 로그인
  환경에서 전 메뉴 진입 눈확인 권장(특히 뷰어/자료관리 등 mod-fill 모듈이 56px 토바 아래 정상 배치되는지).
- 옛 `--chrome*`(네이비) 토큰은 doc-viewer-bar·admin-top·백업 Workspace 가 아직 사용 → 보존. 그 화면들의
  라이트 전환은 후속(범위 밖).

### 인수인계 한 줄
U-Shell 완료(사이드바 라이트+활성 brand, TopBar 재구성, 커스텀 12+3 아이콘, UI 스프라이트, collapse). /styleguide
미리보기 라이트/다크 OK. 실 로그인 환경 전 메뉴 눈확인 후 U2로.

---
## 📋 U1 — 디자인 시스템 Phase 1: 토큰 & 공통 컴포넌트 기반 (2026-07-02)
> branch `claude/design-system-phase-1-lgw4oz`. typecheck·build 통과, 라이트/다크 스크린샷 확인.
> 기준 문서 `docs/DESIGN_SYSTEM.md`(+원본 PDF) — 이 문서·PLANNING §0-I 은 기획 브랜치
> `claude/magical-curie-d4relv`(main 미병합)를 본 브랜치에 병합해 포함시킴. **U1 병합 = 문서도 함께 main 입성.**

### ✅ 한 일
1. **토큰 도입(§1 전부)**: `src/index.css` 상단을 신규 토큰으로 재작성 — `--color-*`(브랜드/뉴트럴 11단계/
   시맨틱/서피스/텍스트/보더/뱃지), 타이포(`--font-sans` Pretendard+Inter, `--text-*` 스케일, fw/lh/tracking),
   `--space-1~16`·`--radius-xs~pill`·`--shadow-xs~lg`·모션(duration/ease)·`--z-*`. `[data-theme=dark]` 재정의
   (§1.2 + 그림자 진하게 + 다크 hover 보정 #60A5FA). 기존 다크 토글(localStorage) 로직 무변경.
2. **무중단 마이그레이션**: 옛 S11 토큰(`--bg/--panel/--panel-2/--border/--text/--muted/--accent*/--danger/--radius`)을
   신규 토큰 **alias** 로 연결 → 기존 클래스 전부 그대로 동작하며 팔레트만 신계열로 전환. `--chrome*`(네이비 크롬)은
   U-Shell 전환 전까지 보존. 옛 대형 `--shadow-md` 용례 8곳은 의미에 맞게 `--shadow-lg` 로 이관.
3. **하드코딩 hex 전수 스윕(색 계열)**: index.css 내 토큰 블록 밖 hex/rgba 를 전부 var(--*) 로 치환
   (semantic·on-brand·HUD/좌표축/스냅/도면종류는 보조 토큰 신설: `--hud-*`/`--axis-*`/`--snap-nearest`/`--kind-*`/
   `--color-paper`/`--backdrop`/`--chrome-ghost*`). var() 폴백 hex 정리. 남은 hex = 토큰 정의뿐.
4. **공통 컴포넌트(§3, BEM-lite)**: `.btn`(+primary/secondary/ghost/danger, sm/lg) · `.field`/`.input`(포커스
   `--color-border-focus`·에러·disabled, select/textarea 겸용) · `.card--interactive`(hover -2px+shadow-md)/
   `.card--hero`(그라데이션) · `.badge`(+info/success/warning/error, pill) · `.data-table`(sticky 헤더·hover·
   `th[aria-sort]` 정렬표시·`.col-num` tabular) · `.empty-state`(아이콘+문구+CTA) · `.skeleton`(shimmer,
   reduced-motion 대응) · `.toast`/`.toast-stack`(role=status/alert). 기존 `.cde-table`/`.acc-table` 헤더 bg 를
   표준(bg-subtle)으로 일원화 + cde 행 hover 추가.
5. **레이아웃/a11y**: `.content-narrow`(max-width 960, opt-in — wide 전역 cap 없음 §2 결정) · `:focus-visible`
   outline(마우스 클릭 시 숨김) · `.sr-only` · `.tabular` 유틸. **로그인/프로젝트선택 격자배경 제거** → subtle
   mesh gradient(§6.1).
6. **적용/데모**: `src/components/EmptyState.tsx` 신설, 포털 8곳(이슈/게시판/일보/하도급/기성/멤버/도면/프로젝트
   선택)의 "~없습니다" 텍스트를 empty-state 로 교체 + 프로젝트선택 로딩을 skeleton 으로. **`/styleguide` 데모
   라우트**(StyleGuide.tsx, 데이터 접근 없음)에서 전 컴포넌트·토큰 확인 가능.

### 🔜 다음 할 일 / 미해결
- **U-Shell(Phase2)**: 사이드바 라이트 전환(네이비 폐기·활성만 brand) + TopBar + 커스텀 12 도메인 아이콘(PDF §5.2).
  이후 U2(Bento 대시보드·Recharts) → U3(뷰어 UI·V2/V3) → U4(다크·반응형·a11y QA).
- 화면별 리스킨/spacing px 치환은 U1 범위 밖(색 계열 우선 완료). 이번 토큰화로 라이트 배경이 청회색→중성
  회백(#FAFAFB)으로, 다크가 더 깊은 검정 계열로 미세 전환됨 — 라이브 눈확인 권장.
- ⚠️ 본 브랜치는 **먼저 단독으로 main 병합**(전 화면 공유 CSS). 이후 다른 작업은 rebase.

### 인수인계 한 줄
U1 완료(토큰+alias 무중단 전환·hex 전수 스윕·공통 컴포넌트·격자 제거·/styleguide 데모, typecheck/build/라이트·다크 OK).
빠른 main 병합 후 U-Shell(사이드바 라이트+12아이콘)부터.

---
## 📋 V1 — 3D 뷰어 회전을 "커서(피벗) 기준"으로 (ACC 조작감 일치) (2026-06-30)
> branch `claude/3d-viewer-pivot-rotation-ymsocr`. typecheck·build 통과. 대상 `src/pages/AccModels.tsx` 뷰어 초기화부.
> 통합/4D/간섭은 모두 같은 `AccModels` 초기화 경로를 쓰므로 한 곳 수정으로 세 모드 모두 적용됨.

### ✅ 한 일
1. **(1차) 피벗 기준 회전 옵션 적용**: 줌 옵션(`setReverseZoomDirection`/`setZoomTowardsPivot`) 옆에
   `viewer.navigation.setUsePivotAlways(true)`(회전을 카메라 타깃이 아닌 피벗 기준) +
   `viewer.setClickToSetCOI(true, false)`(클릭한 표면 지점으로 COI/피벗 갱신) 추가.
   (참고 브랜치 `claude/magical-curie-d4relv` 1차 시도를 본 브랜치에 포함.)
2. **(2차) orbit 시작 시 커서 아래 표면을 피벗으로 지정 — 확실한 보강**: `viewer.impl.canvas` 에
   `pointerdown`(capture, 좌클릭만) 리스너 추가 → 캔버스 기준 좌표로 `viewer.impl.hitTest(x,y,false)`
   읽기 전용 히트테스트 → `intersectPoint` 있으면 `viewer.navigation.setPivotPoint(...)`(+ `setPivotSetFlag(true)`).
   빈 공간이면 직전 피벗 유지. `preventDefault` 안 함 → 선택/측정/이슈핀 등 기존 상호작용 회귀 없음.
   언마운트 시 리스너 해제(`pivotCleanupRef`).
3. **더블클릭 포커스**: GuiViewer3D + 표준 확장의 기본 동작(더블클릭=객체 포커스) 그대로 사용(별도 코드 불필요).

### 🔜 다음 할 일 / 미해결
- **라이브 검증 필요(원격 환경 미검증)**: 실제 ACC 모델 로드 후 ① 임의 표면 위 드래그가 그 지점 중심
  회전인지(ACC 체감) ② 빈 공간 드래그=마지막 피벗 ③ 더블클릭 포커스 ④ 선택/이슈핀/측정 회귀 없음.
- 1차 옵션만으로 충분하면 2차(pointerdown)는 무해하게 중복 적용되는 것(둘 다 피벗을 같은 지점으로 맞춤).
  과하다 판단되면 추후 1차만 남기는 정리 가능.
- 범위 밖(후속 V2~V4): 카메라 프리셋(ViewCube/홈/정투영/표준뷰), 표시 품질(엣지/고스트/선택색), 성능.

### 🔁 2차 보강 (라이브 1차 실패 후 — 2026-06-30)
라이브에서 여전히 중심 회전 + ACC엔 마우스 위치에 초록 피벗 구가 보인다는 피드백 반영.
- **원인 가설 2개**: ① 저수준 `navigation.setPivotPoint` 만으로는 orbit 이 그 점을 안 따르고
  초록 인디케이터도 안 뜬다. ACC 는 **`viewer.utilities.setPivotPoint`**(내부 ViewingUtilities)를
  쓴다 — 이게 초록 구를 그리고 orbit 이 실제로 그 점을 피벗으로 삼는 경로.
  ② 리스너를 **캡처 단계**로 걸어 뷰어 자체 mousedown 핸들러가 우리 피벗을 타깃으로 되돌림.
- **수정**: pointerdown(capture) 리스너 제거 → **mousedown(버블) 리스너**로 교체(뷰어 내부 핸들러
  *다음에* 실행되어 덮어쓰기 경쟁에서 이김). 히트 지점을 `viewer.utilities.setPivotPoint(p,true,true)`
  + `pivotActive(true,false)` + `setPivotSetFlag(true)` 로 지정(초록 구 표시 + 피벗 적용).
  유틸 미지원 버전은 `navigation.setPivotPoint` 폴백. 빈 공간은 직전 피벗 유지.
- **✅ 라이브 확인 완료(2026-06-30, 사용자)**: 실 ACC 모델에서 마우스 위치 초록 피벗 구 표시 +
  그 지점 중심 회전 = ACC 동일 체감. **V1 완료.**

### 인수인계 한 줄
회전 피벗 = 커서 기준 완료(2차 보강이 정답: `viewer.utilities.setPivotPoint` + 초록 구 인디케이터 +
mousedown 버블 리스너). 라이브 확인 OK. 후속은 V2~V4(카메라 프리셋/표시 품질/성능).

---
## 📋 S53 — 포털 모듈 본문 풀폭화(가용공간 채우기) (2026-06-30)
> branch `claude/portal-content-full-width-2w4ehl`. typecheck·build 통과.

### ✅ 한 일
1. **`.dash` 래퍼 풀폭화**: `src/index.css` `.dash` 의 `max-width: 1180px; margin: 0 auto`
   제거 → `width: 100%` (패딩 `20px 24px 40px` 유지). 좌·우 빈 여백 제거, 본문이
   사이드바 우측~뷰포트 우단을 채움. **포털 7개 모듈 동시 해결**(사업개요·공사일보·
   기성내역·공정현황·협업이슈·하도급·게시판) + 2D 도면(`.dash draw-page` 상속).
2. **입력 폼 과확장 방지**: `.dash-edit`(폼 카드)에 `max-width: 920px` 추가 →
   일보 등록 등 입력 행은 적정폭, **표·차트·리스트·카드 그리드는 풀폭** 유지.
3. **범위 점검**: Quantities(`.cde-table-wrap`=`flex:1` 이미 풀폭)·Drawings(`.dash` 상속)·
   자료관리(이미 풀폭) 추가 수정 불필요. 3D 뷰어 코드 미접촉.

### 🔜 다음 할 일 / 미해결
- 넓은 모니터 라이브 확인: 각 모듈 본문이 자연스럽게 풀폭으로 채워지는지, 좁은 폭에서
  표 가로 스크롤 정상인지(`.cde-table-wrap` 등 기존 스크롤 유지).

### 인수인계 한 줄
포털 7개 모듈 + 2D 도면 본문을 `.dash` 풀폭화로 정리(입력 폼만 920px 제한). 라이브 폭 확인 필요.

---
## 📋 S52 — 통합모델(3D) APS 전환 · 메뉴 정리 · 홈뷰/관측점 이식 (2026-06-29)
> branch `claude/aps-4d-simulation-euzmdl`. typecheck·build 통과.

### ✅ 한 일
1. **통합모델(3D) → APS(ACC) 뷰어로 전환, IFC 뷰어 제거**: `/model` 라우트를
   `Workspace(IFC)` → `AccModels`(통합 모드)로 교체. `App.tsx`에서 `Workspace` import 제거.
   (구 IFC `Workspace.tsx`·`ViewpointPanel.tsx`는 파일 보존, 라우트만 해제.)
2. **‘ACC 모델’ 메뉴 제거**: `/acc` 라우트 + `ProjectNav` 항목 삭제. ACC 파일 탐색은
   자료관리(`DocumentManager` → `AccBrowser`)로 일원화. AccBrowser의 3D 열기 링크는
   `/acc?urn=` → `/model?urn=` 으로 수정.
3. **세 메뉴 독립 고정 모델**: 통합=`acc_default`, 공정관리(4D)=`acc_4d`, 간섭=`acc_clash`.
   - 마이그레이션 `0031_acc_clash_default.sql`(추가형): `acc_clash_urn/name`.
   - `api.ts` `ProjectAcc`/`EMPTY_ACC`/`ACC_COLS`(+0030/0020 단계별 폴백)에 반영.
   - `AccModels` init: 모드별 pinnedUrn 선택(간섭은 acc_clash 미지정 시 acc_default 폴백).
   - **고정 지정은 자료관리 ACC 모델에서**: `AccBrowser` 모델 ⋮ 메뉴에 "🧊 통합/🏗 4D/🔍 간섭
     고정" 추가(시스템관리자 또는 프로젝트 admin만, urn 있는 변환본만).
4. **홈뷰·관측점 APS 이식(통합모델 전용)**: `lib/apsViewpoints.ts`(localStorage, 프로젝트별
   홈뷰 1개 + 관측점 목록) + `components/acc/ApsViewpointPanel.tsx`(IFC ViewpointPanel의 APS판,
   `viewer.getState()/restoreState()`·`getScreenShot` 썸네일). AccModels 통합 모드 툴바에
   🏠 홈뷰/⬇ 홈뷰 저장/↺ 초기화/📌 관측점. 모델 로드 시 저장된 홈뷰 자동 복원.

### 🔜 다음 할 일 / 미해결
- 라이브 검증: ① 통합 `/model`이 acc_default를 열고 홈뷰/관측점 동작, ② 자료관리에서
  세 용도 고정 후 각 메뉴가 독립적으로 자기 모델을 여는지, ③ 간섭이 acc_clash로 분리되는지.
- 홈뷰/관측점은 현재 localStorage(브라우저 로컬). 팀 공유가 필요하면 DB(viewpoints 테이블) 이관 검토.
- IFC 뷰어 의존 기능 중 추가로 이식할 것은 사용자 요청 시("더 필요한건 나중에").

### 인수인계 한 줄
통합모델을 APS로 전환·메뉴 정리·홈뷰/관측점 이식 완료(0031 마이그 추가). 라이브 테스트로
세 메뉴 독립 고정 + 홈뷰/관측점 확인 필요.

---
## 📋 [기획자 전달] S50 PoC — 4D 시공 시뮬레이션을 APS(ACC) Viewer 위로 이식 (2026-06-26)
> branch `claude/aps-4d-simulation-euzmdl`. typecheck·build 통과. **PoC 단계** — 작은 공정표로
> "스크럽 → 색/표시 변경"까지 동작 확인 필요(라이브 미검증, 코드 리뷰 부탁).

### ✅ 구현
1. **재사용 원칙 유지**: `lib/schedule.ts`·`lib/fourd.ts`(computeStates 등)·`Timeline.tsx` 로직은 그대로.
   단, Timeline.tsx 가 의존하는 뷰어 인터페이스를 `fourd.ts` 에 `FourDViewer`(getElementCatalog/
   applyConstruction/clearConstruction) 로 추출해 **타입만** `IfcViewer` → `FourDViewer` 로 바꿈(동작 변화
   없음, IfcViewer 는 구조적으로 그대로 만족). S49 관례대로 `ElementRef{modelID,expressID}` 의
   expressID 슬롯에 APS dbId 를 그대로 담아 fourd.ts 무수정.
2. **`lib/apsFourdView.ts`(신규)**: `createApsFourDViewer(viewer, model, elements)` — CellState→
   `viewer.hide/show(dbId)`(전역 isolate 대신 **per-object**) + `setThemingColor`(시공중 초록/철거중
   빨강/고스트 회색) 로 변환. 매 틱 `clearThemingColors` 후 재적용(공정표 규모 작아 비용 무시, 추후
   diff 최적화 과제).
3. **`lib/apsScheduleMapping.ts`(신규)**: 매칭 우선순위 ①속성(사용자가 드롭다운에서 매칭 속성 선택 →
   `getBulkProperties2` 로 값 조회 → 공정표 `externalId`/`id`/`name` 후보와 매칭) ②이름(`mapByName`
   재사용) ③순서(`mapSequential` 재사용) — ①이 0건이면 ②, ②도 0건이면 ③.
4. **`AccModels` 에 `mode4d` prop 추가**(`autoClash` 와 동일 패턴) — `/viewer` 라우트를
   `AccModels mode4d` 로 교체(구 `Workspace mode="4d"` 는 코드 보존, 라우트만 이동 — S49 clash 전례
   동일). 헤더에 매칭속성 드롭다운 + "🔗 4D 매칭" 버튼, `Timeline` 을 APS 어댑터와 함께 마운트.
5. **마이그레이션 0029(추가형)**: `task_elements.global_id` 컬럼 + 부분 unique 인덱스. `express_id`
   를 nullable 로(GlobalId 전용 행 허용) + "express_id 또는 global_id 중 하나" 체크. 기존 0003 IFC
   경로(express_id) 는 그대로 보존.
6. **`lib/scheduleApi.ts` 추가형 확장**: `saveApsSchedule`/`saveActiveApsSchedule`(GlobalId 로 저장) +
   `loadSchedule` 이 `global_id` 행도 함께 읽어 `LoadedSchedule.globalElements` 로 분리 + 신규
   `resolveApsTaskMapping`(저장된 GlobalId → 현 세션 dbId 해석, ApsMapping 기반).

### ➕ 추가: 계획 대비 실제 시작 빠름/늦음 시각화(공정 지연)
나비스웍스 TimeLiner의 "초기/후기 모양" 참고해 추가. 작업의 `actualStart` 가 있을 때만(없으면
기존 동작 100% 동일) 진행 중(시공/장비/기타, 철거·임시는 제외) 색이 계획보다 **빠르면 파랑
(`active-early`)**, **늦으면 주황(`active-late`)** 으로 표시됩니다. `fourd.ts`(CellState 2종 추가 +
computeStates 의 진행판정을 actualStart/actualEnd 우선으로) · `viewer/IfcViewer.ts`(AppearanceSettings
colorEarly/colorLate + applyMeshState) · `lib/apsFourdView.ts` · `Timeline.tsx` 설정 패널(색상 픽커 2개)
에 반영. 엑셀 등에서 가져온 실제 시작/끝 컬럼만 매핑되면 바로 동작(별도 작업 불필요).
열 편집·수동 작업 CRUD·Gantt 인라인 끌어서 수정 등 나머지 TimeLiner 작업탭 기능은 "엑셀/P6/MS
Project가 진실원본" 전제와 맞지 않아 **의도적으로 제외**.

### ⚠️ 미완(다음 세션)
- **PoC 검증 안 됨**: 실제 ACC 모델에서 작은 공정표(3~5개) + 속성매칭 1건으로 스크럽 시 색/표시가
  바뀌는지 라이브 확인 필요.
- **APS 4D 모드의 자동저장/복원이 아직 `saveApsSchedule` 경로로 연결 안 됨** — 현재 `Timeline.tsx` 는
  무수정 재사용이라 내부적으로 기존 express_id 경로(`saveSchedule`/`saveActiveSchedule`)를 그대로
  호출한다(`modelIdMap` 을 빈 Map 으로 넘겨 요소 저장은 스킵 — 일정/작업만 저장됨). GlobalId 경로 자동
  연동은 Timeline.tsx 를 손대지 않는 선에서 AccModels 쪽에 별도 저장 버튼/이펙트를 추가하는 식으로
  다음 세션에 마무리 필요.
- **수동 매핑(트리에서 dbId 선택→작업 배정)**: Timeline.tsx 의 기존 "선택 요소 매핑" UI가 이미 동작
  하나, APS 트리 선택(`selDbId`)과의 연결은 미검증.
- **getBulkProperties2 성능**: 대형 모델에서 `collectPropertyNames`/`bulkPropertyValues` 비용 미검증.
- ghosting 전역 제약(S49 동일 메모)은 4D 에선 per-object hide/show 로 회피했으나 라이브에서
  `viewer.hide`/`show` 동작 확인 필요.

### 🤝 인수인계 한 줄
→ PoC 코드(매핑엔진·뷰적용·라우팅·마이그레이션 0029) 작성·typecheck/build 통과·푸시 완료. 다음 세션은
**실 ACC 모델로 작은 공정표 라이브 검증** 부터, 그다음 APS 경로 자동저장/복원 마무리.

---
## 📋 [기획자 전달] S49 종합 — APS(ACC) 위 간섭검토 · 이슈 이식 (2026-06-26)
> branch `claude/blissful-mccarthy-mebctq` (main 대비 14커밋, 충돌 0 · FF 가능). typecheck·build 통과.
> **요지**: ACC 통합모델(nwd) 위에서 우리 고유기능(간섭·이슈)을 **추가 비용 0**으로 자체 구현 완료.
> 식별키를 web-ifc expressID → **GlobalId(=APS externalId)** 로 통일.

### ✅ 완성된 기능
1. **간섭검토(좌측 메뉴 = APS)**: ACC 통합모델 트리에서 **대상 A·B 를 각각 트리로 선택**(파일→부재) →
   fragment+MeshBVH 로 Hard/Clearance 간섭 검출(무료). 결과 목록·그룹(없음/카테고리/모델/상태)·정렬·
   상태칩 필터. **관통깊이는 실측**(상대 솔리드 내부 침투 최대거리, 면접촉≈0은 허용오차로 제외).
2. **결과 시각화**: 행 클릭 시 **간섭 파일만 솔리드(부재 A초록/B빨강) + 다른 파일 완전 숨김**. 툴바
   `전체 표시`/`반투명` 전환.
3. **저장/내보내기**: GlobalId 키로 DB 저장(제목 입력)·불러오기·상태변경 · **CSV(모델=상위 파일명)** ·
   **이미지 포함 HTML 간섭 보고서**(각 간섭 스냅샷 자동 캡처·검토개요/요약표/항목별 상세표).
4. **간섭 → 이슈**: 결과에서 이슈 생성(4컷 자동 캡처 → 원하는 뷰 선택 첨부). 이슈에 A·B 양쪽 앵커 저장.
5. **이슈 핀(3D)**: GlobalId 앵커 → 3D에 SVG 핀(생성순 번호·거리 원근 스케일·켜기/끄기). 클릭 팝업.
6. **위치 보기**: 이슈에서 '위치 보기' → 간섭 이슈는 간섭검토 메뉴로 이동해 **그 간섭뷰(A↔B) 복원**,
   일반 이슈는 해당 객체 isolate+줌. 이슈 탭에 **순차 번호** 표시.

### ⚠️ 운영 적용 필수
- **마이그레이션 0026·0027·0028** 적용(issues.global_id/global_id_b, clashes.global_id_a/b).
- 기존 전제(APS_CLIENT_ID/SECRET·ACC 권한)는 그대로.

### 🔭 남은 일 / 미해결 (기획 판단 필요)
- **결과뷰 '이상안'(상위 파일 반투명 + 다른 파일 숨김 동시)**: APS ghosting이 **전역 설정**이라 표준
  API로는 불가 → 현재 '상위 파일 솔리드 + 다른 파일 숨김'(옵션1)로 적용. per-object 투명 머티리얼
  (저수준 API) 검토는 후속 과제.
- **관통깊이 정밀 시각화**(겹침 부피 하이라이트/관통 화살표): 단순 라벨은 부실해 **보류**(제거함).
- **라이브 검증 필요**(원격 환경에서 ACC 미검증): 대형 모델 카테고리 열거 성능 · getScreenShot 캡처 ·
  단위 m 가정 tolerance · 모델간(다른 파일 A/B) 간섭.
- 자체 IfcViewer 은퇴는 패리티 증명 후(IFC 백업 유지).

---

**[S49-b] 2026-06-25 · 간섭검토 메뉴화 + 모델간 간섭(멀티모델) + 트리 A/B 선택** (branch `claude/blissful-mccarthy-mebctq`)
> 사용자 라이브 검증 결과 **PoC OK**("잘 작동함!! 아주 좋음", 단일 모델 카테고리 간섭 3건 검출·시각화 확인).
> 이후 요청 반영. typecheck·build 통과.
- ✅ **간섭검토 좌측 메뉴(`/clash`) → APS(ACC) 뷰어 clash 모드**(`AccModels autoClash`). 구 IFC Workspace
  clash 는 라우트만 교체하고 코드는 백업 보존(패리티 전 은퇴 금지).
- ✅ **2가지 방법**: ① 고정(열린) 모델에서 바로 간섭, ② **'＋ 파일 추가'**로 ACC 폴더의 비교 파일을 **겹쳐
  로드**(`loadDocumentNode keepCurrentModels`)해 **모델간 간섭**.
- ✅ **대상 A/B 를 ACC 모델 트리처럼 (모델 → 카테고리) 계층**에서 [A][B] 토글로 선택 + 카테고리 검색.
- ✅ **엔진/뷰/영속화 멀티모델 확장**: apsClash 대상=`(model,dbId)`(키 modelId:dbId)·apsClashView
  `showApsClash(aModel/bModel)` 모델별 격리+합집합 fitBounds·clashApi 저장 `mappings(model.id→mapping)`
  GlobalId 해석/로드 다중매핑 검색. AccModels `clashModels` 누적(트리생성 이벤트 모델별 매핑·요소),
  primary 모델은 이슈핀 앵커 유지.
- 📌 **다음/미해결(라이브 확인 권장)**: ① 모델간 겹쳐 로드(aggregate)·`keepCurrentModels` 실동작 ②
  모델간 간섭 시각화(서로 다른 모델 isolate/theming) ③ 대용량(예: 122k 요소) 카테고리 열거 성능(현재
  지연 열거) ④ 간섭 스냅샷 첨부(S35 APS판) ⑤ 카테고리 추출 정교화 ⑥ 단위 m 가정 tolerance.
- **인수인계 한 줄**: → 간섭검토 메뉴=APS, 모델간 간섭·트리 선택 구현·푸시. 다음 세션은 **모델간 겹쳐 로드/
  시각화 라이브 검증**부터.

---

**[S49] 2026-06-25 · 간섭·이슈를 APS Viewer 위로 이식 — 무비용 자체구현** (branch `claude/blissful-mccarthy-mebctq`)
> 우선순위 간섭 > 이슈핀 > 이슈. ACC가 브라우저에 로드한 fragment 지오·dbId·externalId 만으로
> 자체 구현(비용 0). 식별키는 **GlobalId(=externalId)** 로 통일. **마이그레이션 0024·0025는 S48이
> 선점 → 본 세션은 0026·0027 사용.** typecheck·build 통과.
- ✅ **선결(Step 0) — `lib/apsMapping.ts`**: APS `getExternalIdMapping()`(+instanceTree/bulkProperties
  폴백)로 **dbId↔GlobalId 양방향 인덱스** 비동기 구축·모델별 캐시. 이후 전 단계가 의존.
- ✅ **Step 1 간섭(최우선) — `lib/apsClash.ts`**: fragment(LMV 인터리브 VB)를 월드행렬 적용해 읽어
  **dbId별 MeshBVH** 구축 → 광역(AABB 후보)·협역(BVH 교차·관통깊이). 출력은 `clash.ts ClashHit`
  호환(**expressID 슬롯에 dbId**) → groupClashes/정렬/CSV/ClashPanel 패턴 그대로. 시각화
  `lib/apsClashView.ts`(showClash A초록/B빨강+ghost+줌을 setThemingColor/isolate/fitToView 로 1:1).
  영속화 `clashApi.saveApsClashTest/loadApsClashes/loadedApsToRows`(저장키=GlobalId, 0027 a/b 컬럼).
  UI `components/ApsClashPanel.tsx`(카테고리 2단계 선택·검사·저장/불러오기·상태·간섭→이슈).
  요소 열거 `lib/apsElements.ts`.
- ✅ **Step 2 이슈 핀 — `components/ApsIssuePins.tsx`**: global_id 앵커 → dbId bbox중심 → `worldToClient`
  HTML 마커(카메라 이동 rAF 재계산) + 클릭 팝업(기존 이슈 데이터 재사용). AccModels 에 매핑 구축·
  이슈 로드·선택 dbId→GlobalId '＋이슈' 생성·핀/간섭 토글 배선. (0026 `issues.global_id`)
- ✅ **Step 3 위치 보기 — `Issues.tsx`**: global_id 이슈에 '위치 보기(ACC)' → `/acc?focusGlobalId=` 딥링크
  → GlobalId→dbId **isolate+fitToView**. 기존 IFC(model_id/express_id) 위치보기 경로는 백업 유지.
- ⚠️ **운영 적용**: 마이그레이션 **0026·0027** 적용 필요. APS_CLIENT_ID/SECRET·ACC 권한은 기존 전제.
- ⚠️ **라이브 검증 필요(원격 egress 제약으로 미검증)**: 실제 ACC 모델에서 ① fragment VB 추출/BVH 교차가
  맞는지(PoC: 교차 1건) ② getExternalIdMapping 의 externalId 가 IFC GlobalId/Revit UniqueId 로 잘
  나오는지 ③ worldToClient 핀 좌표·setThemingColor/isolate/fitToView 동작. 막히면 즉시 공유 권장.
- 📌 **다음/미해결**: ① **PoC 라이브 검증**(작은 ACC 모델 교차 1건) ② 간섭 스냅샷 첨부(S35 captureClashViews
  의 APS 판) ③ 카테고리 추출 정교화(현재 Revit 'Category'·이름 추정 — IFC 타입 정확도 점검) ④ 모델 단위가
  m 아닌 경우 tolerance 환산 ⑤ 자체 IfcViewer 은퇴는 패리티 증명 후(IFC 백업 유지).
- **인수인계 한 줄**: → S49 간섭·이슈핀·위치보기 코드 이식 완료(0026·0027)·푸시. **다음 세션은 ACC 라이브에서
  PoC(fragment BVH 교차 1건)부터 눈검증** 후 스냅샷 첨부·카테고리 정교화로 진행.

---

**[2nd 계정·병렬] 2026-06-24 · S47/S48 main 병합 + Track B 전부 완료** (branch `claude/affectionate-babbage-qxs2ry`)
- ✅ **선결 — S47/S48 main 병합 (PR #89, merge `5de0d40`)**. funny-bardeen이 main의 fast-forward라 충돌 0,
  CI(typecheck·build) 통과 후 병합. 이제 두 트랙 모두 현재 main에서 분기 가능. (마이그레이션 0024·0025는 S48이
  이미 사용 → Track A는 0026~, Track B는 0030~ 권장.)
- ✅ **B1 — 모듈별 편집 게이팅 정정**: 이슈·공정·일보·기성·하도급·게시판·도면의 쓰기 UI가 글로벌 `is_admin`
  (시스템관리자)에 묶여 실무자/프로젝트관리자가 편집 불가하던 회귀 수정 → `useProjectRole().canEdit`(RLS 0023
  `is_editor`와 일치). 공유 컴포넌트 Attachments·DrawingSheet prop `isAdmin`→`canEdit` 명칭 정정.
- ✅ **B2 — 이미 완료 확인(작업 불필요)**: ProjectMembers.tsx가 `canManage`(프로젝트관리자+시스템관리자) 게이팅,
  RLS 0023 `members_*`가 `is_project_admin` 허용, ProjectNav 링크도 `manageOnly`. S48 9a2166c에서 구현됨.
- ✅ **B3 — ACC 새 버전 올리기 UI**: lib·서버는 이미 `itemId`로 버전 생성 지원했으나 진입점이 없었음 → ⋮메뉴 +
  버전이력 모달에 '새 버전 올리기'(canEdit). `uploadToAcc(fileName 오버라이드)`로 원본 이름 유지. 이동·버전이력은
  기존 유지.
- ✅ **B4 — pptx 미리보기 뷰어**: PptxViewer(pptx-preview, 순수 프론트·외부전송 없음) 추가, ViewerKind+매핑,
  AccBrowser·FileViewer 배선. **PDF 페이지 네비/점프/썸네일은 이미 완비**라 그대로 둠.
- ✅ **B4 후속(리뷰 반영) — 문서 뷰어 Office Online 일원화**: pptx-preview 화질이 ACC 대비 떨어져, 사용자
  결정으로 **Office 포맷 전부(doc·docx·ppt·pptx·xls·xlsx·xlsm)를 Microsoft Office Online 전체 뷰어
  (view.aspx)로** 통일(`OfficeViewer`, pptx-preview 제거). **풀스크린 인라인**(문서 오버레이 `fixed inset:0
  z-index:500`)으로 ACC와 동일한 풀 메뉴바·슬라이드쇼. csv만 자체 표 뷰어 유지. 공개 Autodesk/Supabase 서명
  URL만 Office에 전달(우리 JWT 미노출).
- ✅ **ACC 모델 뷰어 ✕ 닫기** 추가(DWG 등 모델 열람 후 자료관리로 복귀). 폴더트리 정리는 Track A 영역.
- ⚠️ **Office 뷰어 파일명(UUID) 한계**: Office Online 은 src URL 마지막 경로(=Autodesk 저장소 UUID)를 이름으로
  표시. (1) 우리 도메인 경유 capability URL = Vercel **프리뷰 SSO 보호**로 외부(MS) 접근 불가, (2)
  response-content-disposition 주입 = Office 가 렌더 거부 → **프리뷰에서 안전 수정 불가**. 실제 파일명은 우리
  오버레이 헤더+다운로드 링크로 표시. **프로덕션(SSO 없음)에선 capability 방식이 동작할 수 있어 병합 후 재시도 여지**.
- ⚠️ **인계(라이브 검증 필요)**: B3의 ACC 새 버전·이동 실제 쓰기(S3 PUT/CORS/version 생성)는 **운영에서 폴더
  편집권한 부여 후 검증** 필요(기존 코드도 동일 주의). Quantities.tsx의 proposeBilling 게이트는 Track A S51
  영역이라 system-admin 유지(인계).
- **인수인계 한 줄**: → 2nd 계정 Track B(B1~B4) 완료·푸시. 메인 계정은 S49부터 직렬 진행. 운영: 0022·0023·
  0024·0025 적용 + 멤버 role 부여 + ACC 폴더 편집권한 부여.

---

**[기획세션] 2026-06-24 · 전환 후 로드맵 직렬/병렬 분리** (branch `claude/magical-curie-d4relv`,
S47/S48 위에 기획만 추가). 토큰 분산용 **2nd 계정 병렬 가동** 대비, 남은 일을 두 트랙으로 분리 → **PLANNING §0-B**.
- **선결(1회)**: **S47/S48을 main에 병합** 후 두 트랙 분기(지금 main은 S46까지라 미병합 시 양쪽 깨짐).
  마이그레이션 번호 사전배정 **A=0024~ / B=0030~**.
- **🅰 직렬(이어서·메인)**: ACC 모델 위로 고유기능 이식 — S49(dbId↔GlobalId 매핑 + **4D/간섭 ACC 소스화로
  신규 BIM 업로드 부재 해소** + 이슈핀) → S50(4D) → S51(물량) → S52(간섭 스파이크) → S53(IfcViewer 은퇴).
  전부 뷰어/Workspace/매핑 공유라 직렬.
- **🅱 분리(2nd 계정)**: B1 모듈별 canEdit 게이팅 점검 · B2 프로젝트 관리자 역할배정 권한 · B3 ACC 파일관리자
  보강(이동·새버전·라이브검증) · B4 비-3D 뷰어 quick wins(pptx·PDF네비). 포털/Admin/AccBrowser/문서뷰어만
  건드려 A와 파일 분리.
- **충돌 회피**: 파일 footprint 분리 + 마이그레이션 번호 분리 + STATUS/ROADMAP는 각자 섹션. B부터 자주 병합, A는 수시 rebase.
- **회귀 인지**: S48에서 BIM 업로드 UI 제거 → 신규 모델 등록 경로 부재(기존 모델 동작) → S49가 ACC 소스화로 해소.
- **인수인계 한 줄**: → S47/S48 병합 후, 메인=S49부터 직렬 / 2nd 계정=B1·B3 우선 착수.

---

## S48 결과 (branch: claude/funny-bardeen-d9s1af) — 권한 4단계(RBAC) + 자료관리 ACC 단독·파일관리자 UI
> 사용자 결정: ① 권한을 **뷰어/실무자(editor)/관리자(admin)/시스템 관리자** 4단계로(전 모듈). ② 자료관리는
> **ACC 단독**(Supabase '앱 저장소' 탭 제거). ③ ACC를 ACC식 파일관리자 UI로 재구성. typecheck·build 통과.
- ✅ **Phase 1 — RBAC 백본(`0023_rbac.sql` + 전 모듈 RLS)**: `is_editor(p)`/`is_project_admin(p)`/
  `user_is_system_admin()` 헬퍼. `project_members.role`(0001부터 존재: viewer/editor/admin) + `profiles.is_admin`.
  전 콘텐츠 테이블 쓰기 RLS를 `is_editor`로, 설정·역할은 `is_project_admin`/시스템관리자로. **D11 폐기 → D20**.
- ✅ **Phase 2 — 프론트 배선**: `src/auth/useProjectRole.ts`(role·canView·canEdit·canManage·isSystemAdmin).
  관리자 콘솔에서 멤버별 역할 부여(한글 라벨 뷰어/실무자/관리자/시스템 관리자). 업로드/항목작업 서버 게이트도
  `mirProject` 기준 editor 이상으로(0023).
- ✅ **Phase 3 — ACC 파일관리자 UI(`components/acc/AccBrowser.tsx` 전면 재작성)**: **좌측 폴더트리 +
  우측 파일표**(체크박스 다중선택·이름·상태뱃지·수정일·⋮ 메뉴) + **툴바**(브레드크럼·검색·⬆업로드·⟳) +
  **일괄작업줄**(다운로드·삭제). 파일 분기 유지(모델=APS Viewer 페이지 / 문서=우리 뷰어 오버레이 / 미디어=서명URL).
- ✅ **Phase 4 — ACC 항목 작업(`api/aps-item.ts` + `lib/aps.ts`)**: **이름변경**(PATCH displayName)·**삭제**
  (Deleted 확장 버전=휴지통)·**이동**(PATCH parent, ACC 환경따라 미지원 가능)·**버전 이력**(읽기)·**다운로드**
  (원본 바이트, 실무자+). `aps-acc` contents에 수정일 + `versions` 액션 추가. 모두 editor 게이트.
- ✅ **권한별 UI**: 뷰어=탐색·미리보기만(업로드/다운로드/편집 버튼 숨김), 실무자+=전체 파일작업. 모델은 SVF2
  스트리밍이라 원본 원천 차단, 문서는 다운로드 버튼 숨김(소프트, D20).
- ✅ **자료관리 = ACC 단독**(`DocumentManager` 박형 래퍼로 축소). Supabase 문서/BIM 탭 제거.
- ⚠️ **회귀 주의(사용자 인지)**: 통합모델(3D)/4D/간섭은 아직 Supabase BIM 파이프라인(lib/api·cde) 의존 →
  **그 코드는 보존**. 단 자료관리에서 BIM(IFC) 업로드 UI가 사라져 **4D/간섭용 신규 BIM 업로드 경로는 일시
  부재**(기존 모델은 동작). ACC 위로의 4D/간섭/이슈핀 이식은 후속(S50/S52).
- ⚠️ **운영 적용**: `0023_rbac.sql` 적용(+ 멤버 role 부여) · `APS_CLIENT_ID/SECRET`(기존) · ACC 폴더에 통합 앱
  **편집 권한**(업로드/이름변경/삭제/이동 전제) · `0022` 적용. ACC 쓰기(업로드·이동)는 **라이브 검증 필요**.
- 📌 **다음/미해결**: ACC 업로드·이동 라이브 검증(폴더 권한 후) · 새 버전 업로드 UI · 트리 폭 리사이즈 ·
  4D/간섭 BIM 소스를 ACC로 이식(S50/S52) · 모듈별 편집 UI가 canEdit 게이팅 빠짐없는지 점검.

## S47 결과 (branch: claude/funny-bardeen-d9s1af) — 자료관리 ACC 일원화(업로드까지) + Supabase 읽기 공존
> 신규 업로드 저장소를 ACC 로 일원화(업로드 = ACC Data Management write). 기존 Supabase docs 자료는 계속 열람.
> 추가형 마이그레이션 **0022**. typecheck·build 통과. (※ 작업 브랜치는 세션 지정 `claude/funny-bardeen-d9s1af`
> — 태스크 본문의 feature/acc-storage 대신 시스템 지정 브랜치 사용.)
- ✅ **0단계 스파이크(코드 전)**: APS 업로드 = storage 생성 → S3 서명 업로드(브라우저 직접 PUT) → item(신규)/
  version(기존) 생성. **결론(D19)**: **2-legged 로 가능** — 단, 커스텀 통합 앱(Client ID)이 대상 ACC 폴더에
  **편집/업로드 권한**을 받아야 함(S46 은 읽기만 승인). 읽기는 검증됨. 쓰기는 **운영에서 폴더 권한 부여 후
  실제 업로드 검증 필요** — item/version 이 403 이면 폴더 권한 미부여이거나 3-legged 필요(그때 사용자 보고·범위 재조정).
- ✅ **`api/aps-upload.ts`**(2-legged 브로커, edge): `begin`(storage+서명URL) / `complete`(S3 확정 + item/version).
  바이트는 우리 서버를 거치지 않고 S3 직행(대용량 모델 대비·진행률). 스코프 `data:read data:create data:write`.
  호출 게이트 = 로그인 + **관리자(D11)**.
- ✅ **`src/lib/aps.ts`**(공유 헬퍼): `getApsToken`·`accFetch`·`accFileBlobUrl/RedirectUrl`·`uploadToAcc`
  (begin→S3 PUT XHR 진행률→complete)·`isAccModel`. S46 AccModels 의 토큰/프록시 로직을 재사용 가능한 모듈로.
- ✅ **`components/acc/AccBrowser.tsx`**: 자료관리 안의 ACC 탐색기 — S46 펼침 트리(지연로드·자연정렬·시작폴더
  고정) 재사용 + 파일 분기(모델→`/project/:id/acc?urn=` APS Viewer / 문서·이미지·오피스·텍스트→우리 뷰어 /
  미디어→서명URL). 폴더별 **⬆ 업로드**(관리자) → ACC 쓰기 + 진행률 + 트리 자동 갱신 + '업로드됨(ACC)'.
- ✅ **`DocumentManager`**: 상단 **저장소 탭(📁 앱 저장소 / 🅰 ACC 자료)**. 앱 저장소 = 기존 Supabase 문서/BIM
  (회귀 없음·읽기 공존), ACC = AccBrowser. 신규 업로드는 ACC 로 유도.
- ✅ **`0022_acc_storage.sql`**(추가형): `files.source`('supabase'|'acc', 기본 supabase) + `acc_item_urn`/
  `acc_version_urn` + `storage_path` nullable + `(project_id,source)` 인덱스. `cde.ts`: `listCdeFiles` 가
  source='supabase' 만(0022 미적용 시 필터 없이 폴백) + `recordAccUpload`(ACC 업로드 메타 행 — 상태/활동로그가
  ACC 파일을 가리킴, 새 버전이면 갱신) + `listAccFileMeta`(ACC 아이템 URN→상태 뱃지). RLS=0009(쓰기 admin)/0014 상속.
- ✅ 검증: `typecheck`·`build` 통과. 색은 토큰만(`--accent`/`--accent-fg`/`--panel-2`/`--muted`/`--border`).
  setup_all.sql 을 0003~0022 로 보강(0020/0021 누락분 포함).
- ⚠️ **운영 적용 필수**: ① Vercel env `APS_CLIENT_ID`/`APS_CLIENT_SECRET`(이미 S46). ② **ACC 대상 폴더에 통합 앱
  쓰기 권한 부여**(없으면 업로드 403). ③ `0022_acc_storage.sql` 적용(미적용 시 ACC 업로드는 되지만 메타 행 미기록).
- 📌 **다음/미해결**: ACC 직접 업로드 **라이브 검증**(폴더 권한 부여 후 실제 PUT/CORS·item 생성 확인) · ACC 새 버전
  업로드 UI(현재 신규 업로드 위주) · CDE 상태/이슈첨부를 ACC 메타 행에 더 깊게 연결(S43/S49) · S3 PUT CORS 가
  막히면 서버 청크 프록시 폴백 검토.

## (이전) S46 APS/ACC 뷰어 전환 — 1단계(외부 계정 없이 ACC 모델 조회)
**마지막 업데이트**: 2026-06-23 · **S46 APS/ACC 뷰어 전환 — 1단계**(외부 계정 없이 ACC 모델 조회).
- **배경/결정(D18)**: 자체 ThatOpen 뷰어로는 텍스처·대용량·rvt/nwd 네이티브를 무료로 풀기 어려움.
  사용자가 ACC 구독 보유 → **APS Viewer + ACC(2-legged) 임베드**로 전환 확정. **추가 비용 0**
  (ACC가 자동 변환한 결과를 우리 앱이 읽기만 함 — 인증·DM·SVF2 스트리밍 무료). 외부 사용자는
  **오토데스크 계정 불필요**(우리 서버가 토큰 브로커, MIR 로그인만으로 조회 → ACC 좌석 미소모).
- **1단계 완료(branch feature/aps-viewer)**: 서버리스 2-legged 토큰(`api/aps-token.ts`) +
  Data Management 프록시(`api/aps-acc.ts`) + 프로젝트 메뉴 **🅰 ACC 모델**(`/project/:id/acc`,
  `pages/AccModels.tsx`: 허브→프로젝트→폴더→모델 선택, 변환된 URN 자동 해석). 사용자 검증 OK
  (쌍용건설 허브에서 모델 로드·텍스처·성능 확인). typecheck·build 통과.
- **운영 전제**: Vercel env `APS_CLIENT_ID`/`APS_CLIENT_SECRET`(Preview·Production), ACC 사용자
  지정 통합에 앱 Client ID 승인(완료). 자체 변환(OSS) 안 함 → 변환 크레딧 미소모.
- **1-b 완료(같은 브랜치)**: ① 색감을 앱 테마 토큰으로 통일 + 뷰어 배경 다크. ② **프로젝트별
  ACC 고정**(`0020_acc_mapping.sql`: projects.acc_hub_id/acc_project_id/acc_default_urn/
  acc_default_name) — 관리자가 허브·프로젝트를 MIR 프로젝트에 고정·기본모델 지정, 일반 사용자는
  그 범위만 보고 기본모델 자동 오픈(드롭다운 숨김). `getProjectAcc`/`setProjectAcc`(api.ts).
- **사용자 결정**: 파일 저장소를 **ACC로 일원화**(자료관리=ACC 폴더, 업로드도 ACC로 → 동기화
  불필요·비용 0). Supabase 문서 저장은 폐기 방향. → **다음 작업**.
- **1-c**: ACC 탐색을 **펼침 트리(접기/펴기·지연로드)**로 교체(브레드크럼 대신 상위 자유 이동) +
  폴더/파일 **자연 정렬**(1,2,…,10,11) + 시작 폴더 고정(`0021`, 폴더 옆 📌). FolderNode 트리.
- **1-d**: ACC 파일 종류별 분기 — 모델(rvt/nwd/ifc/dwg…)=APS Viewer, 문서(pdf/이미지/엑셀/
  워드/텍스트)=**우리 뷰어**(ACC 원본 바이트를 `api/aps-file` 가 프록시→blob, CORS 회피),
  영상/오디오=서명URL 302 리다이렉트, 그 외=다운로드 폴백. PDF 뷰어에 **썸네일+페이지넘김**
  추가(pdf.js). 표준 APS 확장 묶음(측정·단면·마크업·시트 등) 로드 + 다중페이지 자동 '시트 및 뷰'.
- **운영**: `0020_acc_mapping.sql` + `0021_acc_root_folder.sql` 적용 필요(미적용 시 매핑 null 폴백).
- **다음**: (a) **자료관리를 ACC 폴더로 전환**(업로드=Data Management write, scope data:create/write
  추가) (b) 2단계 기능 이식: 이슈 핀 → 4D → 간섭 → 물량을 APS Viewer 위로 → IfcViewer 은퇴.

**(이전) S45 뷰어 고급기능 3차**(좌표오프셋·diff색상/투명도·업로드 진행률).
- **공통 좌표 오프셋**(#80): 여러 모델이 원점에 겹쳐 쌓이던 버그 → 첫 모델 기준 공통 sceneOffset 으로 상대 실좌표 보존.
- **버전 diff 색상/투명도**(#80): 신규=청록·삭제=주황·동일=회색(간섭/이슈색 회피) + 추가/삭제/동일 투명도 슬라이더.
- **업로드 진행률 0~100%**(#81): createSignedUploadUrl + XHR(FormData) 로 onprogress.
- **답변(코드 아님)**: 추가의견4 용량제한=Supabase 전역/플랜 설정(코드 측 제한 없음, Free 파일당 50MB·총 1GB). 추가의견3 렉=드로콜(요소당 mesh)·DOM 리스트 → 지오메트리 머지+가상화 권장(별도 성능 패스).
- **다음**: #6 단면 자르기·단면 박스(기즈모) **또는** 성능 패스(지오메트리 머지/가상화) 중 택1.

**(이전) S45 뷰어 고급기능 2차 완료**(스냅·측정확장·공간트리·버전diff 등).
- **#1 오버레이 틴트·#2 최신버전·#5 측정 라벨 세련화**(#72) · **#3 공간(층·부재) 트리**(#73, 카테고리/공간 토글).
- **#4 측정 스냅**(#74) + **속성검색**(#74) → **보완1 스냅 옵션·종류별 마커**(#75, 정점/중간점/면중심/근처점).
- **추가의견4 뷰포인트에 객체숨김 저장**(#76) · **추가의견3 측정 확장(각도·면적·연속)**(#77) · **추가의견1 버전 diff**(#78, GlobalId 추가/삭제 하이라이트).
- **다음**: **#6 단면 자르기(면 클릭 절단) + 단면 박스(위치지정·이동/회전 기즈모·옵션패널)**. 후속(선택): 객체트리 가상화, overlay 식별 강화.

**(이전) S45 뷰어 추가요청 1·2·3·4 + B-2 완료**.
- **추가1 원형 단면**(#66): `CIRCLE_SEGMENTS` 12→24.
- **추가3 속성정보 팝업**(#66): IFC 속성세트/수량세트를 **세트명별 그룹**으로 묶어 접기·크기조절 팝업.
- **추가2 객체 트리 + 추가3 양방향 연동**(#67): 객체 트리(카테고리 묶음·눈 토글)·객체↔3D 선택 연동·사이드바 좌우/상하 리사이즈.
- **사이드바/팝업 핸들 보완**(#69): 사이드바 우측 드래그 핸들 + 속성팝업 핸들 좌하단.
- **추가4 툴바 그룹화**(#70): 표시/도구/뷰/정보 드롭다운 메뉴(`ToolbarMenu`).
- **B-2 버전 전환·중첩**(this): BIM 모델 행에 '버전 ▾' → file_versions 목록, **표시 버전 전환**(언로드+재로드, 같은 DB id 재매핑)
  + **중첩(overlay)** 체크(추가 모델로 겹쳐 로드). `IfcViewer.unloadModel` 추가.
**운영 필수**: 0019 마이그레이션 DB 적용(B-1/B-2 연동 전제). **문제4**: BIM 파일 삭제 시 연동 models 자동 제거, 레거시분은 대시보드 정리.
**후속(선택)**: B-2 열린 화면 자동 갱신(현재 재진입 반영) · 객체 트리 spatial 계층화 · overlay 식별 틴트.
**(이전) B-1**(#65): 자료관리 BIM 폴더 IFC → 통합모델 자동 연동(`bucket='docs'`), 별도 업로드 제거, 폴더별 그룹 미러.
**(이전) S44.1/1·2·3**: 좌표 매핑+HUD X/Y/Z · 메뉴별 시작뷰 리셋 · 격자 제거 · 원점=모델원점(#61,#64).

**(이전) S44 통합모델(3D) 뷰 환경·탐색 UX 완료**:
시작 카메라 근접+홈뷰 저장/복원 · 호버 좌표 HUD(프로젝트 좌표) · 격자/원점 인디케이터 토글 ·
이슈 핀 비주얼(물방울 빌보드+번호+상태색+펄스) · 통합모델 트리 정리(문서·미디어 제거, 카테고리 검색·일괄토글).
마이그레이션 **없음**(순수 프론트엔드). typecheck·build 통과.
**다음 착수가능**: 측정 스냅(S45) · 단면 박스/기즈모(S46) · 렌더 스타일(S47) · 마크업 3D 앵커(S48) ·
**S43 CDE 고도화(승인·자료전송)**(§13) · 단가 DB(물량→금액 자동). (대기) S38 Word양식 · S17 APS.

## S44.1 결과 (branch: claude/youthful-meitner-20zonx) — 뷰어 피드백 수정 (문제1·2·3)
> 사용자 피드백 5건 중 즉시 수정 가능한 3건. 마이그레이션 없음. typecheck·build 통과.
- ✅ **문제1 좌표 불일치**: 호버 HUD 값이 Revit 프로젝트 기준점(북/남·동/서·높이)과 축이 달라 보이던 문제.
  실측 결과 이 교량 IFC는 **Y-up**으로 원시축이 `(동서 X, 높이 Y, −남북 Z)`. `worldToProject`가 Y-up일 때
  `(x, −z, y)`로 재매핑 → `x=동서·y=남북·z=높이`(EL). HUD 라벨 X/Y/Z→**동서/남북/EL**. (Z-up 모델은 그대로 통과.)
- ✅ **문제2 원점 버튼 무반응**: georef 모델은 IFC 원점(0,0,0)이 모델에서 수백 km 떨어져 인디케이터가 항상
  화면 밖이라 안 보였음. `setOriginVisible`을 **모델 좌표 원점(group local 0,0,0의 월드위치)**에 배치 →
  지오메트리 위/근처에 표시. 툴팁도 "모델 원점·좌표축"으로 수정.
- ✅ **문제3 시작뷰 공유**: 홈뷰 키를 `mir.homeview.<projectId>.<mode>`로 **메뉴별 분리**(통합/4D/간섭 각자).
  로드시 모듈별 홈뷰 복원, 없으면 frameAll. **시작뷰 저장 버튼을 전 모듈 노출**(admin). 기존 무접두 키는 통합모델에 한해 자동 마이그레이션.
- 📌 **문제4·5 미결정** → 아래 S44.2.

## S45 결과 (branch: feature/cde-bim-folders) — 문제5 Phase A: CDE 문서/BIM 분리 + 연동 기반
> 자료관리(CDE) 폴더트리 최상위를 **문서 / BIM 데이터**로 분리(사용자가 처음 요청한 가시적 절반) + 통합모델 연동을 위한
> 데이터모델 기반. **추가형 마이그레이션 0019**. typecheck·build 통과. (Phase B = 3D 미러/버전 전환·중첩은 후속.)
- ✅ **마이그레이션 0019_bim_folders.sql**: `folders.kind`('doc'|'bim', 기본 doc, check 제약) + `(project_id,kind)` 인덱스.
  `models.file_id`/`version_id`(fk, nullable) + `models.bucket`(기본 'models') — Phase B에서 통합모델이 CDE BIM
  파일/버전을 가리키기 위한 컬럼(지금은 추가만, 동작 불변). 프로젝트별 **'BIM 데이터' 최상위 폴더 시드**(없을 때).
  **`storage_models_delete`(admin) 정책 추가** — 관리자 모델 완전삭제 가능(문제4 기반).
- ✅ **cde.ts**: `FolderKind`·`Folder.kind` 추가, `listFolders`는 0019 미적용시 'doc' 폴백. `createFolder(.,.,.,kind)`로
  하위 폴더가 **부모 kind 상속**(BIM 서브트리 유지). `ensureBimRoot(projectId)`(idempotent, admin 진입시 보장).
- ✅ **FolderTree**: `rootLabel`·`showRoot` props 추가(문서=미분류 루트 표시, BIM=루트 숨김·실폴더만).
- ✅ **DocumentManager**: 사이드바를 **📄 문서 / 🧊 BIM 데이터 두 섹션**으로 렌더(종류별 트리). 새 폴더는 현재 폴더 kind
  상속, BIM 섹션 업로드는 `accept=".ifc"` + 버튼 라벨 'BIM 업로드(IFC)'. 진입시 `ensureBimRoot`.
- ✅ **api.ts**: `downloadModelBytes(path, bucket='models')` — 버킷 인자 추가(Phase B에서 'docs' 버킷 IFC 로드용).
- ✅ 검증: `typecheck`·`build` 통과. 색은 토큰만(`.cde-tree-section-label`은 `--muted`).
- ⚠️ **운영 적용 필수**: 0019 마이그레이션을 Supabase에 적용해야 함(folders.kind 등). 미적용시 cde.ts가 'doc' 폴백.

## S45 Phase B-1 결과 (branch: feature/cde-bim-3d) — CDE BIM ↔ 통합모델 연동(단일 소스)
> 통합모델 소스를 **CDE BIM 파일로 일원화**. 별도 업로드 제거. 추가 마이그레이션 없음(0019 컬럼 사용). typecheck·build 통과.
- ✅ **api.ts**: `ModelRecord`에 `bucket`/`file_id`/`version_id` + `normalizeModel`(폴백 시 기본값). `listModels`/`getModel`
  3단 폴백(0019→0016→legacy). `syncBimModel(file)`(file_id 기준 upsert: insert/repoint, purpose='integrated',
  bucket='docs'), `deleteBimModel(fileId)`. `uploadModel`/`downloadModelBytes(path,bucket)` 정규화.
- ✅ **cde.ts**: `getCdeFile(fileId)`, `listProjectFiles(projectId)`(id/folder_id/name) 추가.
- ✅ **DocumentManager**: BIM 폴더에 IFC 업로드/새버전 → `syncBimModel`로 통합모델 행 생성·repoint, 삭제 → `deleteBimModel`.
  업로드 성공 메시지에 '통합모델 연동됨' 표기.
- ✅ **Workspace(통합모델)**: `loadOne`이 `m.bucket`에서 바이트 로드(docs/models). 좌측 "모델" 패널을 **BIM 폴더별 그룹
  미러**(`modelGroups`: 폴더 풀패스 라벨, file_id 없는 레거시는 '기타(미연동)'). **별도 IFC 업로드 버튼 제거** → '자료관리(BIM)에서
  업로드' 힌트. 진입/모드전환 시 `refreshBimTree`로 폴더·파일 매핑 로드.
- ✅ 검증: `typecheck`·`build` 통과. 색 토큰만(`.model-group*`).
- ⚠️ **0019 미적용시**: bucket/file_id 컬럼이 없어 연동 비활성(기존 동작 유지). 운영 DB에 0019 적용 필요.
- 📌 **Phase B-2(남음)**: 버전 V1/V2 **전환·중첩 UI**(file_versions는 이미 있음, models.version_id repoint로 전환),
  열린 상태에서 **자동 갱신**(현재는 메뉴 재진입 시 반영), 모델 그룹 트리화(현재 폴더 풀패스 1-레벨 그룹).

## (참고) S45 Phase B 원안 — 통합모델(3D) ↔ CDE BIM 미러 + 버전 전환/중첩
> Phase A 위에서 통합모델 소스를 **CDE BIM 파일로 일원화**. 별도 업로드 제거 → 문제4 자동 해소.
- **목표**: 통합모델 좌측 "모델" 패널 = CDE **BIM 데이터 폴더트리 미러**. 파일 선택시 메인뷰 로드·**누적 유지**.
  CDE에서 새 버전 올리면 3D **자동 갱신**, **버전 이력**(V1/V2…) 전환 + **중첩표시**(V1·V2 동시).
- **방식(저위험)**: BIM 폴더에 IFC 업로드시 `models` 행을 함께 생성(`file_id`/`version_id`/`bucket='docs'`로 연동) →
  기존 통합모델/4D/간섭/이슈 파이프라인(`models.id` 참조)을 **깨지 않고** 유지. `downloadModelBytes(path,'docs')`로 로드.
  버전 전환 = 연동 행의 `version_id`/`storage_path` 갱신 후 재로드, 중첩 = 이전 버전 바이트를 추가 모델로 로드.
- **주의(설계 결정 필요)**: 통합모델 모델 식별자를 CDE file로 바꾸면 **이슈 `model_id` 재연결** 필요 →
  위 '모델 행 동반 생성' 방식이면 회피 가능. 자동 갱신은 폴링/실시간 구독 택일.
- **문제4 답(현행)**: 통합모델 파일은 `models` 테이블 + `models` 버킷(`<project_id>/<model_id>.ifc`). 행 DELETE RLS=admin,
  0019로 **스토리지 delete(admin)도 추가**. 앱 내 삭제 UI는 아직 없음 → **Supabase 대시보드**에서 `models` 행 + Storage
  객체 삭제로 정리(사용자가 직접). Phase B에서 CDE로 일원화되면 자료관리에서 삭제로 통합됨.

## S44 결과 (branch: claude/youthful-meitner-20zonx) — 통합모델(3D) 뷰 환경·탐색 UX
> 통합모델 3D 뷰어의 시작 카메라·좌표 HUD·뷰 헬퍼·이슈 핀·트리 UX 개선. 마이그레이션 없음(순수 프론트엔드). typecheck·build 통과.
- ✅ **공통 선작업(IfcViewer)**: `LoadedModel.offset`(로드시 빼낸 재중심 평행이동) 저장 + `worldToProject(modelID, p)`
  = `group.worldToLocal(p).add(offset)` — 월드점을 IFC 원본 프로젝트 좌표로 역변환(그룹 up-axis 회전 후 offset 가산).
- ✅ **시작 카메라 + 홈뷰**: `frameBox` 기본 factor 1.8→1.2(객체가 화면을 더 채움) + `frameAll()` 공개. 자동 로드
  완료 후 통합모델은 `mir.homeview.<projectId>`(localStorage, S37 `getCameraState`) 있으면 복원, 없으면 `frameAll()`.
  툴바 **🏠 시작뷰로**(전원) + **시작뷰 저장**(admin·통합모델). 4D/간섭도 마지막 모델이 아닌 전체로 맞춤.
- ✅ **호버 좌표 HUD**: `setOnHover(cb)` + mousemove(rAF 1회/프레임 스로틀) — 히트시 `worldToProject`로 프로젝트
  좌표, 빈 공간=null. Workspace 우하단 `.coord-hud`(X/Y/Z 소수 3자리·축색, 빈 공간=—).
- ✅ **격자·원점 토글**: `GridHelper`를 `this.grid`로 보관·기본 숨김 + `setGridVisible`. 원점은 프로젝트 원점
  (`group.localToWorld(-offset)`)에 `AxesHelper`(R/G/B, depthTest off) 지연생성 + `setOriginVisible`(기본 끔, 씬크기로 스케일).
  툴바 **# 격자**·**⛬ 원점** 토글.
- ✅ **이슈 핀 비주얼**: `SphereGeometry`→캔버스 텍스처 **빌보드 Sprite**(물방울 핀+흰테두리+상태색+번호,
  `sizeAttenuation` off로 화면상 일정 크기, 팁 앵커 `center=(0.5,0)`). 미해결 핀은 animate 루프에서 은은한 펄스.
  `userData.issueId` 유지 + `pickIssuePin`은 화면좌표 투영 근접 픽으로 교체(상수크기 스프라이트는 raycast 부적합).
- ✅ **트리 정리**: 통합모델 사이드바 **문서·미디어 섹션 제거**(문서는 CDE로 일원화) + 관련 상태/핸들러/import 정리.
  카테고리 트리에 **검색 필터 + 전체 토글**(보이는 카테고리 일괄 표시/숨김) 추가.
- ✅ 검증: `typecheck`·`build` 통과(메인 gzip 830KB). 색은 `index.css` 토큰만(3D 머티리얼/캔버스 hex 예외).
  라이브 눈검증(실 IFC 좌표·핀 클릭)은 모델 로드 후 사용자 화면 권장(원격 egress 제약).
- 📌 후속(범위 밖): 측정 스냅(S45) · 단면 박스/기즈모(S46) · 렌더 스타일(S47) · 마크업 3D 앵커(S48) ·
  홈뷰 서버 영속화(현재 localStorage) · 핀 클러스터링/번호 안정 정렬.

## S42 결과 (branch: feature/quantities) — 5D 물량 산출(QTO) + 기성 연계
> BIM 요소 물량을 공종/카테고리별 집계 → 기성내역(0011) 연계. 마이그레이션 없음(클라이언트 계산). typecheck·build 통과.
- ✅ **단위 정규화(IfcViewer)**: `getLengthUnitToMeters(modelID)` — `IfcSIUnit`(LENGTHUNIT prefix:
  MILLI/CENTI…) 또는 `IfcConversionBasedUnit`(imperial)에서 **미터 환산 계수**를 읽어 캐시. 감지 실패 시 null
  → UI 에서 m/mm 수동 토글 폴백. (안 하면 체적이 10⁹배 틀어짐)
- ✅ **물량 소스(IfcViewer)**: `getElementBaseQuantities` — `IfcRelDefinesByProperties` 를 1회 순회해
  요소→`IfcElementQuantity`(BaseQuantities: Net/Gross Volume·Area·Length) 인덱스 구축·캐시(Net>Gross>any
  우선). 없으면 `getMeshQuantities` — **삼각형 적분 체적**(부호있는 사면체합)·표면적·bbox(모델단위). 개수는 항상.
- ✅ **데이터층 `lib/quantities.ts`**: `computeQuantities`(요소 순회·단위 스케일 적용·청크+yield 진행률) →
  `aggregateByCategory`(카테고리=`getElementMeta` 재사용) → `CategoryQty`(count·length m·area m²·volume m³ +
  소스 내역 ifc/mesh/count). `quantitiesToCsv`(BOM 한글)·`fmtQty`.
- ✅ **페이지 `pages/Quantities.tsx`** + 라우트 `/project/:id/quantities`(ProjectShell 중첩) + 좌측 메뉴
  `🧮 물량 산출 (QTO)`. 자체 IfcViewer + 모델 자동 로드(풀 공유). 대상 집합 = ClashPanel **(모델→카테고리)**
  2단계 패턴. 단위 토글(자동/m/mm) · 산출 진행바 · 요약(체적·면적·길이·소스 내역) · **공종별 물량표 + 합계**
  · CSV 내보내기. 표의 공종 행 클릭 → 그 공종 **체적 최대 대표 요소로 `focusElement`**.
- ✅ **기성 연계**: 산출된 공종별 물량을 `createBillingItem`(0011)으로 **기성내역 행 제안**(admin, D11) — 공종명에
  대표 물량 기입·금액 0원으로 추가 → 기성내역에서 단가/금액 입력. `기성내역 →` 링크.
- ✅ 검증: `typecheck`·`build` 통과(메인 gzip 828KB). 색은 `index.css` 토큰만. 라이브 눈검증(실 IFC 단위·물량
  정확도)은 모델 로드 후 사용자 화면 권장(원격 egress 제약).
- 📌 후속(범위 밖): **단가 DB(복합단가)로 물량→금액 자동 산출** · 기성 quantity 컬럼(0019) 영속화 ·
  IFC 표준 수량셋(QTO_*) 매핑 정교화 · 4D 일정 묶어 기간별 투입물량 곡선 · 메시 길이근사(bbox 최장변) 개선.

## S41 결과 (branch: feature/drawings-2d) — 2D 도면(PDF/DXF) + 이슈 핀
> 현장 2D 도면 열람 + 도면 위 이슈 핀. DWG는 변환(APS/ODA) 필요 → S17 분리(A안). dxf-parser 추가.
- ✅ **`0018_drawings.sql`**: `drawings`(name·kind(pdf/dxf)·storage_path·page_count) +
  `drawing_pins`(drawing_id·page·x·y 정규화0..1·label·issue_id). RLS 읽기=멤버, 쓰기=admin(D11).
  바이너리는 'docs' 버킷 `<pid>/drawings/<id>.<ext>`(0004 storage 정책 재사용). setup_all.sql 0003~0018.
- ✅ **`lib/drawings.ts`**: 타입 + 업로드/CRUD(도면·핀) + 서명URL. `lib/dxfRender.ts`: 경량 DXF→2D
  캔버스(LINE/POLYLINE/ARC/CIRCLE/ELLIPSE/TEXT, y-up→y-down). INSERT/SPLINE은 MVP 미지원(안내).
- ✅ **`DrawingSheet`**: PDF(pdf.js)·DXF 캔버스 렌더 + 휠 줌/드래그 팬(캔버스+핀 레이어 CSS 변환) +
  PDF 페이지 네비. 핀 추가(admin)·라벨·**이슈 생성/연결·이슈로 이동**·삭제. 핀은 줌 역보정으로 크기 유지.
- ✅ **`pages/Drawings.tsx`** + 라우트 `/project/:id/drawings` + 좌측 네비 "📐 도면 (2D)". 목록·업로드·삭제.
- ✅ 검증: `typecheck`·`build` 통과. 라이브 눈검증(실제 PDF/DXF 업로드·핀)은 사용자 화면 권장(원격 egress).
- 📌 후속(범위 밖): DXF INSERT/블록 전개·SPLINE · 핀 멤버 작성 권한 · 도면↔3D 위치 양방향 · DWG(S17 APS).

## S40 결과 (branch: feature/clash-grouping) — 간섭 결과 그룹화·정렬·필터·상태승계
> Navisworks식 간섭 결과 정리. 마이그레이션 없음(클라이언트 전용). typecheck·build 통과.
- ✅ **`lib/clash.ts` 순수 헬퍼**: `groupClashes`(묶음=없음/카테고리쌍/요소A/상태, 정렬=검출순/깊이↓↑/
  상태, 그룹은 미해결 수 순 정렬)·`inheritStatuses`(재검사 시 같은 요소쌍 상태/이슈연결 승계,
  새 쌍=new·사라진 쌍 탈락)·`pairKeyOf`. `GROUP_BY_LABEL`·`SORT_BY_LABEL`.
- ✅ **`ClashPanel` UI**: 묶음·정렬 셀렉트 + 상태칩 필터(신규/검토중/해결/승인, 카운트·토글) +
  접이식 그룹 헤더(라벨·미해결/총 카운트). 전역 행 번호. 행 클릭 하이라이트·이슈 전환은 유지.
- ✅ **상태 승계**: `run()` 이 직전 `rows`를 받아 `inheritStatuses` 적용, "상태 승계 N건" 표시.
- ✅ 검증: `typecheck`·`build` 통과. 색은 `index.css` 토큰·`color-mix(currentColor)` 만.
- 📌 후속(범위 밖): 그룹 단위 격리/일괄 상태변경 · 레벨/그리드 기준 묶음 · 필터/정렬 상태 영속화.

## S39 결과 (branch: feature/markup-edit-animator) — 마크업 개별 편집 + 카메라 애니메이션
> S37 후속(사용자 선택). 마이그레이션 없음(순수 프론트엔드). typecheck·build 통과.
- ✅ **마크업 도형 개별 편집(`MarkupOverlay`)**: `선택/이동` 도구 추가 — 클릭 히트테스트(선/화살표=
  선분거리, 사각형=테두리, 텍스트=앵커)로 도형 선택(점선 바운딩박스), 드래그로 이동, `선택 삭제`
  버튼 + `Delete`/`Backspace` 키로 삭제. 기존 `지우기`(전체)는 유지.
- ✅ **카메라 애니메이션(Animator/워크스루)**: `IfcViewer.tweenCameraTo`(position·target·fov
  smoothstep 보간, near/far 사전확장으로 클리핑 방지)·`cancelCameraTween` + animate 루프
  `stepCameraTween`. `ViewpointPanel` 에 `▶ 워크스루`/`■ 정지` — 저장 뷰포인트를 **시간순**으로
  부드럽게 날아다니며 각 지점에서 표시상태·마크업 적용 후 잠시 머무름. 멤버도 재생 가능.
- ✅ **Workspace 연동**: 마크업 선택 상태(markupSel) 관리(끄면/도형 감소 시 자동 해제), 뷰포인트
  재호출이 진행 중 워크스루를 멈추도록 정리. 패널 언마운트 시 tween 중단.
- ✅ 검증: `typecheck`·`build` 통과(메인 gzip 700KB). 색은 `index.css` 토큰만(`--redline-*`·`--accent`).
  라이브 눈검증(드래그 이동·워크스루 비행)은 IFC 로드 후 사용자 화면 권장(원격 egress 제약).
- 📌 후속(범위 밖): 마크업 끝점 핸들 리사이즈 · 다중 선택 · 워크스루 속도/머무름 시간 UI ·
  뷰포인트 순서 변경(드래그) · 워크스루 중 녹화(영상 내보내기).

## S37 결과 (branch: claude/viewpoints-markup-8bu09a) — 저장 뷰포인트 + 마크업(redline)
> Navisworks 잔여 협업 핵심. 카메라 뷰 저장·공유 + 화면 2D 주석. 마이그레이션 `0017_viewpoints.sql`
> (추가형·멱등, 0001~0016 무수정) + setup_all.sql 갱신. typecheck·build 통과.
- ✅ **`0017_viewpoints.sql`**: `viewpoints`(project_id·model_id·name·camera(jsonb)·display(jsonb)·
  markup(jsonb)·thumbnail·created_by) + `issues.viewpoint_id` 컬럼(이슈↔뷰포인트). RLS 읽기=멤버,
  쓰기=admin(D11). setup_all.sql 0003~0017 로 확장.
- ✅ **IfcViewer**: `getCameraState`/`applyCameraState`(position·target·up·fov·near·far, 월드좌표) +
  `captureThumbnail`(다운스케일 JPEG)·`captureSnapshot`(풀해상도 PNG, 이슈 첨부용).
- ✅ **데이터층 `lib/viewpoints.ts`**: 타입(CameraState·DisplayState·MarkupShape·RedlineColor) +
  CRUD(list/get/create/delete) + `resolveRedline`(토큰 해석)·`bakeMarkup`(스냅샷에 주석 굽기, **이슈
  첨부 시에만**, D16)·`dataUrlToFile`. 마크업은 좌표(정규화 0..1)로 저장(D16).
- ✅ **마크업 오버레이 `components/MarkupOverlay.tsx`**: 뷰포트 위 SVG(viewBox 0..1000, 정규화).
  도구=화살표/선/사각형/텍스트, 색=`--redline-*` 토큰 5종. active 일 때만 포인터 캡처(비활성 시
  pointer-events:none 으로 3D 조작 방해 X).
- ✅ **뷰포인트 패널 `components/ViewpointPanel.tsx`**: 이동/크기조절 창(clash-win 재사용). 현재 뷰
  저장(이름·카메라·표시상태·마크업·썸네일) + 썸네일 목록에서 **재호출**(카메라+표시상태+마크업 복원)
  + 삭제 + **뷰포인트→이슈**(재호출 후 스냅샷에 마크업 구워 첨부 + viewpoint_id 연결). 멤버=재호출만,
  저장/삭제/이슈=admin(D11).
- ✅ **Workspace 연동**: 뷰어바 `📌 뷰포인트`·`✎ 마크업`(도구·색·지우기). 표시상태 get/apply
  (모델·카테고리 숨김 + 단면). modelDbId=단일모델이면 그 모델, 다중이면 장면 전체(null). 마크업 켜면
  측정 모드 자동 해제(둘 다 클릭 가로챔).
- ✅ **이슈↔뷰포인트 양방향**: `createIssue(..., viewpoint_id)`(0017 미적용 폴백=값 있을 때만 포함).
  Issues 상세에 `📌 뷰포인트 열기`→통합모델로 이동 후 자동 재호출(라우터 state `openViewpoint`).
- ✅ 검증: `typecheck`·`build` 통과(메인 gzip 698KB). 색은 `index.css` 토큰만(`--redline-*` 신설).
  📌 배포: `0017_viewpoints.sql` 실행(또는 setup_all 재실행). 라이브 눈검증은 IFC 로드 후 사용자
  화면 권장(원격 egress 제약).
- 📌 후속(범위 밖): 마크업 도형 개별 선택/이동/삭제(현재 전체 지우기) · 카메라 애니메이션(Animator) ·
  뷰포인트 폴더/순서 · 표시상태 복원을 4D/간섭 모드까지 확장(현재 카메라+단면은 전 모드, 모델/카테고리
  숨김은 통합모델).

## S32~S36 (직전 누적) — 충돌검사·모듈분리·간섭 UX·리뷰도구
> **S32~S36 완료 확인·기획 현행화**. 충돌검사(S32, three-mesh-bvh)
+ 3D 모듈 분리/모델풀 공유(S33·S34, D14) + 간섭 UX(S35) + **버그픽스·리뷰도구(S36: 측정📏·단면✂·
이슈핀 팝업·모델/카테고리 토글)**. CDE+포털+권한+첨부+이슈WF+삭제완화까지 누적 완료.

## S36 결과 (branches: clash-sim-fix · issue-pin-popup · model-visibility · measure-section) — 버그픽스 + 뷰어 리뷰도구
> 사용자 피드백/제안 반영. 4개 PR(#45~#48) 순차 머지.
- ✅ **버그픽스(#45)**: 라우터가 통합모델/4D/간섭을 **같은 Workspace 인스턴스**로 렌더 →
  4D 시공 시뮬 상태가 간섭검토로 새던 문제. `mode` 변경 이펙트로 4D 아니면 `clearConstruction`
  +`showAll`(탭 전환 시 모델 재로드 없이 시뮬만 정리).
- ✅ **기능1 이슈 핀 클릭 팝업(#46)**: 통합모델 핀 클릭 → 제목·상태·담당자·마감·내용 미니 팝업
  (`객체 보기`/`이슈로 이동`). `IfcViewer.setOnIssuePin`·`pickIssuePin`, Issues `focusIssueId` 펼침.
- ✅ **기능2 모델/카테고리 표시 토글(#47)**: 통합모델 트리에 모델별 체크박스 + 카테고리 섹션
  체크박스(다중선택, 보고 싶은 것만). `IfcViewer.applyVisibility(pred)`.
- ✅ **기능4 측정·단면(#48)**: 📏 측정(두 점 거리+라벨 스프라이트, 지우기) + ✂ 단면(클리핑 평면,
  축 X/Y/Z·위치 슬라이더·뒤집기). `setMeasureMode`/`clearMeasurements`/`pickPoint`/`setSection`,
  `localClippingEnabled`. 모든 모듈 뷰어바에서 사용.
- ✅ 검증: 각 PR `typecheck`·`build` 통과. **마이그레이션 추가 없음**(0016 까지 그대로).
- 📌 남은 제안(후속): 간섭 결과 그룹화·정렬·필터(Navisworks식, 상태승계) · 뷰포인트 저장 ·
  간섭 보고서(HTML/PDF) · 자료관리 다중선택 뷰어 · 자동로드 성능(점진 로딩).

## S35 결과 (branch: claude/clash-ux) — 모듈 자동로드 + 간섭검토 UX 대폭 개선
> 사용자 피드백 7건 반영(작업 순서 자율).
- ✅ **(1) 모델 자동 로드**: 통합모델에 업로드만 하면 통합·4D·간섭 **세 모듈이 진입 시 전체
  모델을 자동 로드**(클릭 불필요). 업로드 즉시 현재 화면에도 추가. 통합모델 트리 클릭=카메라 맞춤.
- ✅ **(2) 시뮬 상태 격리**: 4D 공정 시뮬이 간섭검토 화면에 새던 문제 → 각 모듈 자기 IfcViewer
  인스턴스 + 진입 시 `clearConstruction()`+`showAll()`(4D 제외)로 항상 전체 표시 시작.
- ✅ **(3) 간섭 시각화 개선**: 핑크 마커 제거 → 대상 A=**초록**·B=**빨강** 하이라이트 + 나머지
  객체 **반투명(ghost)** + 간섭부 **줌인**(`showClash` 재작성, frameBox 줌 강화).
- ✅ **(4) 팝업 창화**: '충돌검사'→**'간섭검토 결과'**. 헤더 드래그 이동 + 우하단 핸들 크기조절
  (`.clash-win`). 고정 드로어 폐지.
- ✅ **(5) 이슈 생성 강화**: 모달에서 **내용 직접 작성** + 간섭부 **4각도 스냅샷**(`captureClashViews`,
  renderer `preserveDrawingBuffer`) 캡처 → 첨부할 각도 선택 → 이슈에 사진 첨부(0010 attachments).
- ✅ **(6) 4D/간섭 트리 숨김**: 모델 트리 제거로 메인 뷰 확대(통합모델만 트리 유지).
- ✅ **(7) 대상 선택 재설계**: 대상 A·B 를 **(모델 → 카테고리) 2단계**로 각각 선택, 두 선택기를
  **나란히 표시**(모델vs모델 오해 방지)·요소수 표기.
- ✅ 부수: `scheduleApi`·`Timeline` 다모델 매핑 지원(런타임↔DB 모델 맵), `IfcViewer.fitModel`.
- ✅ 검증: `typecheck`·`build` 통과. 마이그레이션 추가 없음.

## S34 결과 (branch: claude/share-model-pool) — 3D 모델 풀 공유(S33 보정)
> 사용자 정정: "통합모델(3D)에 업로드하면 4D·간섭검토에도 **같은 모델이 떠야** 한다"
> (별도 재업로드가 아니라 공유). S33 이 모듈별 분리 목록으로 잘못 구현 → 보정.
- ✅ **모델 목록을 셋이 공유**: `Workspace` 가 `listModels(projectId)`(purpose 미필터)로
  전체 풀을 보여준다. 업로드는 공유 풀(기본 integrated)로 1회 → 통합모델·4D·간섭검토 모두에 표시.
- ✅ **모듈 분리는 화면/런타임으로 유지**: 각 모듈이 자기 `IfcViewer` 인스턴스를 가지므로
  4D 공정 매핑(날짜별 표시)이 간섭검토 화면을 방해하지 않는다. `mode` 는 4D 타임라인·간섭패널·
  이슈핀 표시와 라벨만 좌우. 마지막 본 모델 자동복원 키는 모드별 유지.
- ✅ `models.purpose`(0016) 컬럼은 보존(향후 분류용)하되 **목록 필터로는 미사용**. 빈 목록
  안내 문구를 "통합모델(3D)에서 업로드하면 여기에도 표시"로 변경.
- ✅ 검증: `typecheck`·`build` 통과. (마이그레이션 추가 없음 — 0016 그대로)

## S33 결과 (branch: claude/stoic-pasteur-8wir5q-mods) — 3D 모듈 용도 분리 (D14)
> 사용자 피드백: "간섭검토 3D 뷰가 4D 와 같이 묶여 있으면 안 된다 — 4D 는 공정표 매핑으로
> 날짜별 객체 표시가 달라져 간섭검토를 함께 보기 어렵다." → 3D 모듈을 셋으로 분리.
- ✅ **`0016_model_purpose.sql`**(추가형·멱등): `models.purpose`(integrated/4d/clash, 기본
  integrated, 체크제약·인덱스). 기존 모델은 통합모델로 백필. setup_all.sql 0003~0016 로 확장.
- ✅ **데이터층 `lib/api.ts`**: `ModelPurpose` 타입, `listModels(projectId, purpose?)`·`uploadModel
  (…, purpose)`·`getModel(id)` 에 purpose 반영. **0016 미적용 폴백** — purpose 컬럼 없으면
  레거시 조회/등록으로 자동 강등(통합모델은 그대로 동작, 4d/clash 빈 목록).
- ✅ **`Workspace` 를 `mode` 프롭으로 일반화**(integrated/4d/clash): 각 모듈이 **자기 용도의
  모델만** 목록·업로드. integrated=이슈 생성 + **이슈 핀 표시/숨김 토글**(IfcViewer
  `setIssuePins`/`setIssuePinsVisible`/`clearIssuePins`, 상태색 미해결=빨강/완료=초록),
  4d=하단 4D 타임라인, clash=우측 충돌검사 패널. 마지막 본 모델 자동복원 키를 모드별로 분리.
- ✅ **라우팅/네비**: `/project/:id/model`(통합모델 3D) · `/viewer`(공정관리 4D) · `/clash`(간섭검토).
  좌측 메뉴 = 사업개요·공정현황·**통합모델(3D)🧊·공정관리(4D)🏗·간섭검토🔍**·공사일보…. 대시보드
  3D 카드·이슈 '위치 보기' → `/model`(getModel 폴백으로 용도 무관하게 대상 모델 오픈).
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0016_model_purpose.sql` 실행(또는 setup_all 재실행).
- 📌 메모: 분리 후 4D/간섭은 통합모델과 **별도 업로드** 필요(사용자 컨셉). 기존 4D 저장 일정은
  옛 integrated 모델 id 참조 → 4D 용 모델 재업로드 전까지 목록 비어 보임(의도된 동작).

## S32 결과 (branch: feature/clash-detection) — Phase 4 충돌검사 (Clash Detection)
- ✅ **엔진(`three-mesh-bvh`, D13)**: `package.json` 에 `three-mesh-bvh@^0.7.8` 추가. `IfcViewer`
  확장 — `getElementMeta`(요소별 이름+IFC 카테고리, 캐시), `getLoadedModels`(집합 선택용),
  `buildClashGeom`(요소의 **월드좌표 병합 지오메트리 + MeshBVH**), `showClash`(양쪽 객체 A=빨강
  /B=파랑 하이라이트 + 간섭점 구체 마커 + 카메라 fit), `clearClashView`/`isolateClashPair`.
- ✅ **검출(`src/lib/clash.ts`)**: 광역단계(월드 AABB 교차로 후보쌍 추림, tolerance 부풀림) →
  협역단계(`bvh.intersectsGeometry` 정밀 교차). **메인스레드 청크 + `await yieldToUi()`** 로
  진행률 보고·UI 프리징 방지(Web Worker 안전 폴백). 자기자신·중복쌍(A↔B/B↔A) 1회. Hard(겹침)
  + Clearance(근접) 유형. 간섭점=겹침박스 중심, 관통깊이=겹침박스 최소변(근사). CSV 내보내기.
- ✅ **결과 패널(`src/components/ClashPanel.tsx`)**: 4D 뷰어 우측 드로어(툴바 `🔍 충돌검사` 토글).
  대상 A/B 선택(전체·모델별·카테고리별 + 요소수) + 유형 + 허용오차 → **검사 실행**(진행바·중단).
  결과 표(요소A↔B·관통깊이·상태[신규/검토중/해결/승인]) — 행 클릭 시 양쪽 하이라이트+마커+fit,
  `격리`(간섭 객체만 보기)/`전체 보기`. 요약 칩(총/미해결/처리).
- ✅ **간섭 → 이슈**: 행 `이슈` 버튼 → **확인 모달**(제목·우선순위·담당자·마감) → S30 `createIssue`
  (`createIssue` 가 issueId 반환하도록 확장) + 0012 객체 핀(model_id+express_id=A요소)으로 연결,
  생성 후 상태 `검토중`. DB 백업본이면 `linkClashIssue`/`setClashStatus` 로 영속화.
- ✅ **영속화(`0015_clash.sql` + `src/lib/clashApi.ts`)**: `clash_tests`(이름·집합 라벨·유형·허용오차)
  + `clashes`(요소 A/B·간섭점·관통깊이·상태·issue_id). RLS 읽기=멤버, 쓰기=admin(D11). 결과 저장/
  불러오기(런타임 modelID ↔ DB 모델 uuid 역매핑) + CSV. `setup_all.sql` 0003~0015 로 확장.
- ✅ 검증: `typecheck`·`build` 통과(메인 번들 689KB gzip). 색은 `index.css` 토큰만(3D 머티리얼은
  엔진 관례상 hex). 📌 배포: `0015_clash.sql` 실행(또는 setup_all 재실행). 라이브 눈검증은 IFC 2개
  로드 후 사용자 화면 권장(원격 egress 제약).
- 📌 후속(MVP 범위 밖): Duplicate 유형, 규칙세트 저장/무시규칙, GUID 기준 비교, 관측점 썸네일,
  Web Worker 분리(현재 메인스레드 청크로 충분), 정밀 관통깊이(현재 AABB 근사).

## S31 결과 (branch: feature/doc-delete-owner) — 문서 삭제 권한 완화(D12)
- ✅ **`0014_doc_delete_owner.sql`**(추가형·멱등): D11(쓰기=admin)의 예외로 CDE 문서 **삭제**를
  업로더 본인+관리자로 완화. `files` 삭제 정책 → `using (uploaded_by = auth.uid() or is_admin())`.
  storage.objects(docs) **삭제 정책 신설** — SECURITY DEFINER 헬퍼 `owns_doc_object(name)`
  (오브젝트 name 을 `files.storage_path`/`file_versions.storage_path` 와 조인해 업로더 판정)
  + `using (is_admin() or owns_doc_object(name))`. 기존엔 docs 삭제 정책이 없어 오브젝트가
  고아로 남던 잠재 결함도 함께 해소.
- ✅ **데이터층 `lib/cde.ts`**: `CdeFile`/`FILE_COLS` 에 `uploaded_by` 추가. `deleteCdeFile` 가
  **DB 행 삭제 전 스토리지 오브젝트를 먼저 remove** 하도록 순서 교체(삭제 정책이 살아있는
  files/file_versions 행으로 소유자 판정 → 본인 삭제 시 고아 방지).
- ✅ **UI `DocumentManager`**: 삭제 버튼을 `canDelete(f)=isAdmin || f.uploaded_by===profile.id`
  로 업로더 본인에게도 노출(기존 확인창 유지). 새 버전/상태/폴더는 D11 그대로 admin.
  삭제 시 활동로그(`file.delete`)는 기존대로 기록.
- ✅ 검증: `typecheck`·`build` 통과. setup_all.sql 0003~0014 로 확장.
- 📌 배포: `0014_doc_delete_owner.sql` 실행(또는 setup_all 재실행).
- 📌 후속(D12 메모): 발행(Published) 상태 문서 삭제 가드는 후속 검토.

## S30 결과 (branch: claude/gifted-cray-kvipv9) — 이슈 워크플로우(상태·담당자·마감·알림)
- ✅ **`0013_issue_workflow.sql`**: issues 에 `assignee_id`(사용자 FK) 추가, 상태에 `on_hold`(보류)
  추가(신규 open→진행 in_progress→완료 resolved/종료 closed/보류 on_hold). 신규 테이블
  `issue_events`(상태 전이·배정 변경 이력), `notifications`(인앱 알림). RLS: issues UPDATE 를
  **관리자 + 담당자 본인**으로 확장(D11 예외, 사용자 결정 — 담당자는 자기 이슈 상태 변경 가능).
- ✅ **데이터층**: `lib/issues.ts` 확장(STATUS_LABEL 신규/진행/완료/종료/보류, `assignIssue`,
  `setIssueStatus`(이력+알림), `listEvents`, `dueState`/`dueDeltaLabel` 마감 임박/지연 계산).
  신규 `lib/notifications.ts`(list/countUnread/markRead/notify), `lib/members.ts`(담당자 후보).
- ✅ **UI**: 협업·이슈 화면에 담당자 드롭다운·마감일·상태 select(관리자 또는 담당자 본인)·
  마감 임박/지연 뱃지(D-표기)·변경 이력 타임라인. 상단바 **🔔 알림 종**(NotificationBell:
  미읽음 배지·드롭다운·모두읽음·클릭 시 이슈 이동).
- ✅ 검증: `typecheck`·`build` 통과. setup_all.sql 0003~0013 로 확장.
- 📌 배포: `0013_issue_workflow.sql` 실행(또는 setup_all 재실행).
- ⚠️ 참고: 컬럼 단위 RLS 제한 불가 → 담당자는 행 단위로 update 권한이지만 UI 는 상태 select 만 노출.

## S29 결과 (branch: claude/busy-lovelace-cj8adq) — 마일스톤 정렬 + 이슈↔3D 객체 핀
- ✅ **마일스톤 드래그 정렬**: `reorderMilestones`(sort_order=인덱스), 사업개요 편집에 드래그
  리스트(+삭제). 마이그레이션 불필요.
- ✅ **이슈 ↔ 3D 객체 연결**: `0012_issue_location.sql`(issues 에 model_id·express_id 추가).
  공정관리(4D) 뷰어 상단 **`＋ 선택 객체로 이슈`**(관리자, 객체 선택 시) → 그 객체에 연결된
  이슈 생성. 협업·이슈 상세의 **`📍 위치 보기`** → 공정관리로 이동해 대상 모델 열고
  `IfcViewer.focusElement`(하이라이트+카메라 fit+속성패널). 라우터 state(focus)로 핸드오프.
- ✅ 검증: `typecheck`·`build` 통과. setup_all.sql 0003~0012 로 확장.
- 📌 배포: `0012_issue_location.sql` 실행(또는 setup_all 재실행).
- 🔜 남은 후보: 권한 세분화 잔여(0003 공정표 RLS admin-only), 도면(2D) 핀, 이슈 알림.

## S28 결과 (branch: fix/admin-user-create-hang) — 사용자 생성/아이디·비번 변경 무한대기 버그픽스
- 🐛 **증상**: 관리자 콘솔 사용자 탭에서 사용자 추가가 "생성 중…"에서 멈춤(아이디/비번 변경도 동일).
- ✅ **원인**: `api/admin.ts`가 Web `Request`/`Response` 시그니처인데 Vercel **기본 Node 런타임**에서는
  반환한 `Response`가 무시되어 응답이 영영 안 감 → 클라이언트 무한 대기. (S2 때 라이브 미검증 경로.)
- ✅ **수정**: `api/admin.ts`에 `export const config = { runtime: 'edge' };` 추가 → Edge 런타임에서
  Web 시그니처가 정상 응답. 부수적으로 `src/lib/admin.ts` `adminFn`에 20초 AbortController 타임아웃 추가
  (행 대신 "서버 응답 없음(시간초과)" 안내). `typecheck`·`build` 통과.
- 📌 **배포 후 확인 필요**: Vercel env `SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY`(서버 전용, VITE_ 금지)
  설정되어 있어야 함. 재배포 후 사용자 추가/아이디·비번 변경 동작.

## S27 결과 (branch: claude/busy-lovelace-cj8adq) — 사용자 피드백 1·2·4 반영
- ✅ **(1)** 좌측 메뉴 `모델뷰어 (3D)` → **`공정관리 (4D)`** 로 변경(공정현황 바로 아래로 이동).
  라우트 `/viewer` 유지 — Workspace(3D+4D 타임라인)가 공정관리(4D) 모듈.
- ✅ **(4)** 공정현황(Schedule)에 **월별 계획/실적/기성 입력 폼 + 수정/삭제** 직접 추가(관리자).
  이전엔 "사업개요 편집에서 입력" 안내만 있어 입력칸을 못 찾던 문제 해소.
- ✅ **(2)** 자료관리(CDE)에서 **IFC 파일 클릭 → 우측 화면이 인라인 3D 뷰어로 전환** + `← 목록`
  뒤로가기. 새 컴포넌트 `IfcModelViewer`(web-ifc 재사용, 선택→속성패널), `downloadFileBytes`
  (docs 버킷). 모델 업로드는 기존 `문서 업로드`로 .ifc 올리면 됨(파일 관리에 포함).
- ✅ 검증: `typecheck`·`build` 통과. (마이그레이션 변경 없음)
- ✅ **(5)** 기성 공종별 상세: `0011_billing_items.sql`(billing_items: 공종·도급액·전월누계·당월,
  RLS 멤버읽기/admin쓰기) + portal.ts CRUD + 기성내역 페이지 **공종별 명세 표**(누계·기성률·합계,
  관리자 추가/수정/삭제). setup_all.sql 0011 포함 재생성.
- ✅ **(3) 재수정 — 진짜 무클릭 영속화**: 사용자 지적("자동으로 열리며 매핑이 사라짐") 반영.
  원인=auto-open 시 매핑 리셋 + 런타임 modelID 변경. 해결: 공정표/매핑을 **사용자 편집 즉시
  활성 슬롯에 자동 저장**(`scheduleApi.saveActiveSchedule`, 프로젝트당 1슬롯 교체, persistActive),
  모델이 열릴 때마다 **DB에서 다시 해석해 자동 복원**(`loadActiveSchedule`, autoRestore). 수동 저장
  불필요. 삭제 후 재업로드 전까지 유지. **0003(공정표) 마이그레이션 필요** → setup_all.sql 을
  0003~0011 로 확장. 저장은 관리자만(persistActive isAdmin 가드), 0003 RLS=admin/member.

## S26 결과 (branch: claude/busy-lovelace-cj8adq) — 첨부파일(사진/문서) + 뷰어 리사이즈
> 사용자 DB 셋업(setup_all.sql) 성공 확인 후 P6 착수. 첫 항목: 공사일보·게시판·이슈 첨부.
- ✅ DB 셋업 안내 개선: `supabase/setup_all.sql`(0005~0010 원클릭+스키마 reload), `src/lib/errors.ts`
  (테이블 없음/스키마 캐시 오류 → "DB 설정 필요" 한국어 안내) 적용. OPERATIONS 0-SETUP.
- ✅ 뷰어 `ResizeObserver`: 셸 임베드 후 타임라인 펼침/모듈 전환에 캔버스 자동 맞춤.
- ✅ **범용 첨부 `0010_attachments.sql`**: attachments(target_type daily_log/post/issue) → docs 버킷
  `<project>/attach/<id>.<ext>`. RLS 읽기=멤버, 쓰기=관리자(D11). `src/lib/attachments.ts` +
  재사용 컴포넌트 `src/components/Attachments.tsx`(이미지 썸네일·파일 칩·admin 업로드/삭제).
- ✅ 연동: **공사일보**(행 펼침 '현장 사진'), **게시판**(글 펼침 첨부), **이슈**(상세 '첨부 문서·사진').
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0010_attachments.sql` 실행(또는 setup_all 재실행).
- 📌 다음: 기성 공종별 상세 / 마일스톤 드래그 정렬 / 이슈↔모델 객체 연결.

## S25 결과 (branch: claude/busy-lovelace-cj8adq) — 모듈 레이아웃 통합(셸 안으로)
> 사용자 요청: 모델뷰어·자료관리·구성원도 **좌측 모듈 레일은 유지**하고 우측만 교체. 모델뷰어·
> 자료관리처럼 자체 하위 트리가 있으면 레일 옆에 **두 번째 트리** 컬럼(메인이 작아져도 보기 편하게).
- ✅ 라우팅: `/viewer`·`/docs`·`/members` 를 **ProjectShell 중첩 라우트**로 이동(전체화면 교체 폐지).
  좌측 모듈 레일 + 상단바는 셸이 항상 유지, Outlet 우측만 교체.
- ✅ **모델뷰어(Workspace)** 재구성: 자체 topbar 제거 → `mod-fill viewer-fill` = [모델/문서 하위 트리]
  + [뷰어바(Toolbar+상태)·3D 뷰포트·4D 타임라인]. 즉 레일 | 모델트리 | 뷰포트 3단.
- ✅ **자료관리(DocumentManager)** 재구성: topbar 제거 → `mod-fill cde-embed` = [폴더 트리] + [문서 목록].
  레일 | 폴더트리 | 문서 3단.
- ✅ **구성원·권한(Admin)**: `embedded` 프롭 추가 → 셸 안에서 헤더 없이 탭+본문만 렌더. `/project/:id/members`
  (AdminOnly). 독립 `/admin`(프로젝트 선택 화면 진입)도 유지.
- ✅ CSS: `.portal-main` position:relative, `.mod-fill`(absolute inset:0)·`.mod-subtree`·`.mod-main`·
  `.viewer-bar` 추가. 대시보드형 페이지는 portal-main 스크롤 그대로.
- ✅ 검증: `typecheck`·`build` 통과. (마이그레이션 변경 없음 — 순수 레이아웃/라우팅)

## 지금까지 한 일
- Phase 1: 3D IFC 뷰어 (Three.js + web-ifc) — 로드·탐색·선택·속성·표시제어.
- Phase 0: 인증(아이디 로그인) + 프로젝트별 권한(RLS) + 모델 저장(Storage).
  - DB 스키마/정책: `supabase/migrations/0001_init.sql`
  - 화면: 로그인 → 프로젝트 선택 → 작업공간(뷰어+모델 목록/업로드)
- **S1: 실제 Supabase 프로젝트 연결·라이브 검증 완료** (아래 검증 상태 참고).
- **S3: Vercel 배포 라이브 검증 완료** — `vercel.json`(SPA rewrites + WASM/asset 캐시
  헤더), GitHub Actions CI(`.github/workflows/ci.yml`: typecheck+build), README 가이드.
  실제 Vercel URL에서 로그인 성공 확인(사용자 검증). Supabase 키는 publishable(공개)
  키 사용 — supabase-js 호환 OK.
- **S2: 관리자 콘솔 구현 완료** (`/admin`) — 프로젝트·사용자·멤버를 화면에서 관리.
  service_role 자동가입으로 한글 아이디 **수동 보정 SQL 제거**(아래 S2 결과 참고).
- 멀티세션 워크플로우 백본: `CLAUDE.md`, `docs/`, SessionStart 훅(`.claude/`).
- `main` 통합 브랜치 생성 + PR 병합 전략 채택.

## 검증 상태
- ✅ `npm run typecheck` 통과, ✅ `npm run build` 성공, ✅ SessionStart 훅 동작.
- ✅ **라이브 검증 완료 (실제 Supabase)** — `npm run verify:e2e` (admin) 전 항목 통과:
  로그인·프로필/관리자플래그(트리거)·RLS 프로젝트 조회·모델 목록·Storage
  업로드/다운로드/insert/cleanup. 한글 아이디(`고종찬`) 브라우저 로그인→프로젝트
  선택(RLS)→작업공간/뷰어 진입까지 정상 확인.
- (선택 잔여) 실제 IFC 파일 업로드→뷰어 형상 렌더는 파일 준비 시 눈으로 확인 가능
  (Storage 경로·뷰어 그리드 렌더는 검증됨).

## S1 결과 (branch: feature/supabase-wiring → main PR)
- ✅ 셋업 도구: `supabase/seed.sql`(관리자 승격+프로젝트+멤버, 멱등),
  `scripts/verify-e2e.mjs`(`npm run verify:e2e`, 헤드리스 e2e),
  `scripts/username-email.mjs`(한글↔ASCII 이메일 매핑 + 대시보드용 CLI).
- ✅ 버그픽스: AuthProvider 미설정 시 네트워크 호출 스킵 + profile fetch 에러 처리.
- ✅ **한글 아이디 지원**: `usernameToEmail` — ASCII 는 그대로(`admin@mir.local`),
  비-ASCII 는 가역 인코딩(`u-<hex>@mir.local`)으로 매핑(GoTrue 비-ASCII 회피).
  사용자는 한글 아이디 그대로 로그인. (src/lib/supabase.ts ↔ username-email.mjs 동기)
- 📌 **운영 메모**: Supabase 대시보드 "Add user" 빠른 폼은 User Metadata 입력이
  없어, 비-ASCII 사용자는 생성 후 `profiles.username/full_name` 을 이메일 기준으로
  보정 + 멤버 배정하는 SQL 1회 필요(README 참고). S2 service_role 자동가입에서 해소.
- 📌 egress: 원격 웹 세션에서 Supabase 검증하려면 환경 네트워크 정책에
  `*.supabase.co` 허용 필요(이번엔 사용자 로컬 PC에서 검증). 

## S3 결과 (branch: feature/deploy-vercel → main PR)
- ✅ `vercel.json`: `framework:vite`, `buildCommand:npm run build`, `outputDirectory:dist`.
  - SPA `rewrites`(모든 경로→`/index.html`)로 react-router 새로고침/직접접속 404 방지.
  - `/web-ifc/*.wasm` → `application/wasm` + 1년 immutable 캐시, `/assets/*` immutable.
- ✅ CI: `.github/workflows/ci.yml` — main PR·push 마다 `npm ci → typecheck → build`.
  자격증명 없이 통과(supabase 미설정 시 안전 폴백).
- ✅ prebuild WASM 복사가 `dist/web-ifc/`에 포함됨을 빌드로 확인.
- ✅ **라이브 검증**: 사용자가 Vercel 레포 import + 환경변수(`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`=publishable 키) 설정 → Deploy → 실제 URL에서 **로그인 성공**.
  로그인 화면 렌더·SPA·WASM 포함 정상.
- 📌 운영 메모: Vercel Hobby/Supabase Free 둘 다 무기한 무료(자동 과금 X). Supabase
  무료 프로젝트는 **1주 미사용 시 자동 일시정지** → 대시보드 Restore 필요.
- 📌 키 메모: 사용자는 새 형식 publishable 키(`sb_publishable_...`) 사용. 만약 추후
  "Invalid API key" 발생 시 레거시 anon 키(JWT `eyJ...`)로 교체.

## S2 결과 (branch: claude/clever-maxwell-z64bhm → main PR, feature/admin-console)
- ✅ DB: `supabase/migrations/0002_admin.sql` — admin RLS **쓰기** 정책 추가
  (projects/project_members insert·update·delete, profiles update). 추가형·멱등.
- ✅ 서버리스: `api/admin.ts` (Vercel 함수) — service_role 로 사용자 **생성/삭제/비번변경**.
  호출자 access_token 검증 → `is_admin` 확인 후 처리. 생성 시 `user_metadata.username`
  직접 주입 → 한글 아이디도 **수동 보정 SQL 불필요**. (vercel.json rewrite 에서 `/api` 제외)
- ✅ UI: `src/pages/Admin.tsx` (`/admin`, 관리자 전용 가드) — 프로젝트/사용자/멤버 3탭.
  진입점: 프로젝트 선택 화면 우상단 `관리자 콘솔`(admin 만 노출). `src/lib/admin.ts` 데이터층.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. `api/admin.ts` 는 tsconfig 제외(Vercel
  가 배포 시 컴파일, @types/node 자동 제공) — 단독 tsc 시 `process` 만 미해결(정상).
- 📌 **배포 셋업 필요**: Vercel 서버 전용 env `SUPABASE_URL`,`SUPABASE_SERVICE_ROLE_KEY`
  추가(VITE_ 금지) + `0002_admin.sql` 실행 + 첫 관리자 1회 SQL 승격. README/OPERATIONS 0-A 참고.
- 📌 **미검증(egress)**: 실제 사용자 생성/삭제 라이브 테스트는 배포 환경 또는 `vercel dev`
  에서 필요(원격 세션 egress 제약). `npm run dev`(vite)에선 사용자 관리만 404, 프로젝트·멤버는 동작.

## S8 결과 (branch: claude/vibrant-goldberg-fxpfua)
- ✅ 긴 텍스트 오버플로우/좁은 화면 레이아웃 정리 (CSS 중심, 일부 구조 보정).
  - **프로젝트 선택**(`ProjectSelect`): 카드 고정폭(340/460px) → `width:100% + max-width`로
    반응형. `관리자 콘솔`/`로그아웃` 버튼 줄바꿈 방지(`white-space:nowrap` 전역 + 액션
    `flex-shrink:0`), 인사문구 블록 `min-width:0`로 축소·줄바꿈. 프로젝트명 말줄임(ellipsis),
    코드 칩 `flex-shrink:0`.
  - **워크스페이스**(`Workspace`): 상단바 `overflow:hidden`, 브랜드/툴바/버튼 `flex-shrink:0`,
    프로젝트명(`project-title`)·모델명(`model-name`)은 `min-width:0`+ellipsis로 말줄임.
  - **관리자 콘솔**(`Admin`): 상단바 사용자명 말줄임(`max-width:30vw`), 탭 `overflow-x:auto`,
    폼 행 `flex-wrap:wrap`, 3개 테이블을 `.admin-table-wrap`(가로 스크롤)로 감싸고
    `min-width:480px` 유지 → 좁은 화면에서 칸 깨짐 대신 가로 스크롤.
  - **속성 패널**·**모바일**: `.panel` 폭 `min(300px, 100vw-24px)`, `@media(max-width:640px)`
    에서 사이드바 260→180px 축소·여백 보정.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브 눈 검증은 사용자 화면에서 확인 권장)
- 📌 메모: 데이터 변경/마이그레이션 없음, 순수 표현(레이아웃) 변경.

## S9 결과 (branch: feature/admin-rename-username → main PR)
- ✅ 서버리스: `api/admin.ts` 에 `renameUser` 액션 추가 — `profiles.username` 과
  그로부터 계산되는 **내부 인증 이메일(auth.users.email)** 을 함께 변경
  (`updateUserById({ email, email_confirm, user_metadata.username })` + profiles update).
  변경 전 username 중복(profiles.username UNIQUE) 선검사 → 409 차단.
- ✅ 데이터층: `src/lib/admin.ts` `renameUserAccount(userId, username)`.
- ✅ UI: `src/pages/Admin.tsx` 사용자 탭에 `아이디 변경` 버튼(prompt) 추가 → 변경 후 목록 새로고침.
- ✅ 문서: `docs/OPERATIONS.md` 콘솔 기능 목록·6번(수동 SQL)에 콘솔 대체 안내 반영.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브 검증은 `/api/admin` 필요 →
  배포 환경 또는 `vercel dev`. S2와 동일 제약.)
- 📌 기존 미해결 질문(아이디 변경 미구현, auth.users.email 동기 필요) **해소**.

## S10 결과 (branch: claude/hopeful-davinci-ihxezk, 주제: ifc-georef) — 라이브 검증 완료
- 🐛 **진짜 원인(라이브로 확정)**: "대상교량 A"가 **Y-up 으로 내보내진** IFC. 뷰어는 모든
  모델에 무조건 Z-up→Y-up(`-π/2` X) 회전을 적용 → Y-up 모델은 오히려 옆으로 눕는다.
  (사진: 교각이 아래가 아니라 옆으로. 사용자가 콘솔 `window.__mirUpAxis('y')` 로 똑바로
  섬을 확인.) ← 1차 가설(`COORDINATE_TO_ORIGIN` 회전 오염)은 **오답**: 그 옵션 제거로
  방향이 안 바뀐 것이 단서였음. (IfcMapConversion/TrueNorth 는 수직축 회전 → 누움 무관.)
- ✅ **수정** (`src/viewer/IfcViewer.ts` + `Workspace`):
  - `COORDINATE_TO_ORIGIN:false` + 첫 요소 원점 **이동분만** 빼 재중심화(정밀도 보존).
  - **up축 기본값 Y-up 고정**(사용자 결정): `loadIfc` 가 회전 없이(=Y-up) 그림. 다루는
    교량 IFC가 Y-up으로 내보내지므로 이게 정답. `orientGroup`/`setUpAxis` 로 모델 단위 적용.
  - 자동감지(컨텍스트 WCS·bbox·법선) 시도는 **폐기**: WCS 미선언(undefined)이고, 법선
    기반은 사각 단면 기둥 등에서 오판 위험(사용자 지적). → 단순 고정값이 맞다.
  - override 유지: 콘솔 `window.__mirUpAxis('z')` → `localStorage`(`mir.upaxis.<modelId>`)에
    모델별 기억(Z-up 모델이 나중에 들어올 때 대비). 진단 `[IFC-georef]` 로그 유지.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. (라이브: Y-up 고정으로 교량 똑바로 섬)
- 📌 **트레이드오프**: 기본 Y-up이라 **정통 Z-up IFC는 눕는다** → 그 경우 override(`'z'`)
  필요. 참고: 사용자 레포 `bim-thesis-viewer`(교량 안 누움)의 로딩/방향 처리 방식에
  맞추면 양쪽(Z/Y) 모두 정확히 처리 가능 — 세션 권한이 mir로 한정돼 직접 못 읽음(코드
  공유 시 반영). DB(`models.up_axis`) 저장으로 승격도 후보.

## S4 결과 (branch: feature/4d-simulation → main PR) — 4D 시공 시뮬레이션 1차
- ✅ 공정표 CSV 임포트: **Navisworks(한글·EUC-KR)·Fuzor(영문·UTF-8) 자동 인식**.
  헤더 기반 파서(`src/lib/schedule.ts`) — 인코딩 자동 디코딩, `OutlineNumber` 상위
  (합계) 작업 제외, 작업 유형(시공/철거/장비/임시) 정규화.
- ✅ 일정↔객체 매핑(`src/lib/fourd.ts`): **이름 매핑** + **순서 자동배정**(이름이 안
  맞으면 5% 미만 시 자동 폴백). 한 요소가 여러 작업이면 built>active>future 우선순위.
- ✅ 뷰어 연동: `IfcViewer.getElementCatalog/applyConstruction/clearConstruction`
  추가(기존 `setElementVisible` 위에서). 시공완료=원색, 진행중=주황, 미시공=숨김/반투명.
- ✅ UI(`src/components/Timeline.tsx`): 하단 패널 — 임포트·4D토글·매핑·재생(속도)·
  타임슬라이더·간트(현재시점 커서). Workspace 그리드에 `tl` 행 추가, 모델 교체 시 매핑 초기화.
- ✅ DB **설계만**: `supabase/migrations/0003_schedule.sql`(schedules/schedule_tasks/
  task_elements 다대다 + models 동일 RLS). 현재는 프론트 로컬상태+CSV로 동작.
- ✅ 샘플: `public/samples/`(두 CSV + README), 설계 문서 `docs/4D.md`.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과 + 파서 두 샘플 파싱 확인
  (Navisworks 21작업, Fuzor 59작업). 라이브 눈 검증(실 IFC+슬라이더)은 사용자 화면 권장.
- ✅ **후속 보강(동 세션)**: 철거(demolish) **생애주기** 반영(생성 후 철거→removed/숨김),
  **수동 매핑 UI**(간트 행 ＋로 선택 객체 연결), **증분 갱신**(상태 바뀐 메시만),
  **DB 저장/로드**(`src/lib/scheduleApi.ts` + 타임라인 DB 저장/불러오기/삭제, 0003 스키마).
- 📌 한계/다음: 정밀 GUID 매핑은 **기준 정립 후 보완**(사용자 결정으로 현재 미추가).
  DB 저장/로드 **라이브 검증**은 0003 적용 + 배포 환경 필요(원격 egress 제약).

## S11 결과 (branch: claude/youthful-meitner-nu7ojt, 주제: ui-refresh) — Phase 6 UI/UX 리뉴얼
- ✅ **디자인 토큰화**(`src/index.css`): 라이트 기본 + **네이비 구조색**(상단바·상태바·
  관리자 헤더) + **블루 강조**. 모든 색을 `--*` 토큰으로만 참조하도록 재작성(레이아웃·
  클래스명·반응형은 그대로 — S8 표현만 원칙). 4D 칩/간트 바의 하드코딩 색도 토큰화해
  라이트/다크 양쪽에서 가독성 확보.
- ✅ **다크모드 토글 보존**: `src/lib/theme.ts`(`<html data-theme>` + `localStorage('mir.theme')`,
  기본 light) + `src/components/ThemeToggle.tsx`. `main.tsx` 에서 `initTheme()` 렌더 전
  호출(깜빡임 방지). 토글을 로그인·프로젝트선택·워크스페이스 상단바·관리자 헤더에 배치.
- ✅ **Pretendard** 도입(`index.css` 상단 jsDelivr CDN `@import`, 동적 서브셋) + 시스템 폴백.
- ✅ **리스킨**: 로그인→프로젝트선택→워크스페이스→관리자→타임라인 순으로 표면/강조/그림자/
  라운드/입력 focus 링/고스트 버튼 적용. 기능·데이터·마이그레이션 변경 **없음**.
- ✅ **디자인 시스템 문서 분리**: `docs/DESIGN.md`(토큰 표·테마 규칙·타이포·인터랙션).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 16.76kB). 라이트/다크 눈 검증은 사용자 화면 권장.
- 📌 브랜치 메모: 요청은 `feature/ui-refresh` 였으나 원격 세션이 지정한 작업 브랜치
  `claude/youthful-meitner-nu7ojt` 에서 작업·푸시 → main 으로 PR(#14 머지됨).
- ✅ **S11 후속(브랜딩)**: 3D 뷰포트 배경 **흰색**(`IfcViewer` `scene.background=0xffffff`,
  그리드도 밝은 회색으로). 브랜드를 로고 색으로 — `BrandLogo`(SS 마크 + **MIR 회색
  / VDC 빨강**), 토큰 `--brand-gray`/`--brand-red`. 로그인·프로젝트선택·워크스페이스·
  관리자 4곳 적용. SS 마크는 공식 로고 근사 인라인 SVG(공식 에셋 받으면 교체 가능).

## S12 결과 (branch: claude/youthful-meitner-nu7ojt, 주제: branding-rename)
- ✅ **제품명 MIR_VDC → MIR SMART** (UI 전반: `BrandLogo` 워드마크 MIR(회색)/SMART(빨강),
  `index.html` 제목·파비콘, 로그인 부제). 내부 docs 일부 표기는 점진 정리.
- ✅ **공식 로고 적용**: `public/brand/ss-logo.png`(SS 마크, 인라인 SVG 근사 → 실제
  이미지로 교체), `public/brand/ssyenc-ci.png`(쌍용건설 CI). `public/samples/` 에서
  ASCII 경로로 이동.
- ✅ **로그인(메인 홈) 보강**: 우상단 **쌍용건설 CI**(다크 테마는 흰 칩 위), 좌상단
  테마 토글, 부제 "쌍용건설 스마트 건설기술 플랫폼에 오신 것을 환영합니다.", 하단
  푸터(좌: `© Copyright Ssangyong E&C. All Rights Reserved` / 우:
  `Designed by Civil Engineering Technology Team, Smart Construction Part`).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과, `dist/brand/*` 포함 확인.
- ✅ **로그인 리파인(후속)**: 부제 "스마트 건설기술 플랫폼" 굵게 강조, 우상단 쌍용 CI
  제거(테마 토글 우상단 원위치), 푸터 고급화(상단 구분선·글래스 배경·회사명 굵게·팀명
  강조색), 배경에 톤다운 블루프린트 그리드+블루 글로우(CSS, 외부 이미지 불필요).
  `ssyenc-ci.png` 는 미사용 보존.
- ✅ **로고/카드 마무리**: 로그인 로고 lg 복귀 + MIR SMART 글자를 마크 높이에 맞춰 확대
  (lg word 52px), 카드 폭 460px 로 넓혀 부제 한 줄. 푸터 최종 문구 확정
  `Designed by Civil Engineering Technology Team, Smart Construction Part`.
- 📌 **도메인(코드 밖)**: 현재 `mir-kappa...`(Vercel 자동 서브도메인). 사용자는 당분간
  Vercel 주소 유지(`mir-smart...vercel.app` 로 프로젝트명 변경은 대시보드에서), `.com`(ssyenc)
  은 사내 전산실 DNS 호스팅으로 추후 연결 예정. `mir_smart`(언더스코어)는 호스트명 불가.

## S13 결과 (branch: claude/magical-cray-dh6tb5, 주제: doc-viewers) — Phase 8 문서·미디어 뷰어 1단계
- ✅ **새 라우트 `/view/:fileId`**(`src/pages/FileViewer.tsx`) — 저장소 파일을 **새 탭**
  으로 열어 미리보기. 파일 레코드 조회(RLS) → **짧은 만료(10분) 서명 URL** 발급 →
  mime/확장자로 뷰어 분기(`src/lib/files.ts` `viewerKindFor`). App.tsx 에 `Protected` 라우트 추가.
- ✅ **데이터/스토리지**: 마이그레이션 `supabase/migrations/0004_files.sql` — `public.files`
  테이블 + RLS(멤버 select/insert, admin delete) + Storage **`docs`** 버킷 정책(모델과
  동일한 `<project_id>/<file_id>.<ext>` 경로 규칙 → 멤버만 접근). `src/lib/files.ts`:
  `listFiles/getFile/uploadFile/deleteFile/signedFileUrl` + 카테고리 판별·sizeLabel.
- ✅ **뷰어(웹 단독·서버 0원)** `src/components/viewers/`: 이미지(native `<img>`),
  동영상(native `<video>`), 오디오(native `<audio>`), **PDF=PDF.js**(페이지별 canvas
  렌더, `pdf.worker.min.mjs?url`), **Excel=SheetJS**(xlsx/xls/csv → 시트 탭 + HTML 테이블),
  **Word=mammoth.js**(docx → HTML), 텍스트(txt/md/json…). 미지원(avi/pptx/doc/hwp 등)은
  **다운로드 폴백**(`DownloadFallback`)으로 막다른 길 없음.
- ✅ **워크스페이스 연동**(`src/pages/Workspace.tsx`): 사이드바에 **`문서 · 미디어`** 섹션
  (업로드 + 목록), 항목 클릭 시 `window.open('/view/:id', '_blank')` 새 탭.
- ✅ **코드 스플리팅**: 무거운 뷰어(PDF.js/SheetJS/mammoth)를 `React.lazy`로 분리 →
  메인 번들 gzip **1006KB→650KB**. (PdfViewer/SheetViewer/DocxViewer 별도 청크 + pdf.worker)
- ✅ 검증: `npm run typecheck`·`npm run build` 통과. 라이브 눈 검증은 `docs` 버킷 생성 +
  0004 적용 후 사용자 화면 권장(원격 egress 제약).
- 📌 **배포 셋업 필요**: `0004_files.sql` 실행 + Supabase **`docs`(Private) 버킷 생성**.
  (docs/OPERATIONS.md 0-B 참고)
- ⚠️ **SheetJS 보안 한계**: npm `xlsx`는 0.18.5(prototype pollution·ReDoS advisory)만 제공,
  패치판(≥0.20.x)은 `cdn.sheetjs.com`에서만 배포되는데 **네트워크 정책 차단**. 파일은
  프로젝트 멤버만 업로드 가능(RLS)해 노출이 제한되지만, 정책 허용 시 CDN 빌드로 교체 권장.
- 🔜 **2단계(별도 세션)**: 서버 변환 파이프라인(avi→mp4, pptx/doc/hwp→PDF) — 분리.
- 📌 브랜치 메모: 작업 브랜치 `claude/magical-cray-dh6tb5`(원격 세션 지정)에서 작업·푸시.
  요청 주제명은 `feature/doc-viewers`. **PR #22 main 병합 완료.**

## 확장 기획 (PLAN, branch: claude/eager-dirac-a0dacr) — 기획창 신설 + 로드맵 재정렬
- ✅ **`docs/PLANNING.md` 신설**: 사용자가 준 7개 확장 요구를 가능여부 판단과 함께 정리.
  - ① UI 리뉴얼(화이트+네이비) → **S11 ✅ 완료** (+ S12 브랜딩 MIR SMART ✅ 완료).
  - ③ 문서·미디어 뷰어(새 탭): 이미지/PDF/mp4/xlsx/docx = 🟢, avi/pptx/doc/hwp = 🟡 서버변환
    → **하이브리드** → **S13 ✅ 완료(PR #22 병합, 1단계)**.
  - ④ CDE(ISO 19650): 좌측 "모듈+폴더트리" 재편 + 파일 저장소(버전/이력, 상태
    `WIP→Shared→Published→Archived`), 활동로그 → **S14(다음 권장)**. PR #22 가 만든 `files`
    테이블·`docs` 버킷 위에 folders/versions/status/activity 를 얹는다(마이그레이션 `0005_cde.sql`).
  - ⑤ Navisworks 기능군 → **S15 ⏳ 입력대기** · ⑥ 장비 시뮬(Rapier) → **S16 ⏳ 이미지대기**
    · ⑦ 네이티브 BIM(rvt/nwd/dwg) 🔴 → **하이브리드 권장**(IFC=web-ifc 유지, 원본은 CDE 보관/
    다운로드, 열람은 APS Viewer 또는 IFC export) → **S17 🔴 결정대기**.
- 📌 **세션번호 재정렬**: main 이 S12 를 브랜딩으로 선점 → 기획안의 S12(CDE)를 **S14** 로 이동.
  최종: S11 UI✅ · S12 브랜딩✅ · S13 문서뷰어✅ · **S14 CDE** · S15 NW · S16 장비 · S17 네이티브 · S18 스플리팅.
- ✅ `ROADMAP.md` Phase 6~10 + 세션 S11~S18 반영(재정렬).

## S14 결과 (branch: claude/busy-lovelace-cj8adq, 주제: cde-foundation) — Phase 7 CDE 토대 + 파일 저장소 MVP
- ✅ **마이그레이션 `supabase/migrations/0005_cde.sql`**(추가형, 0001~0004 무수정): `folders`
  (프로젝트 폴더트리, parent_id) · `file_versions`(파일당 다중 버전, `<project>/<file>/v<n>.<ext>`) ·
  `activity_log`(감사 이력) 신설 + `files` 에 `folder_id`(on delete set null=문서 보존) ·
  `status`(enum `file_status` WIP/Shared/Published/Archived, 기본 WIP) · `current_version_id`(FK) 추가.
  RLS는 **기존 `is_member`/`is_admin` 재사용**(file_versions 는 부모 파일의 project로 멤버십 판정).
  기존 S13 파일은 **v1 자동 백필** + `files_update` 정책 추가(상태/이동). `docs` 버킷 그대로 사용.
- ✅ **데이터층 `src/lib/cde.ts`**: 폴더 CRUD, `listCdeFiles`(폴더별), `uploadNewFile`(v1 생성),
  `uploadNewVersion`(v2+ 누적 + `files.storage_path` 최신 버전으로 재지정 → 뷰어는 항상 최신 열람),
  `listVersions`, `setFileStatus`, `moveFile`, `deleteCdeFile`(모든 버전+오브젝트, admin RLS),
  `signedUrl`, `logActivity`/`listActivity`, `buildFolderTree`.
- ✅ **화면 `/project/:id/docs`**(`src/pages/DocumentManager.tsx`) + 컴포넌트
  (`components/cde/FolderTree·StatusBadge·VersionHistory·ActivityLog`): 좌측 폴더트리(생성·이름변경·
  빈 폴더 삭제) + 우측 문서 테이블(상태 뱃지·상태 변경 select·이력·새 버전·삭제[admin]·새 탭 미리보기),
  브레드크럼, 활동 로그 모달. App.tsx 라우트 추가, 워크스페이스 상단 **`자료 관리`** 진입 버튼.
- ✅ **워크스페이스 연동**: 사이드바 `문서·미디어` 업로드를 `cde.uploadNewFile`(루트=미분류, v1+활동)로
  일원화 → 두 경로 모두 버전·활동이 일관. 기존 `/view/:fileId` 뷰어는 그대로(최신 버전 storage_path).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 25.68kB). 라이브 눈 검증은 `0005` 적용 후 권장.
- 📌 **배포 셋업 필요**: `0005_cde.sql` 실행(docs/OPERATIONS.md **0-C**). 새 버킷 불필요(0-B `docs` 재사용).
- 📌 한계/다음: 활동 로그는 actor를 username으로 미해석(profiles RLS=본인/admin만) → 시간+동작+대상명
  표시. 폴더 삭제는 빈 폴더만(클라 가드). 체크인/체크아웃·승인 워크플로우·자료전송(transmittal)·
  태그/검색은 후속. 문서 폴더 이동 UI는 데이터층(`moveFile`)만 준비(버튼 미노출).

## S24 결과 (branch: claude/busy-lovelace-cj8adq) — 권한: 쓰기는 admin만 (D11)
> 사용자 결정 "모든 건 admin 계정이 진행" → 포털·CDE·업로드의 모든 쓰기를 관리자 전용으로.
- ✅ **`0009_admin_writes.sql`**(추가형): folders·project_info·milestones·daily_logs·monthly_records·
  issues·posts·subcontracts 의 insert/update/delete + file_versions·issue_comments·files·models insert
  + Storage docs/models write 를 **`is_admin()`** 로 교체. **SELECT(멤버 열람) 전부 유지**. activity_log
  insert 만 멤버 허용(감사 기록 유지). → DECISIONS **D11** 기록.
- ✅ **UI 가드**: 비-admin 에는 모든 편집 컨트롤 숨김 — 대시보드 `편집`, 공사일보 폼/삭제, 이슈
  등록/상태/코멘트/삭제, 기성 도급액 저장, 하도급 등록/삭제, 게시판 글쓰기/삭제, CDE 폴더/업로드/
  새버전/상태/삭제, 워크스페이스 IFC·파일 업로드. 멤버는 읽기 전용으로 전 모듈 열람.
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0009_admin_writes.sql` 실행(0005~0008 이후).
- 📌 **머지**: S14·S21·S22·S23 = **PR #24 main 병합 완료**(사용자 확인용). 본 권한 변경은 별도 PR.

## S23 결과 (branch: claude/busy-lovelace-cj8adq, 주제: portal-modules-2) — Phase 13 기성·하도급·게시판
> P3 게시판 · P4 기성내역 · P5 하도급 완료 → **포털 좌측 메뉴 1차 전 모듈 동작**.
- ✅ **`0008_portal_extra.sql`**(추가형): `posts`(게시판/공지·고정) + `subcontracts`(협력사
  계약/지급/상태) + `project_info.contract_amount`(도급액). RLS 멤버 읽기/쓰기. 새 버킷 없음.
- ✅ **`src/lib/portal.ts`**: 게시판 CRUD · 하도급 CRUD · 도급액 get/save(대시보드 select 와
  **분리** → 0008 미적용 환경에서도 대시보드 안 깨짐).
- ✅ **기성내역 `Billing.tsx`**: 도급액 입력 + 누적 기성·기성률·잔여 요약 카드 + 월별 기성
  막대(MiniChart bar)·누적표(monthly_records 금액 재사용).
- ✅ **하도급내역 `Subcontracts.tsx`**: 협력사 등록/삭제 + 계약·지급 합계·지급률·협력사 수 요약.
- ✅ **게시판 `Board.tsx`**: 공지 글 작성/펼침/삭제·상단 고정.
- ✅ 좌측 메뉴: 사업개요·공정현황·공사일보·협업이슈·**기성내역·하도급내역·게시판**·모델뷰어·자료관리·구성원.
- ✅ 검증: `typecheck`·`build` 통과. 📌 배포: `0008` 실행(OPERATIONS 0-D 갱신).
- 📌 **남은(P6 폴리시)**: 마일스톤 드래그 정렬, 공사일보 사진 첨부(CDE 연계), 이슈↔문서 연결 UI,
  권한 세분화(viewer 읽기전용/editor 편집), 기성 공종별 상세, 게시판 첨부/댓글.

## S22 결과 (branch: claude/busy-lovelace-cj8adq, 주제: portal-modules) — Phase 12 공정현황 + 협업·이슈
> 사용자 지시 "다 해야 한다, 우선순위는 네가" → **P1 협업·이슈 + P2 공정현황** 먼저(핵심 협업 + 데이터 재사용).
- ✅ **P1 협업·이슈** — `0007_issues.sql`(추가형): `issues`(제목·내용·상태 open/in_progress/
  resolved/closed·우선순위·담당자·기한·관련문서 file_id) + `issue_comments`(코멘트 스레드).
  RLS 멤버 읽기/쓰기, 코멘트는 부모 이슈 프로젝트로 판정. actor는 텍스트(created_by_name/
  author_name, profiles RLS 회피 — 본인 username은 읽을 수 있어 저장). `src/lib/issues.ts` +
  `src/pages/Issues.tsx`(필터·등록 폼·상태 변경·코멘트·삭제). 대시보드에 **미해결 이슈 카드** 추가.
- ✅ **P2 공정현황** — 새 마이그레이션 없이 dashboard 데이터 재사용. `src/pages/Schedule.tsx`:
  **마일스톤 타임라인**(착공→준공 비례 위치 + 오늘 커서) + **진도 곡선(S-curve)** 계획 vs 실적
  (`MiniChart`) + 월별 차이 표 + **4D 시뮬레이션 바로가기**(viewer).
- ✅ 좌측 모듈 메뉴 확장: 사업개요·**공정현황**·공사일보·**협업·이슈**·모델뷰어·자료 관리·구성원.
  중첩 라우트 `/schedule`·`/issues` 추가.
- ✅ 검증: `npm run typecheck`·`npm run build` 통과.
- 📌 **배포 셋업**: `0007_issues.sql` 실행(0005·0006 과 함께, OPERATIONS 0-D). 새 버킷 없음.
- 📌 **남은 모듈(다음 턴)**: P3 게시판/공지 · P4 기성내역 상세 · P5 하도급내역 · P6 폴리시
  (마일스톤 드래그 정렬·공사일보 사진 첨부(CDE 연계)·권한 세분화). 이슈 file_id 연결 UI는 후속.

## S21 결과 (branch: claude/busy-lovelace-cj8adq, 주제: pmis-portal) — Phase 11 사업관리 포털
> 사용자 목표 = **PROJECT WORKS형 사업관리 포털**(좌측 모듈 메뉴 + 사업개요 대시보드).
> 기존 "3D 뷰어 중심 작업화면"을 **포털**로 재편: 프로젝트 진입 첫 화면 = 사업개요 대시보드.
- ✅ **마이그레이션 `0006_dashboard.sql`**(추가형, 0001~0005 무수정): `project_info`(착공/준공/
  전체 진행률/개요) · `project_milestones`(노반·궤도·개통 등 D-day) · `daily_logs`(공사일보:
  일자별 인력·장비·날씨·내용) · `monthly_records`(월별 계획/실적%·기성금액). RLS는 멤버 읽기 +
  멤버/admin 쓰기(folders 패턴, `is_member`/`is_admin` 재사용). **데이터는 앱에서 직접 입력·편집**(사용자 결정).
- ✅ **데이터층 `src/lib/dashboard.ts`**: project_info upsert, 마일스톤 CRUD, daily_logs CRUD,
  monthly_records upsert/삭제 + D-day/날짜/금액 포맷 헬퍼.
- ✅ **포털 셸 `ProjectShell` + `ProjectNav`**: 좌측 모듈 레일(사업개요·공사일보·모델뷰어·자료 관리·
  구성원[admin]) + 상단 크롬. 라우팅 재편: `/project/:id`=대시보드(중첩 라우트, index),
  `/project/:id/logs`=공사일보, `/project/:id/viewer`=기존 3D 워크스페이스(풀스크린 이동),
  `/project/:id/docs`=CDE. ProjectSelect→`/project/:id`는 이제 대시보드로 진입.
- ✅ **사업개요 대시보드 `Dashboard.tsx`**: 착공 D+경과·마일스톤·준공 D-day 띠, 전체 진행률 바,
  공사일지 현황(인력 추이)·기성 현황(계획vs실적%) **경량 SVG 차트**(`MiniChart`, 무의존),
  투입인력·장비현황 스탯 카드, 모델뷰어 바로가기 카드. **편집 토글**로 사업정보/마일스톤/월별 실적
  인라인 입력·저장. **공사일보 `DailyLogs.tsx`** 일자별 등록/삭제(대시보드 인력·장비·일지 수치 연동).
- ✅ 검증: `npm run typecheck`·`npm run build` 통과(CSS 29.76kB, 차트 라이브러리 무추가).
- 📌 **배포 셋업**: `0006_dashboard.sql` 실행(0005 와 함께). 새 버킷·외부 의존 없음.
- 📌 다음 후속: 공사일보 사진/첨부(CDE 연계), 기성 금액 단위·통화, 마일스톤 정렬 드래그,
  4D 공정/협업(이슈)·물량 모듈은 별도 세션. 권한 세분화(현재 멤버=편집 가능).

## 다음 할 일 (우선순위)
> **S14(CDE)~S29(PMIS 포털) 1차 마무리됨.** 배포 SQL = `supabase/setup_all.sql`(0003~0012, 멱등).
> 추가 착수 후보는 `docs/PLANNING.md` 9.백로그 참조. 사용자 결정/입력 대기 항목:
1. **백로그에서 선택**: 공정표 RLS admin화(D11 일관) · 2D 도면 이슈 핀 · 이슈 워크플로우(알림) ·
   모바일 현장 모드 · 활동/감사 통합 뷰.
2. **사용자 입력 필요**: S15(Navisworks 기능 목록), S16(장비 샘플 이미지), S17(APS 도입·예산 결정).
3. (운영) Vercel env(`SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY`) 확인 — 관리자 사용자 생성(api/admin edge).

## 미해결 질문 / 메모
- ✅ (해소) 사용자 생성 자동화 — S2 `api/admin.ts` service_role 함수 + `user_metadata.username`
  직접 주입으로 비-ASCII 보정 SQL 제거. 배포 환경 env 설정 후 라이브 검증만 남음.
- ✅ (해소) 콘솔의 username(로그인 아이디) **변경** — S9 `api/admin.ts` `renameUser`
  액션으로 username+내부 이메일 동기 변경 추가(사용자 탭 `아이디 변경` 버튼).
- 번들 크기 경고(three+web-ifc) → **S18(성능·코드 스플리팅)**. S13(PR #22)에서 무거운
  뷰어를 `React.lazy` 로 분리해 메인 번들 1006KB→650KB 로 **일부 선반영**됨.
- ✅ (해소) **뷰어 백로그**: 일부 교량 IFC 누움 → S10 에서 원인(web-ifc
  `COORDINATE_TO_ORIGIN` 의 첫 요소 회전 오염) 규명·수정. 실제 파일 눈 검증만 잔여.

## 다음 세션 인수인계 (한 줄)
> **S36 완료**: 모드전환 시 4D 시뮬 누수 버그픽스(#45) + 이슈핀 클릭 팝업(#46) + 모델/카테고리
> 표시 토글(#47) + 측정·단면 리뷰도구(#48). 마이그레이션 없음. **다음 후보**: 간섭 결과
> 그룹화/정렬/필터 · 뷰포인트 저장 · 간섭 보고서(HTML/PDF) · 자료관리 다중선택 · 자동로드 성능.
>
> **(이전) S35 완료**: 모듈 진입 시 전체 모델 자동로드 + 간섭검토 UX 7건(시뮬격리·A초록/B빨강+반투명+줌인·
> 팝업 창화'간섭검토 결과'(이동/크기조절)·이슈 모달 내용+4각도 스냅샷 첨부·4D/간섭 트리숨김·
> 대상 A/B 모델→카테고리 2단계). scheduleApi/Timeline 다모델 매핑. 마이그레이션 추가 없음.
>
> **(이전) S34 완료**: 3D 모델 풀을 **세 모듈이 공유**하도록 보정(통합모델에 올리면 4D·간섭검토에도
> 표시). `Workspace` 가 `listModels(projectId)` 전체 풀 사용, 모듈 분리는 모듈별 IfcViewer
> 인스턴스로 유지(4D 매핑이 간섭 화면 무영향). 0016 purpose 는 보존·미필터. 마이그레이션 추가 없음.
>
> **(이전) S33 완료**: 3D 모듈을 **통합모델(3D)/공정관리(4D)/간섭검토** 로 분리(D14, `models.purpose`,
> `0016_model_purpose.sql`). `Workspace` 가 `mode` 프롭으로 일반화 — 각 모듈이 자기 용도 모델만
> 보고 업로드. 통합모델=이슈 핀 토글, 4D=타임라인, 간섭=충돌검사 패널. 라우트 `/model`·`/viewer`·
> `/clash`. 배포=setup_all.sql(0003~0016). **다음**=PLANNING §9 백로그 또는 S15/S16/S17.
>
> **(이전) S32 완료**: Phase 4 충돌검사 — `three-mesh-bvh`(D13) 엔진(IfcViewer.buildClashGeom/showClash) +
> `src/lib/clash.ts`(광역 AABB→협역 BVH, 진행률 청크) + `ClashPanel`(4D 뷰어 우측 드로어, 대상 A/B·
> 허용오차·결과표·격리·CSV) + 간섭→이슈 모달(S30·0012 핀) + `0015_clash.sql`(clash_tests/clashes,
> RLS 읽기멤버/쓰기admin). 배포=setup_all.sql(0003~0015). **다음**=PLANNING §9 백로그 또는 S15/S16/S17.
>
> **(이전) S31 완료**: CDE 문서 삭제를 업로더 본인+관리자로 완화(D12, `0014_doc_delete_owner.sql`).
> files·docs 버킷 삭제 정책 + `owns_doc_object` 헬퍼, `deleteCdeFile` 순서 교체(스토리지 선삭제),
> 삭제 버튼 본인 노출. 배포=setup_all.sql(0003~0014). **다음**=PLANNING §9 백로그 선택.
>
> **S14(CDE)에서 시작한 브랜치(`claude/busy-lovelace-cj8adq`)가 PMIS 포털 전반으로 확장돼 1차 마무리.**
> 완료: CDE(폴더·버전·상태·활동·인라인 3D뷰어) + 포털(사업개요 대시보드·공정현황·공정관리4D[무클릭
> 영속화]·공사일보·협업이슈[3D객체 핀]·기성[공종별]·하도급·게시판·자료관리·구성원) + 권한 admin(D11)
> + 첨부(사진/문서). DB 마이그레이션 0003~0012, 배포는 **`supabase/setup_all.sql`** 한 번 실행(멱등).
> **다음**: `docs/PLANNING.md` 9.백로그에서 선택(공정표 RLS admin화·2D 도면 핀·이슈 워크플로우·모바일 등).
> S15(NW)·S16(장비)·S17(APS)는 사용자 입력/결정 대기.

> (이전) **S22 완료**: 공정현황(`/schedule`, 마일스톤 타임라인+S-curve+4D 바로가기) + 협업·이슈
> (`/issues`, `0007_issues.sql`: issues+issue_comments, `src/lib/issues.ts`) 모듈 추가, 좌측
> 메뉴/대시보드(미해결 이슈 카드) 반영. **배포: 0005+0006+0007 실행**(새 버킷 없음, OPERATIONS 0-C/0-D).
> 사용자 지시="포털 전체 모듈 다 만들기, 우선순위는 Claude가". **남은 우선순위**: P3 게시판 ·
> P4 기성내역 상세 · P5 하도급 · P6 폴리시(마일스톤 정렬·일보 첨부·권한 세분화) — 다음 턴 진행.

> (이전) **S21(사업관리 포털) 완료**: 프로젝트 진입 첫 화면을 **사업개요 대시보드**로 재편 + 좌측
> 모듈 메뉴(사업개요·공사일보·모델뷰어·자료 관리). `0006_dashboard.sql`(project_info/
> milestones/daily_logs/monthly_records, 앱 내 직접 입력) + `src/lib/dashboard.ts` +
> `ProjectShell`/`ProjectNav`/`Dashboard`/`DailyLogs` + 무의존 `MiniChart`. 3D 뷰어는
> `/project/:id/viewer`로 이동. **배포 셋업**: `0005`+`0006` 실행(새 버킷 불필요).
> 다음 후속: 4D 공정·협업(이슈)·물량 모듈, 권한 세분화, 공사일보 첨부. 아래 S14 기록 참고.

> (이전) S11(UI)·S12(브랜딩)·S13(문서뷰어)·**S14(CDE 토대 + 파일 저장소 MVP) 완료**(branch
> `claude/busy-lovelace-cj8adq`). `0005_cde.sql`(folders/file_versions/activity_log + files 컬럼) +
> `src/lib/cde.ts` + `/project/:id/docs`(`DocumentManager`) + `components/cde/*`. 워크스페이스
> 상단 `자료 관리` 진입. **배포 셋업 잔여**: `0005_cde.sql` 실행(OPERATIONS **0-C**, 새 버킷 불필요).
> **다음**: S14 라이브 검증 + S13 배포 셋업(OPERATIONS 0-B). S15 NW·S16 장비는 입력 대기,
> S17 네이티브는 APS 결정 후. CDE 후속(체크인/락·승인 워크플로우·transmittal·검색)은 별도 세션.
> (뷰어) S10: 교량 누움은 up축 기본 Y-up 고정으로 해결(override 콘솔 `__mirUpAxis('z')`).
