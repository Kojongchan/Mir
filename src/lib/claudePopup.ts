/**
 * 내 Claude(claude.ai, 각자 로그인·구독)를 화면 오른쪽에 붙는 팝업으로 연다 — 플랫폼 안 iframe 은 claude.ai 가 막는다
 * (X-Frame-Options: SAMEORIGIN). 지시문은 새 대화에 미리 넣고(claude.ai/new?q= — 공식 문서 없는 기능이라 안 될 수 있음)
 * 클립보드에도 복사해 둔다. 결과는 Claude 가 MIR 커넥터(MCP)로 저장하고, 플랫폼은 진행 기록으로 보여 준다(D32).
 */
const NAME = 'mir-claude';
const WIDTH = 480;
let win: Window | null = null;

export function claudeWindowOpen(): boolean {
  return !!win && !win.closed;
}

/** 사용자 클릭 안에서 불러야 팝업 차단을 피한다(첫 await 전에). */
export function openClaude(text?: string): { opened: boolean; copied: Promise<boolean> } {
  const url = text ? `https://claude.ai/new?q=${encodeURIComponent(text)}` : 'https://claude.ai/new';
  const sx = window.screenX ?? 0, sw = window.screen?.availWidth ?? 1440, sh = window.screen?.availHeight ?? 900;
  const left = Math.max(0, Math.min(sx + window.outerWidth - WIDTH, sx + sw - WIDTH));
  win = window.open(url, NAME, `popup=yes,width=${WIDTH},height=${Math.min(sh, 1000)},left=${left},top=0`);
  win?.focus();
  const copied = text && navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
  return { opened: !!win, copied };
}
