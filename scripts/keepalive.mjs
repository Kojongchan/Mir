#!/usr/bin/env node
// =====================================================================
// MIR_VDC — Supabase keep-alive ping.
// 무료 플랜은 약 7일간 요청이 없으면 프로젝트를 자동 일시정지(pause)한다.
// 이 스크립트는 프로젝트의 PostgREST 엔드포인트에 가벼운 요청을 보내
// "활동"을 발생시켜 자동 정지를 막는다. GitHub Actions cron 에서 주기적으로
// 실행한다 (.github/workflows/keepalive.yml).
//
// 필요한 값 (아무 것도 커밋하지 말 것 — GitHub Secrets 로 주입):
//   SUPABASE_URL       (또는 VITE_SUPABASE_URL)   프로젝트 URL
//   SUPABASE_ANON_KEY  (또는 VITE_SUPABASE_ANON_KEY) anon(public) 키
//
// anon 키만 쓰므로 RLS 를 우회하지 않는다(안전). 응답이 빈 배열이어도
// Postgres 에 실제 쿼리가 도달하므로 활동으로 집계된다.
// =====================================================================

const URL_ = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
  .trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
const KEY = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '')
  .trim().replace(/^["']|["']$/g, '');

if (!URL_ || !KEY) {
  console.error('✗ missing SUPABASE_URL / SUPABASE_ANON_KEY (set them as GitHub Secrets)');
  process.exit(1);
}

// PostgREST 루트: apikey 헤더와 함께 GET 하면 200(OpenAPI 스펙)을 반환한다.
// 특정 테이블/RLS 정책에 의존하지 않으면서 DB(PostgREST)에 요청을 보낸다.
const endpoint = `${URL_}/rest/v1/`;

const started = Date.now();
try {
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    // 응답 본문은 필요 없으므로 무시. 상태 코드만 확인한다.
  });
  const ms = Date.now() - started;

  // 2xx/3xx/401/404 등 어떤 응답이든 "프로젝트가 요청을 받았다"는 뜻이므로
  // 자동 정지 방지 목적은 달성된다. 네트워크 실패만 오류로 취급한다.
  if (res.status >= 500) {
    console.error(`✗ keep-alive got server error ${res.status} (${ms}ms) → ${URL_}`);
    process.exit(1);
  }
  console.log(`✓ keep-alive ping ok: HTTP ${res.status} in ${ms}ms → ${URL_}`);
} catch (e) {
  console.error(`✗ keep-alive request failed: ${e?.message || e}`);
  process.exit(1);
}
