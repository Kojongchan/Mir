import { supabase } from './supabase';

/**
 * AI 작업 호출(/api/ai). 작업 이름과 입력만 보낸다 — 프롬프트·출력 형식은 서버(api/_ai-tasks.ts)에 있다.
 * 서버는 기다리는 동안 공백을 흘려 보내고 끝에 JSON 하나를 쓴다.
 */
export type AiTaskName =
  | 'criticalPoints' | 'explainCheck' | 'diffSummary' | 'designExtract' | 'ratesExtract'
  | 'dailyActuals' | 'boqClassify' | 'qa' | 'linkLeftovers';

export class AiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

let configured: Promise<boolean> | null = null;

/** 서버 AI(키 방식)를 쓸 수 있나. 한 번만 묻고 기억한다. 못 물으면 '없음'(D32: 기본은 내 Claude 창). */
export function serverAiConfigured(): Promise<boolean> {
  configured ??= fetch('/api/ai').then(r => (r.ok ? r.json() : { configured: false })).then(j => !!j?.configured).catch(() => false);
  return configured;
}

export async function runAi<T>(task: AiTaskName, input: unknown, mirProject: string): Promise<{ result: T; usage?: { input: number; output: number } }> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(data.session ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
    body: JSON.stringify({ task, input, mirProject }),
  });
  const text = await res.text();
  let body: { ok?: boolean; result?: T; error?: string; code?: string; usage?: { input: number; output: number } };
  try { body = JSON.parse(text); } catch { throw new AiError(`AI 서버 응답 오류(HTTP ${res.status})`); }
  if (!res.ok || !body.ok) throw new AiError(body.error ?? `AI 오류(HTTP ${res.status})`, body.code);
  return { result: body.result as T, usage: body.usage };
}
