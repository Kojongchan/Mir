// =====================================================================
// MIR — AI 연결(MCP) 개인 연결 주소의 토큰. 서명(HMAC-SHA256) + 만료, 서버에 저장하지 않는다(시험 구성).
// 토큰 = base64url(JSON {u: 사용자, p: 프로젝트, exp: ms}) + '.' + base64url(서명).
// 비밀값: MCP_TOKEN_SECRET, 없으면 SUPABASE_SERVICE_ROLE_KEY 에서 유도. 개별 폐기는 못 한다 —
// 비밀값을 바꾸면 전부 무효(운영 전 OAuth·폐기 목록으로 바꿀 것, docs/IPS_4D5D.md 12절).
// 엣지(api/mcp-token)와 Node(api/mcp/[key]) 둘 다에서 돌도록 WebCrypto 만 쓴다.
// =====================================================================

export interface McpClaims {
  /** MIR 사용자 id. */
  u: string;
  /** MIR 프로젝트 id. */
  p: string;
  /** 만료(ms). */
  exp: number;
}

export const MCP_TOKEN_DAYS = 30;

export function mcpSecret(): string | null {
  const own = process.env.MCP_TOKEN_SECRET;
  if (own) return own;
  const role = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return role ? `mir-mcp-v1:${role}` : null;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signMcpToken(claims: McpClaims, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** 서명·만료가 맞으면 내용, 아니면 null. */
export async function verifyMcpToken(token: string, secret: string, now = Date.now()): Promise<McpClaims | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(body))) as McpClaims;
    if (typeof c.u !== 'string' || typeof c.p !== 'string' || typeof c.exp !== 'number' || c.exp < now) return null;
    return c;
  } catch {
    return null;
  }
}
