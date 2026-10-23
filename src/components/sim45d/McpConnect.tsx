import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ModalBackdrop } from '../ModalBackdrop';
import { requestMcpUrl } from '../../lib/mcpConnect';

/**
 * AI 연결(MCP): 내 Claude·ChatGPT 에 이 플랫폼을 커넥터로 등록하는 개인 주소를 받는다(D32, 시험 구성).
 * AI 사용료는 각자의 구독 — 플랫폼은 자료를 내주고 결과를 검사·저장만 한다.
 */
export function McpConnect({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [got, setGot] = useState<{ url: string; expiresAt: string; role: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const make = async () => {
    setBusy(true); setError('');
    try { setGot(await requestMcpUrl(projectId)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!got) return;
    try { await navigator.clipboard.writeText(got.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError('복사하지 못했습니다 — 주소를 직접 선택해 복사하세요.'); }
  };

  return createPortal(
    <ModalBackdrop className="acc-modal-back sim-mcp-back" onClose={onClose}>
      <div className="acc-modal sim-mcp" role="dialog" aria-label="AI 연결" onClick={e => e.stopPropagation()}>
        <div className="acc-modal-head">
          AI 연결 — 내 Claude·ChatGPT 에서 이 플랫폼 쓰기
          <div className="spacer" />
          <button onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <p className="muted">
          개인 연결 주소를 내 AI 앱에 커넥터로 한 번 등록하면, 대화창에서 "연제교 상선 설계현황 채워줘" 처럼 시켜 플랫폼 자료를 읽고 결과를 저장하게 할 수 있습니다.
          AI 사용료는 각자의 구독이고, 공기·금액은 플랫폼이 계산합니다. <strong>시험 구성입니다.</strong>
        </p>
        {!got ? (
          <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void make()}>{busy ? '만드는 중…' : '내 연결 주소 만들기'}</button>
        ) : (
          <>
            <div className="sim-mcp__url">
              <input readOnly value={got.url} aria-label="연결 주소" onFocus={e => e.currentTarget.select()} />
              <button className="btn btn--sm btn--primary" onClick={() => void copy()}>{copied ? '복사됨' : '복사'}</button>
            </div>
            <p className="muted">만료 {got.expiresAt.slice(0, 10)} · 권한 {got.role === 'viewer' ? '조회(저장 불가)' : '저장 가능'} · <strong>주소 자체가 열쇠</strong>이니 남에게 주지 마세요(각자 만드세요).</p>
          </>
        )}
        {error && <p className="sim-error" role="alert">{error}</p>}
        <details className="sim-step__details" open>
          <summary>등록 방법</summary>
          <ul className="sim-list">
            <li>등록할 주소는 브라우저 주소창의 화면 주소가 아니라 <strong>위에서 만든 연결 주소</strong>(<code>…/api/mcp/…</code>)입니다.</li>
            <li><strong>Claude</strong>(Pro·Max·Team): 설정 → 커넥터 → 사용자 지정 커넥터 추가 → 이름 "MIR 4D/5D", 주소 붙여넣기. 대화창의 + 메뉴에서 연결을 켜고, 프롬프트(한 바퀴·설계현황·단위공기·개략 IPS·P6 검토·BIM 연결)를 골라 시작.</li>
            <li><strong>ChatGPT</strong>(Plus·Pro·Business, 웹): 설정 → 앱·커넥터 → 고급 → 개발자 모드 켜기 → 만들기 → 주소 붙여넣기(인증 없음). 저장 동작은 매번 확인을 묻습니다.</li>
            <li>연결이 안 되면: Vercel 미리보기 주소는 <strong>배포 보호(Vercel 로그인)</strong>가 켜져 있으면 Claude·ChatGPT 서버가 들어오지 못합니다 —
              시험 동안 Vercel → Settings → Deployment Protection 에서 Vercel Authentication 을 끄거나 운영 주소로 시험하세요.</li>
            <li>공통 규칙·점검표는 공유 스킬 <code>docs/skills/mir-4d5d/SKILL.md</code>(Claude 는 설정 → 기능 → 스킬에 올려 쓸 수 있음).</li>
          </ul>
        </details>
      </div>
    </ModalBackdrop>,
    document.body,
  );
}
