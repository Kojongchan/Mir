# OPERATIONS — MIR_VDC 운영 가이드

> 일상 운영(프로젝트·사용자 추가) 절차. **S2 관리자 콘솔**이 나오기 전까지는 아래처럼
> Supabase 대시보드에서 수동으로 처리합니다. 모든 작업은 브라우저 대시보드
> (Authentication = 계정, SQL Editor = 권한/배정)에서 합니다.

## 0. 개념 한 줄
- 사용자는 **아이디**로 로그인 → 내부적으로 `아이디 → 이메일`로 변환되어 Auth에 저장.
- **무엇을 볼 수 있는지**는 `project_members` 에 줄이 있어야 정해짐 (없으면 로그인은
  되지만 프로젝트가 안 보임). 관리자(`is_admin=true`)는 모든 프로젝트를 봄.

---

## 1. 프로젝트(공구) 추가

**SQL Editor** → New query → 아래 실행:
```sql
insert into public.projects (name, code) values ('서울-춘천 3공구', '3공구');
```
- `name` = 화면에 보일 이름, `code` = 짧은 식별자(공구 번호 등).
- 추가 후 사용자를 배정해야 보입니다 → **2번**의 배정 SQL 참고.

---

## 2. 사용자 추가

### 2-A. 영어/숫자 아이디 (예: `kim`)
1) **계정 생성** — Authentication → Users → Add user → Create new user
   - Email: `kim@mir.local` (아이디 + `@mir.local`)
   - Password 입력, **Auto Confirm User 체크** → Create
   - (브라우저 비번 유출 경고 팝업이 떠도 `확인` 누르고 무시 — 브라우저 경고일 뿐)
2) **프로젝트 배정** — SQL Editor (한 문장씩 Run):
```sql
insert into public.project_members (project_id, user_id, role)
values (
  (select id from public.projects where code = '5공구'),    -- 배정할 프로젝트 코드
  (select id from public.profiles where username = 'kim'),  -- 방금 만든 아이디
  'editor'                                                   -- viewer | editor | admin
)
on conflict (project_id, user_id) do update set role = excluded.role;
```

### 2-B. 한글 아이디 (예: `김현장`)
한글은 이메일에 직접 못 쓰므로 **인코딩된 이메일**을 사용합니다.

1) **이메일 뽑기** — 프로젝트 폴더의 터미널에서:
```bash
node scripts/username-email.mjs 김현장 "김현장"
# 출력: email : u-xxxx@mir.local   ← 이 값을 복사
```
2) **계정 생성** — Authentication → Add user → Create new user
   - Email: 위에서 나온 `u-xxxx@mir.local`
   - Password 입력, **Auto Confirm User 체크** → Create
3) **이름 보정 + 프로젝트 배정** — SQL Editor (한 문장씩 Run, 이메일은 1)에서 나온 값):
```sql
update public.profiles
   set username = '김현장', full_name = '김현장'
 where id = (select id from auth.users where email = 'u-xxxx@mir.local');
```
```sql
insert into public.project_members (project_id, user_id, role)
values (
  (select id from public.projects where code = '5공구'),
  (select id from auth.users where email = 'u-xxxx@mir.local'),
  'editor'
)
on conflict (project_id, user_id) do update set role = excluded.role;
```
> 왜 보정이 필요? 대시보드의 빠른 "Add user" 폼은 User Metadata 입력란이 없어,
> 한글 사용자는 `profiles.username` 이 임시로 hex 값으로 잡힙니다. 위 update 로 한글
> 이름으로 바로잡습니다. (S2 자동가입에서 이 단계가 사라질 예정)

### 2-C. 관리자(admin) 지정
관리자는 **모든 프로젝트**를 보고 모델 삭제 등 권한을 가집니다(배정 불필요).
```sql
update public.profiles set is_admin = true where username = 'kim';
```

---

## 3. 역할(role)
- `viewer` — 보기 전용
- `editor` — 모델(IFC) 업로드 가능
- `admin` — (프로젝트 관리 권한, 추후 기능 확장)

역할 변경:
```sql
update public.project_members set role = 'viewer'
 where project_id = (select id from public.projects where code = '5공구')
   and user_id    = (select id from public.profiles where username = 'kim');
```

배정 해제(프로젝트에서 제거):
```sql
delete from public.project_members
 where project_id = (select id from public.projects where code = '5공구')
   and user_id    = (select id from public.profiles where username = 'kim');
```

---

## 4. 참고
- 초기 일괄 셋업은 `supabase/seed.sql` (관리자 승격 + 프로젝트 + 멤버 배정, 멱등).
- 연결/권한 점검은 `npm run verify:e2e` (자세한 건 README "연결 검증" 참고).
- 이 수동 절차는 **S2 관리자 콘솔**에서 화면 버튼으로 자동화 예정.
