# Mir BIM

웹 기반 BIM 시각화 · 4D/장비운용 시뮬레이션 플랫폼 (Fuzor 유사 기능 목표).

브라우저만으로 IFC 모델을 열고, 시공 순서(4D)와 장비 운용을 시뮬레이션하며,
충돌 검사와 VR 검토까지 수행하는 것을 목표로 합니다. 설치·서버 GPU 없이
URL 하나로 접근/협업할 수 있는 것이 핵심 강점입니다.

## 기술 스택

- **Vite + TypeScript + React** — 앱 셸 / UI
- **Three.js (WebGL2)** — 3D 렌더링
- **web-ifc (WASM)** — 브라우저 내 IFC 파싱
- **Zustand** — 상태 관리
- (예정) **Rapier (WASM)** — 장비운용 물리/관절 시뮬레이션
- (예정) **WebXR** — VR 몰입형 검토

## 로드맵

| 단계 | 기능 | 상태 |
|---|---|---|
| Phase 1 | 3D IFC 뷰어 (로드·탐색·선택·속성·표시제어) | ✅ 구현 |
| Phase 2 | 4D 시공 시뮬레이션 (일정↔객체, 타임슬라이더) | ⏳ 예정 |
| Phase 3 | 장비운용 시뮬레이션 (크레인·굴착기 관절+물리) | ⏳ 예정 |
| Phase 4 | 충돌 검사 (간섭 검출·리포트) | ⏳ 예정 |
| Phase 5 | WebXR VR 검토 | ⏳ 예정 |

## Phase 1 기능

- `.ifc` 파일 로드 → 요소(expressID)별 Three.js 메시 생성
- 궤도/팬/줌 카메라 (OrbitControls)
- 클릭 선택 + 하이라이트, IFC 타입/이름/속성 표시
- 표시 제어: 맞춤 / 숨기기 / 격리 / 전체 표시
  (4D 타임라인에서 시간축 표시 제어의 기반)

## 개발

```bash
npm install
npm run dev      # http://localhost:5173  (web-ifc WASM 자동 복사)
npm run build    # 프로덕션 빌드
npm run typecheck
```

> `scripts/copy-wasm.mjs`가 `node_modules/web-ifc`의 WASM을 `public/web-ifc/`로
> 복사합니다(`predev`/`prebuild`에서 자동 실행). WASM은 파생물이라 git에 포함하지 않습니다.

## 아키텍처 메모

- `src/viewer/IfcViewer.ts` — 명령형 Three.js+web-ifc 엔진. 요소별 메시 맵
  (`expressID → Mesh[]`)을 보관해, 4D/장비 시뮬레이션에서 요소 단위의
  표시·색상·변환 제어가 가능하도록 설계.
- `src/store/useStore.ts` — UI 상태(선택/로딩/상태바).
- `src/components/*` — 툴바, 속성 패널.

> 참고: Phase 1은 빌드·타입체크·dev 서버·WASM 서빙까지 검증되었습니다.
> 실제 IFC 모델 로드의 브라우저 런타임 동작은 샘플 모델로 추가 확인이 필요합니다.
