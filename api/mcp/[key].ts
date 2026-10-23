// =====================================================================
// MIR — AI 연결(MCP) 서버. 사용자가 자기 Claude(사용자 지정 커넥터)·ChatGPT(개발자 모드)에 개인 연결 주소
//   https://<사이트>/api/mcp/<개인 토큰>
// 를 등록하면, 그 AI 가 플랫폼 자료를 읽고 결과를 저장한다 — AI 사용료는 각자의 구독(D32, 시험 구성).
// Streamable HTTP, 상태 없음(요청마다 서버를 만든다), JSON 응답. 도구는 api/_mcp-tools.ts.
// 권한: 토큰 서명·만료 확인 → 요청마다 프로젝트 멤버 역할 확인(빠지면 바로 막힘). 저장은 실무자 이상.
// Node 런타임: PDF 글 읽기(pdfjs)·큰 XER 처리에 엣지 메모리(128MB)가 모자라다.
// Required env: APS_CLIENT_ID / APS_CLIENT_SECRET + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (+ 선택 MCP_TOKEN_SECRET).
// =====================================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { accFileBytes, modelObjects, pdfText } from '../_mcp-acc.js';
import { mcpStore } from '../_mcp-store.js';
import { mcpSecret, verifyMcpToken } from '../_mcp-token.js';
import { MCP_INSTRUCTIONS, registerMcpPrompts, registerMcpTools } from '../_mcp-tools.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const deny = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), { status, headers: { 'content-type': 'application/json' } });

async function sheetRows(bytes: Uint8Array): Promise<unknown[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets['내역서'] ?? wb.Sheets[wb.SheetNames.find(n => /내역/.test(n)) ?? wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
}

async function handle(req: Request): Promise<Response> {
  const key = decodeURIComponent(new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '');
  const secret = mcpSecret();
  const store = mcpStore();
  if (!secret || !store) return deny(503, 'AI 연결이 설정되지 않았습니다(서버 환경변수).');
  if (!process.env.APS_CLIENT_ID || !process.env.APS_CLIENT_SECRET) return deny(503, 'APS 환경변수 미설정');
  const claims = await verifyMcpToken(key, secret);
  // 401 을 주면 Claude·ChatGPT 가 OAuth 로그인 등록을 시도하다 엉뚱한 오류("로그인 서비스에 등록할 수 없습니다")를 낸다
  // — 이 주소는 OAuth 가 아니라 주소 자체가 열쇠이므로 404 로 답한다.
  if (!claims) return deny(404, '연결 주소가 틀렸거나 만료되었습니다 — 플랫폼 「AI 연결」에서 새로 받으세요.');
  const role = await store.role(claims.u, claims.p);
  if (!role) return deny(403, '이 프로젝트의 멤버가 아닙니다.');

  const server = new McpServer({ name: 'mir-4d5d', title: 'MIR 공정·공사비(4D/5D)', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  registerMcpTools(server, {
    projectId: claims.p, userId: claims.u, role, store,
    acc: { fileBytes: accFileBytes, pdfText, modelObjects },
    sheetRows,
  });
  registerMcpPrompts(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
