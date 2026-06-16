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
   - **한글 아이디**(예: `고종찬`)는 인증용 이메일을 ASCII로 인코딩해야 합니다.
     아래 헬퍼로 Email/Metadata 를 그대로 복사해 붙여넣으세요(사용자는 여전히
     로그인 화면에 한글 아이디만 입력):
     ```bash
     node scripts/username-email.mjs 고종찬 "고종찬"
     # email: u-<hex>@mir.local · metadata: {"username":"고종찬","full_name":"고종찬"}
     ```
     ⚠️ 대시보드의 빠른 "Add user" 폼은 **User Metadata 입력란이 없을 수 있습니다**.
     이 경우 한글 사용자는 생성 직후 `profiles.username` 이 hex 로 잡히므로, SQL Editor
     에서 아래를 **한 문장씩** 실행해 이름을 보정하고 프로젝트에 배정하세요
     (이메일은 위 헬퍼가 출력한 값):
     ```sql
     update public.profiles set username = '고종찬', full_name = '고종찬'
      where id = (select id from auth.users where email = 'u-<hex>@mir.local');
     ```
     ```sql
     insert into public.project_members (project_id, user_id, role)
     values ((select id from public.projects where code = '5공구'),
             (select id from auth.users where email = 'u-<hex>@mir.local'), 'editor')
     on conflict (project_id, user_id) do update set role = excluded.role;
     ```
   - Password 지정, **Auto Confirm User** 체크
   - User Metadata: `{ "username": "kim", "full_name": "김현장" }`
   - 첫 관리자는 생성 후 `profiles.is_admin = true` 로 업데이트
5. 관리자 승격 + 프로젝트/배정은 **`supabase/seed.sql`** 을 열어 사용자명만 바꿔
   SQL Editor 에서 실행합니다 (관리자 `is_admin=true`, 프로젝트 생성, 멤버 배정까지
   한 번에 · 멱등).
6. **S2 관리자 콘솔**을 쓰려면(권장): `supabase/migrations/0002_admin.sql` 실행 +
   Vercel 서버 전용 환경변수(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) 설정.
   이후 첫 관리자(5번)만 SQL로 승격하면, **그 다음부터는 화면에서** 사용자/프로젝트/
   멤버를 관리할 수 있습니다(한글 아이디 보정 SQL 불필요). 자세한 건 OPERATIONS 0-A.

> 사용자는 로그인 화면에 **아이디만** 입력합니다(`@mir.local` 은 내부 매핑, 노출 안 됨).

> 📘 **운영 중 프로젝트/사용자 추가**는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md) 참고
> (S2 이후엔 관리자 콘솔 `/admin` 화면에서 처리 — 위 4·5번 수동 절차 대체).

### 연결 검증 (브라우저 없이)

`.env` 와 위 설정이 끝나면 헤드리스 e2e 점검으로 인증·RLS·Storage 동작을 확인합니다:

```bash
TEST_USER=tester TEST_PASS=... TEST_UPLOAD=1 npm run verify:e2e
```

로그인 → RLS 프로젝트 목록 → 모델 목록 → (옵션) Storage 업로드/다운로드 왕복을
점검하고 결과를 출력합니다. `SUPABASE_URL`/`SUPABASE_ANON_KEY` 는 `.env` 에서 읽습니다.

## 배포 (Vercel)

이 앱은 정적 SPA(Vite 빌드)라 Vercel에 그대로 올라갑니다. 빌드 시 `prebuild` 훅이
web-ifc WASM 을 `public/web-ifc/` 로 복사하므로 `dist/` 결과물에 포함됩니다.

1. **프로젝트 연결**: [vercel.com](https://vercel.com) → *Add New… → Project* →
   이 GitHub 레포 import. Framework 는 `vercel.json`(`framework: "vite"`) 로 자동 감지됩니다.
   - Build Command: `npm run build` · Output Directory: `dist` (vercel.json 에 명시됨)
2. **환경변수 설정**: *Settings → Environment Variables* 에 추가
   (Production·Preview·Development 모두 체크). 값은 Supabase *Settings → API* 에서 복사:
   - **클라이언트(`VITE_` 접두사, 공개)** — 번들에 포함되어 브라우저에 노출됩니다(공개 키만):
     - `VITE_SUPABASE_URL` = `https://<your-project>.supabase.co`
     - `VITE_SUPABASE_ANON_KEY` = `anon public` 키
   - **서버 전용(접두사 없음, 비밀)** — S2 관리자 콘솔의 사용자 생성/삭제(`api/admin.ts`)용:
     - `SUPABASE_URL` = `https://<your-project>.supabase.co`
     - `SUPABASE_SERVICE_ROLE_KEY` = `service_role` 비밀키
   > ⚠️ `service_role` 키는 RLS를 우회하는 **비밀키**입니다. **`VITE_` 접두사를 절대
   > 붙이지 마세요**(붙이면 클라이언트 번들에 노출). 접두사 없는 서버 전용 변수로만
   > 두면 서버리스 함수(`/api/admin`)에서만 읽혀 안전합니다. 레포 커밋도 금지.
   > 관리자 콘솔을 쓰지 않을 거면 서버 전용 2개는 생략해도 됩니다.
3. **Deploy** → 발급된 URL 로 접속해 **로그인 → 프로젝트 선택 → IFC 열람** 동작 확인.
4. **SPA 새로고침**: `vercel.json` 의 `rewrites` 가 모든 경로를 `index.html` 로
   넘겨 react-router(`BrowserRouter`) 의 `/login` 등 직접 접속·새로고침 404 를 방지합니다.

> Supabase *Authentication → URL Configuration* 의 Site URL/Redirect URL 에 Vercel
> 배포 URL 을 추가하면 좋습니다(현재는 아이디/비번 로그인이라 필수는 아님).

### CI (빌드 체크)

`.github/workflows/ci.yml` 가 `main` 으로의 PR·푸시마다 `npm ci → typecheck → build`
를 실행합니다. 빌드 검증에는 Supabase 자격증명이 필요 없습니다(미설정 시 안전한
플레이스홀더로 폴백). 실제 런타임 연결은 Vercel 환경변수로만 주입됩니다.

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
