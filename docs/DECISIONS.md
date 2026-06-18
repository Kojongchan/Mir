# DECISIONS — MIR_VDC

확정된 아키텍처 결정. 바꾸려면 사용자와 합의 후 이 파일을 갱신.

| # | 결정 | 이유 |
|---|---|---|
| D1 | **웹 전용** (Three.js/WebGL). 시네마틱·초대용량은 추후 언리얼 Pixel Streaming 옵션 | 설치 없이 URL 협업, 개발·배포 빠름 |
| D2 | IFC 파싱은 **web-ifc(WASM) 직접 사용** (ThatOpen 고수준 추상화 X) | 요소(expressID)별 정밀 제어 → 4D/장비 시뮬에 유리, API 안정 |
| D3 | 백엔드는 **Supabase** (Auth+Postgres+Storage+RLS) | 관리형, 운영부담 최소, RLS로 권한 강제 |
| D4 | 로그인은 **아이디+비밀번호**, 내부적으로 `아이디@mir.local` 로 매핑 | 사용자엔 아이디만 노출, 보안은 Supabase Auth가 처리 |
| D5 | 프로젝트별 접근은 **Postgres RLS** (`project_members`) | 프론트가 뚫려도 DB가 차단 |
| D6 | 브랜치: **main 통합 + feature 브랜치 → PR 병합** | 리뷰·CI·되돌리기 용이 |
| D7 | DB 변경은 **추가형 마이그레이션** (`000N_*.sql`) | 세션 간 충돌·이력 관리 |
| D8 | 제품명 **MIR SMART** (쌍용건설 스마트 건설기술 플랫폼). 구 명칭 MIR_VDC | 사명(쌍용건설/Ssangyong E&C) 브랜딩에 맞춤 |
| D9 | 세션 시작 **SessionStart 훅**(동기)으로 `npm install` + wasm 복사 | 세션마다 즉시 개발 가능 |
| D10 | 문서 뷰어 충실도: **단기=무료 클라 라이브러리 업그레이드**(Word `docx-preview` 등) **+ 장기=서버 변환→PDF**(LibreOffice/Gotenberg 로 PPT·HWP·구포맷까지). **MS/Google 온라인 임베드는 비채택** | 클라만으론 오피스 100% 재현 불가. 서버 변환이 완성도·포맷 커버리지 최선. 외부 임베드는 **기밀 도면이 MS/Google 서버로 전송**돼 부적합 |

## 우선순위 (사용자 확정)
뷰어 → 4D → **장비운용(강점)** → 충돌검사 → VR. 포맷은 **IFC**.
