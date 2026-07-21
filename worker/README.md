# MIR APS 변환 워커 (ACC 모델 → XKT)

Vercel 서버리스(≤60초)로는 큰 BIM 모델 변환을 못 끝낸다. 이 워커는 **시간 제한 없는
컨테이너**(Railway 등)에서 돌며 변환 결과를 **Supabase 공용 캐시**에 올린다.
변환은 **모델당 1회** — 이후 모든 사용자는 v1 이 캐시에서 즉시 로드한다.

```
v1(/api/aps-convert) --POST /convert {urn}--> 워커
  워커: 즉시 {status:'processing'} + 백그라운드 변환
  워커: SVF→glTF(svf-utils)→XKT(convert2xkt)
        → Supabase 'models' 버킷  aps-xkt/{sha1(urn)}/model.xkt  업로드
v1: GET /api/aps-convert?urn 폴링 → 캐시에 뜨면 xeokit 로드
```

## 환경변수 (호스트에서 설정)

| 변수 | 값 |
|---|---|
| `APS_CLIENT_ID` / `APS_CLIENT_SECRET` | v1 APS 앱 것 재사용 |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role 키(서버 전용 비밀) |
| `WORKER_SECRET` | v1(Vercel)의 `WORKER_SECRET` 과 **똑같은** 임의 문자열 |
| `PORT` | 호스트가 자동 주입(미설정 시 8080) |

## 엔드포인트
- `GET /health` → `{ok:true}`
- `POST /convert` (헤더 `x-worker-secret`) body `{urn}` → `{ready:true}` | `{status:'processing'}`

## 로컬 실행
```bash
cd worker && npm install && npm start
```

## Railway 배포 요약
1. Railway → New Project → Deploy from GitHub repo → 이 레포 선택.
2. Service Settings → **Root Directory = `worker`** (중요: 레포 루트 아님).
3. Variables 에 위 환경변수 입력.
4. 배포되면 생기는 공개 URL(예: `https://mir-aps-worker.up.railway.app`)을
   Vercel 의 `WORKER_URL` 로 설정.
