// =====================================================================
// MIR — AI 작업 실행(공정·공사비 단계형 진행, D30). POST /api/ai { task, input, mirProject }
//
// 작업 정의(프롬프트·출력 JSON 형식)는 api/_ai-tasks.ts 에만 있다 — 브라우저는 작업 이름과 입력만 보낸다.
// 모델: 아래 MODEL 상수, 구조화 출력(json_schema), 거절 시 서버 측 대체 모델(fallbacks 'default').
// 실무자(editor) 이상만(비용). 응답은 처음부터 200 으로 열고 기다리는 동안 공백을 흘려 보내(프록시 유휴 끊김 방지),
// 끝에 JSON 한 덩어리를 쓴다 — { ok, result, usage } 또는 { error }. JSON.parse 는 앞 공백을 무시한다.
// Node 런타임 + Web 핸들러(POST): 엣지로 두었을 때 이 함수가 들어간 커밋부터 배포가 실패했다(10-23). SDK 가
// Node 전용 모듈(fs·child_process — 인증 파일 읽기용)을 품고 있어 엣지 번들과 맞지 않는다고 본다. 로컬 모듈은 Node ESM 이라 .js 를 붙인다.
//
// Required env: ANTHROPIC_API_KEY + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// =====================================================================
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { AI_TASKS } from './_ai-tasks.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const MODEL = 'claude-opus-5-5';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function allowed(req: Request, mirProject: string | undefined): Promise<Response | null> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return null; // 로컬 개발
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'missing bearer token' }, 401);
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data, error } = await supa.auth.getUser(bearer);
  if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).single();
  if (prof?.is_admin) return null;
  if (mirProject) {
    const { data: mem } = await supa.from('project_members').select('role').eq('project_id', mirProject).eq('user_id', data.user.id).maybeSingle();
    if (mem?.role === 'editor' || mem?.role === 'admin') return null;
  }
  return json({ error: 'AI 기능은 실무자 이상만 쓸 수 있습니다.' }, 403);
}

export async function POST(req: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'AI 키가 설정되지 않았습니다(관리자: Vercel 환경변수 ANTHROPIC_API_KEY).', code: 'not-configured' }, 503);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid body' }, 400); }
  const task = AI_TASKS[String(body?.task ?? '')];
  if (!task) return json({ error: `모르는 작업: ${body?.task}` }, 400);
  const denied = await allowed(req, body?.mirProject);
  if (denied) return denied;
  const problem = task.check(body.input);
  if (problem) return json({ error: problem }, 400);

  const client = new Anthropic();
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const keepAlive = setInterval(() => ctrl.enqueue(enc.encode(' ')), 8000);
      const finish = (payload: unknown) => { clearInterval(keepAlive); ctrl.enqueue(enc.encode(JSON.stringify(payload))); ctrl.close(); };
      try {
        const msg = await client.beta.messages.stream({
          model: MODEL,
          max_tokens: task.maxTokens,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: task.effort, format: { type: 'json_schema', schema: task.schema } },
          system: task.system,
          messages: [{ role: 'user', content: task.user(body.input) }],
        }).finalMessage();
        if (msg.stop_reason === 'refusal') return finish({ error: 'AI 가 이 요청을 처리하지 않았습니다(안전 정책). 입력을 확인해 주세요.' });
        if (msg.stop_reason === 'max_tokens') return finish({ error: 'AI 응답이 길이 한도에서 잘렸습니다. 입력을 나눠 다시 시도하세요.' });
        const text = msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
        let result: unknown;
        try { result = JSON.parse(text); } catch { return finish({ error: 'AI 응답 형식 오류' }); }
        finish({ ok: true, result, model: msg.model, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } });
      } catch (e) {
        const status = e instanceof Anthropic.APIError ? e.status : undefined;
        finish({ error: status === 429 ? 'AI 요청이 몰렸습니다. 잠시 후 다시 시도하세요.' : `AI 오류${status ? `(${status})` : ''}: ${(e as Error).message}` });
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
