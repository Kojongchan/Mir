import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const TITLE = 'R2 model motion cache';
const TEST_BRANCH = 'feature/3d-streaming-stability';

export default async function handler(req: Request): Promise<Response> {
  if (!['GET', 'POST'].includes(req.method)) return reply({ error: 'method not allowed' }, 405);
  const env = process.env;
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const ref = env.VERCEL_GIT_COMMIT_REF || env.GH_REF;
  if (!supabaseUrl || !env.SUPABASE_SERVICE_ROLE_KEY || !env.GH_REPO || !env.GH_TOKEN) {
    return reply({ error: '서버의 저장소 작업 연결 설정을 확인해야 합니다.' }, 503);
  }
  if (ref !== TEST_BRANCH) return reply({ error: '최신 3D 테스트 배포에서 실행해 주세요.' }, 403);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: '로그인이 필요합니다.' }, 401);
  const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply({ error: '로그인을 다시 확인해 주세요.' }, 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const { data: profile } = await admin.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  if (!profile?.is_admin) {
    if (!projectId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)) return reply({ error: '프로젝트 관리자 권한이 필요합니다.' }, 403);
    const { data: membership, error: memberError } = await admin.from('project_members').select('role')
      .eq('project_id', projectId).eq('user_id', data.user.id).maybeSingle();
    if (memberError || membership?.role !== 'admin') return reply({ error: '프로젝트 관리자 권한이 필요합니다.' }, 403);
  }
  const base = `https://api.github.com/repos/${env.GH_REPO}`;
  const headers = { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'mir-storage-maintenance', 'content-type': 'application/json' };
  try {
    const response = await fetch(`${base}/actions/workflows/convert-4d.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=30`, { headers });
    if (!response.ok) return reply({ error: `작업 상태 조회 실패 (${response.status}). 서버 GitHub 연결 권한을 확인해야 합니다.` }, 502);
    const payload = await response.json();
    const runs = (payload.workflow_runs ?? []).filter((r: { display_title: string }) => r.display_title === TITLE);
    const active = runs.find((r: { status: string }) => r.status !== 'completed');
    const since = url.searchParams.get('since');
    const sinceMs = since ? Date.parse(since) : 0;
    if (since && !Number.isFinite(sinceMs)) return reply({ error: 'invalid request time' }, 400);
    const run = active ?? runs.find((r: { created_at: string }) => !since || Date.parse(r.created_at) >= sinceMs - 1000);
    if (req.method === 'GET' || active) {
      if (!run) return reply({ state: since && Date.now() - sinceMs < 300000 ? 'pending' : 'idle' });
      return reply({ state: run.status === 'completed' ? run.conclusion === 'success' ? 'success' : 'failed' : 'running',
        runUrl: run.html_url, startedAt: run.created_at });
    }
    // Standard GitHub-hosted runner only; refuse paid private-repository execution.
    const repoResponse = await fetch(base, { headers });
    if (!repoResponse.ok || (await repoResponse.json()).private !== false) {
      return reply({ error: '무료 실행 조건을 확인하지 못해 작업을 시작하지 않았습니다.' }, 409);
    }
    let body: { urn?: string };
    try { body = await req.json(); } catch { return reply({ error: '선택한 모델 정보가 필요합니다.' }, 400); }
    if (!body.urn || typeof body.urn !== 'string' || body.urn.length > 4096) return reply({ error: '모델을 먼저 열어 주세요.' }, 400);
    const prefix = body.urn.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
    if (!prefix) return reply({ error: '모델 식별자를 확인하지 못했습니다.' }, 400);
    const requestedAt = new Date().toISOString();
    const dispatch = await fetch(`${base}/actions/workflows/convert-4d.yml/dispatches`, {
      method: 'POST', headers, body: JSON.stringify({ ref, inputs: { diag_only: 'motion-cache', item: prefix } }),
    });
    if (!dispatch.ok) return reply({ error: `경량 파일 생성 시작 실패 (${dispatch.status}). 기존 파일은 변경하지 않았습니다.` }, 502);
    return reply({ state: 'pending', requestedAt }, 202);
  } catch { return reply({ error: '저장소 작업 서버에 연결하지 못했습니다. 잠시 후 상태를 다시 확인해 주세요.' }, 502); }
}
