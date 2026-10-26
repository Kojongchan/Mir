// 확정 공정표 = 5단계에 올린 P6 공정표(사람이 이미 짠 것 또는 P6 에서 고친 것) 또는 4단계에서 채택한 개략 IPS(D34·D35).
// 새로 만드는 경우 처음에는 P6 공정표가 없다 — 플랫폼이 만든 안을 그대로 쓰면 올릴 필요가 없고, 고쳤을 때만 올린다.
// 채택안은 투입안(장비·작업조 수)만 저장하고, 공정표는 지금 저장된 설계현황·단위공기·크리티컬 포인트로 엔진이 다시 만든다
// (화면·AI 연결이 같은 함수를 써서 같은 공정표가 나온다).
import { buildBridgePlan, DEFAULT_RATES, type PlanResult, type Rate } from '../p6/bridgePlan.js';
import { buildXer, readSchedule, type P6Schedule } from '../p6/schedule.js';
import { encodeXer, serializeXer } from '../p6/xer.js';
import type { PlanSettings, SetupData, SetupFile } from './setup.js';

/** 단위공기 표: 기본값 + 사람·AI 가 근거와 함께 바꾼 값. */
export const planRates = (plan?: PlanSettings): Rate[] => DEFAULT_RATES.map(r => {
  const v = plan?.rates[r.key];
  return v != null ? { ...r, value: v, source: plan?.rateNotes?.[r.key] ?? `사용자 수정(기본 ${r.value}${r.unit} — ${r.source})`, assumed: false } : r;
});

/** 채택한 개략 IPS 를 다시 계산한다. 채택하지 않았거나 설계현황·과업시작일이 없으면 null. */
export function adoptedPlan(data: SetupData): PlanResult | null {
  const plan = data.plan;
  if (!data.site || !plan?.start || !plan.adopted) return null;
  return buildBridgePlan({ site: data.site, start: plan.start, rates: planRates(plan), criticalPoints: plan.criticalPoints }, plan.adopted.levers);
}

export type ConfirmedSource =
  | { kind: 'p6'; file: SetupFile; label: string }
  | { kind: 'draft'; title: string; at: string; label: string };

/** 지금 확정 공정표가 무엇인가 — P6 수정본이 우선. 둘 다 없으면 null. */
export function confirmedSource(data: SetupData): ConfirmedSource | null {
  const f = data.files.p6?.[0];
  if (f) return { kind: 'p6', file: f, label: `올린 P6 공정표 ${f.name}` };
  const a = data.plan?.adopted;
  if (a && data.site && data.plan?.start) return { kind: 'draft', title: a.title, at: a.at, label: `채택한 개략 IPS(${a.title})` };
  return null;
}

export const NO_CONFIRMED = '확정 공정표가 아직 없습니다 — 4단계 개략 IPS 에서 안을 채택하거나, 이미 짠(또는 P6 에서 고친) 공정표를 5단계에 올리세요.';

/** 채택안 공정표(P6 와 같은 형태 — 검토·BIM 연결·4D 가 그대로 쓴다). */
export function adoptedSchedule(data: SetupData): P6Schedule | null {
  const r = adoptedPlan(data);
  return r ? readSchedule(buildXer(r.draft)) : null;
}

/** 채택안 XER(P6 로 가져가거나 4D 로 열 때). */
export const planXerBytes = (r: PlanResult): Uint8Array => encodeXer(serializeXer(buildXer(r.draft)), 'cp949');
export const planXerName = (code: string | undefined, title: string) => `${code || 'IPS'}_개략IPS_${title.split(' ')[0]}.xer`;
