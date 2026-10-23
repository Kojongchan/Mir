import { supabase } from './supabase';

/** AI 연결(MCP) 개인 연결 주소 받기 — 주소 자체가 열쇠(30일). api/mcp-token. */
export async function requestMcpUrl(mirProject: string): Promise<{ url: string; expiresAt: string; role: string }> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/mcp-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(data.session ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
    body: JSON.stringify({ mirProject }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error ?? `연결 주소를 받지 못했습니다(${res.status})`);
  return body;
}
