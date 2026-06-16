# MIR_VDC

MIR_Virtual Design & Construction.

웹 기반 BIM 시각화 · 4D/장비운용 시뮬레이션 협업 플랫폼.
사용자는 **아이디로 로그인**해 **본인이 배정된 프로젝트(공구)** 만 선택해 들어가,
해당 프로젝트의 IFC 모델을 열람·시뮬레이션합니다.

## 기술 스택

- **프론트엔드**: Vite + React + TypeScript + react-router
- **3D**: Three.js (WebGL2) + **web-ifc** (브라우저 내 IFC 파싱)
- **백엔드(BaaS)**: **Supabase** — Auth(로그인) · Postgres(DB) · Storage(IFC 파일) · RLS(프로젝트별 권한)
- **상태관리**: Zustand
- (예정) **Rapier(WASM)** 장비운용 물리, **WebXR** VR

## 로드맵

| 단계 | 내용 | 상태 |
|---|---|---|
| **Phase 0** | 인증 + 프로젝트별 접근권한 + 데이터 저장 (로그인→프로젝트 선택→모델 업로드/열람) | ✅ 구현(설정 대기) |
| Phase 1 | 3D IFC 뷰어 (탐색·선택·속성·표시제어) | ✅ 구현 |
| Phase 2 | 4D 시공 시뮬레이션 | ⏳ |
| Phase 3 | 장비운용 시뮬레이션 (강점) | ⏳ |
| Phase 4 | 충돌 검사 | ⏳ |
| Phase 5 | WebXR VR | ⏳ |

## 권한 모델 (프로젝트별 접근)

```
profiles(id, username, is_admin)         ← auth.users 와 1:1, 로그인 아이디
projects(id, name, code)                 ← '평택-오송 5공구' 등
project_members(project_id, user_id, role)  ← 누가 어느 프로젝트에 접근
models(id, project_id, name, storage_path)  ← 프로젝트별 IFC 파일
```

Postgres **Row Level Security**가 "내가 멤버인 프로젝트의 데이터만 조회"를 DB 레벨에서 강제합니다.
프론트엔드가 뚫려도 남의 프로젝트 자료는 노출되지 않습니다.

## 로컬 개발

```bash
npm install
cp .env.example .env       # Supabase URL/anon key 입력
npm run dev                # http://localhost:5173
npm run build
npm run typecheck
```

## Supabase 설정 (1회)

1. [supabase.com](https://supabase.com) 에서 프로젝트 생성 → **Settings → API** 의
   `Project URL`, `anon public key` 를 `.env` 에 입력
2. **SQL Editor** 에서 `supabase/migrations/0001_init.sql` 실행 (테이블·RLS·트리거)
3. **Storage** 에서 **비공개(private) 버킷 `models`** 생성
4. 관리자/사용자 생성 — **Authentication → Users → Add user**:
   - Email: `<아이디>@mir.local` (예: `kim@mir.local`)  ← 사용자에겐 `kim` 만 노출
   - Password 지정, **Auto Confirm User** 체크
   - User Metadata: `{ "username": "kim", "full_name": "김현장" }`
   - 첫 관리자는 생성 후 `profiles.is_admin = true` 로 업데이트
5. 프로젝트/배정 추가 (SQL 또는 추후 관리자 UI):
   ```sql
   insert into projects (name, code) values ('평택-오송 5공구', '5공구');
   insert into project_members (project_id, user_id, role)
   values ('<project_id>', '<user_id>', 'editor');
   ```

> 사용자는 로그인 화면에 **아이디만** 입력합니다(`@mir.local` 은 내부 매핑, 노출 안 됨).

## 보안 / 백업

- 🔐 HTTPS/TLS, 비밀번호 해싱·세션은 Supabase Auth가 처리 / 옵션 2FA
- 🔐 프로젝트별 RLS + 역할(viewer/editor/admin)
- 🔐 비밀키는 `.env`(gitignore)·호스팅 시크릿에만 — 레포 커밋 금지. `service_role` 키는 프론트엔드에 절대 X
- 💾 Postgres 자동 백업 + PITR, Storage 버전관리 / 분기별 복구 테스트 권장

## 아키텍처 메모

- `src/viewer/IfcViewer.ts` — 명령형 Three.js+web-ifc 엔진. 요소별 메시 맵
  (`expressID → Mesh[]`)으로 4D/장비 시뮬레이션의 요소 단위 제어 기반 제공.
- `src/auth/*`, `src/lib/supabase.ts`, `src/lib/api.ts` — 인증·데이터 접근.
- `src/pages/*` — 로그인 / 프로젝트 선택 / 작업공간(뷰어).

> **검증 상태**: 타입체크·프로덕션 빌드 통과. 인증·RLS·Storage의 **런타임 동작은
> 실제 Supabase 프로젝트 연결 후** 확인이 필요합니다(현재 환경엔 자격증명 없음).
