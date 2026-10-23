import { createContext } from 'react';
import type { AiTaskName } from '../../../lib/ai';

/** 「AI 연결」(MCP) 창 열기 — 단계 화면의 AI 버튼이 꺼져 있을 때 안내에서 바로 연다(D32). */
export const AiConnectContext = createContext<(() => void) | null>(null);

/** 서버 AI 작업과 같은 일을 하는 AI 연결 프롬프트(api/_mcp-tools.ts registerMcpPrompts). */
export const MCP_PROMPT_FOR: Record<AiTaskName, string> = {
  designExtract: 'design_status',
  ratesExtract: 'unit_rates',
  criticalPoints: 'draft_ips',
  explainCheck: 'p6_review',
  diffSummary: 'p6_review',
  dailyActuals: 'p6_review',
  linkLeftovers: 'bim_link',
  boqClassify: 'cycle',
  qa: 'cycle',
};

/** 서버 AI 가 꺼져 있다는 오류 표시(이 앞머리가 붙은 오류는 AI 연결 안내로 보여 준다). */
export const AI_OFF = 'AI_OFF:';
