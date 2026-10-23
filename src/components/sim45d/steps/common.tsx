import { useContext, useState, type ReactNode } from 'react';
import { AiError, runAi, type AiTaskName } from '../../../lib/ai';
import type { SetupData, SlotKey } from '../../../lib/sim45d/setup';
import type { Sim45d } from '../useSim45d';
import { AI_OFF, AiConnectContext, MCP_PROMPT_FOR } from './aiConnect';

/** 단계 화면 공통 입력. persist 는 대상(구조물) 진행 상태를 저장(DB 또는 브라우저). */
export interface StepProps {
  projectId: string;
  canEdit: boolean;
  data: SetupData;
  name: string;
  persist: (next: SetupData) => Promise<void>;
  sim: Sim45d;
  setStatus: (s: string) => void;
  /** 자료 칸 카드(자료 준비 단계와 같은 것). */
  renderSlot: (key: SlotKey) => ReactNode;
  /** 확정 공정표(P6 칸 XER)를 열어 4D/5D·검토에 쓴다. 큰 XER 은 브라우저에 보관되지 않아 새로 열 때마다 필요. */
  openP6: () => void;
  opening: boolean;
}

/**
 * AI 호출 상태: 실행 중·오류·사용 토큰. 서버 AI(키 방식)는 쓸 때마다 사용료가 들어 꺼 두었다(D32) —
 * 키가 없으면 같은 일을 하는 AI 연결(MCP) 프롬프트를 안내한다.
 */
export function useAi(projectId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  async function call<T>(task: AiTaskName, input: unknown, label: string): Promise<T | null> {
    setBusy(label);
    setError('');
    try {
      const r = await runAi<T>(task, input, projectId);
      if (r.usage) setUsage(r.usage);
      return r.result;
    } catch (e) {
      setError(e instanceof AiError && e.code === 'not-configured'
        ? `${AI_OFF}이 버튼(플랫폼 서버 AI)은 쓸 때마다 사용료가 들어 꺼 두었습니다. 같은 일을 내 Claude·ChatGPT 에서 하세요 — 「AI 연결」로 연결 주소를 한 번 등록한 뒤 대화창에서 프롬프트 '${MCP_PROMPT_FOR[task]}' 를 고릅니다.`
        : (e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, usage, call, setError };
}

/** AI 결과 상자 — 사람이 확인할 제안이라는 표시와 함께. */
export function AiBox({ title, children, usage }: { title: string; children: ReactNode; usage?: { input: number; output: number } | null }) {
  return (
    <div className="sim-ai">
      <div className="sim-ai__head">
        <span className="sim-ai__badge">AI 제안</span>
        <strong>{title}</strong>
        <span className="spacer" />
        {usage && <span className="muted">토큰 {usage.input.toLocaleString()} / {usage.output.toLocaleString()}</span>}
      </div>
      <div className="sim-ai__body">{children}</div>
      <div className="muted sim-ai__foot">근거를 확인한 뒤 반영하세요. 공기·금액은 AI 가 아니라 플랫폼 계산값입니다.</div>
    </div>
  );
}

export function AiStatus({ busy, error }: { busy: string | null; error: string }) {
  const openConnect = useContext(AiConnectContext);
  if (busy) return <p className="muted sim-ai__busy" aria-live="polite">AI 작업 중: {busy} …(수십 초 걸릴 수 있음)</p>;
  if (error.startsWith(AI_OFF)) {
    return (
      <p className="sim-ai__off" role="status">
        {error.slice(AI_OFF.length)}
        {openConnect && <button type="button" className="btn btn--sm btn--primary" onClick={openConnect}>AI 연결 열기</button>}
      </p>
    );
  }
  if (error) return <p className="sim-error" role="alert">{error}</p>;
  return null;
}

export const fmtWon = (n: number) => `${Math.round(n).toLocaleString()}원`;
