import { createContext } from 'react';
import type { AiTaskName } from '../../../lib/ai';

/**
 * 단계 화면의 AI 를 내 Claude 창(팝업, 각자 로그인·구독)으로 넘기는 연결(D32).
 * askClaude: 그 작업의 지시문으로 Claude 창을 연다. openConnect: 커넥터 등록 안내(처음 한 번).
 */
export interface AiConnect {
  /** extra: 사용자가 적은 글(크리티컬 포인트 원문·질문 등) — 지시문 뒤에 붙인다. */
  askClaude: (task: AiTaskName, extra?: string) => void;
  openConnect: () => void;
}
export const AiConnectContext = createContext<AiConnect | null>(null);

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

/** Claude 창에 넣을 지시문 — 대상 이름을 넣어 커넥터 도구를 바로 쓰게 한다. */
/** 서버 AI 작업 + AI 연결(커넥터)로만 하는 일. */
export type AskTask = AiTaskName | 'cycle' | 'compareDates' | 'modelSync';

export function claudeAsk(task: AskTask, target: string, extra?: string): string {
  const base = claudeAskBase(task, target);
  return extra?.trim() ? `${base}${task === 'qa' ? '' : '\n\n'}${extra.trim()}` : base;
}

function claudeAskBase(task: AskTask, target: string): string {
  const t = `MIR 4D/5D 에서 '${target}'`;
  const confirm = '저장 전에는 표로 보여 주고 내 확인을 받아.';
  switch (task) {
    case 'designExtract': return `${t} 설계현황을 채워줘. 수량산출서·개소별 집계표에서 개소(A1, P1…)마다 말뚝 종류·본수·확대기초를, 교각 높이(기둥)는 설계 도면의 교각 일반도에서 근거(파일·쪽)와 함께 찾고, ${confirm}`;
    case 'ratesExtract': return `${t} 단위공기를 시공계획에서 근거(쪽·인용)와 함께 찾아 지금 값과 비교해 줘. '가정' 값부터. 바꿀 것만 ${confirm}`;
    case 'criticalPoints': return `${t} 크리티컬 포인트(야간 구간·작업 금지 기간·착수 가능일·우선 시공·기한)를 아래 내 메모(없으면 나에게 물어)로 정리하고, 플랫폼으로 공기를 다시 계산해 비교해 줘. ${confirm}`;
    case 'explainCheck': case 'diffSummary': return `${t} 확정 공정표를 검토해서 오류(선후행·구조 순서 역전)부터 우선순위와 P6 에서 할 일을 정리해 줘.`;
    case 'dailyActuals': return `${t} 작업일보에서 실적 시작·완료일 후보를 찾아 표로 정리해 줘(제안만, P6 반영은 사람이).`;
    case 'linkLeftovers': return `${t} BIM 연결을 마무리해 줘. 규칙이 못 정한 객체만 근거와 함께 작업을 고르고, ${confirm}`;
    case 'boqClassify': return `${t} 산출내역서 구간 항목을 A(형상 직접)/B(형상 파생)/C(모델 없음)/D(간접비)와 부위로 분류해 표로 보여 줘.`;
    case 'qa': return `${t} 공정·공사비에 대해 질문할게: `;
    case 'compareDates': return `${t} 원본 모델(RVT)의 공정 날짜(A5 실적·계획)와 개략 IPS A/B/C 를 compare_model_dates 로 비교해 줘. 어느 안이 현장에 가장 가까운지, 작업 기간 차이로 고칠 단위공기, 현장 시공 순서를 크리티컬 포인트로 넣을지 제안하고, 바꿀 것은 ${confirm}`;
    case 'modelSync': return `${t} 7단계 모델 반영 전에 확정 공정표·연결 결과를 점검해 줘: 확정 공정표에 없는 코드로 저장된 연결, 상부 객체처럼 연결이 비는 곳, 모델에 이미 있는 현장 일정을 덮어쓸 위험을 정리해 줘.`;
    case 'cycle': return `${t} 를 한 바퀴 진행해 줘: 설계현황(교각 높이는 도면) → 단위공기 → 개략 IPS(과업시작일은 나에게 물어, 내가 고른 안을 채택 = 확정 공정표) → P6 검토 → BIM 연결. 이미 짠 공정표가 올라가 있으면(list_targets 의 confirmedSchedule) 앞 단계는 건너뛸지 묻고 P6 검토부터. 단계마다 결과를 보여 주고, ${confirm}`;
  }
}

/** 서버 AI 가 꺼져 있다는 오류 표시: `AI_OFF:<task>|<문구>`. */
export const AI_OFF = 'AI_OFF:';
