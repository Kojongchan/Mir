// 개략 IPS(엔진 코드 BR01-P3-F …) ↔ 모델에 이미 있는 실제 IPS Activity ID(A3_WBS CODE (IPS), 예 311311C5C20040050) 맞추기(2번 결정 10-26).
// 6단계 규칙 연결 결과로 엔진 작업마다 걸린 객체의 모델 코드를 보고, 1:1 로 대응하는 작업만 실제 코드를 받는다 — 그러면 P6·7단계 반영·4D 가
// 같은 ID 를 쓰고, 모델 반영은 코드는 그대로 두고 날짜만 바뀐다. 묶음이 다른 작업(실제 IPS 는 거치 한 작업, 개략 IPS 는 경간 5개씩)은
// 엔진 코드 그대로 둔다. 순수 함수 — 화면·AI 연결 공통.
import { autoLink, type LinkActivity, type LinkObject, type LinkResult } from './autolink.js';

export interface CodeMatch {
  /** 엔진 코드 → 실제 코드. */
  map: Record<string, string>;
  /** 실제 코드를 받은 작업 수 · 받지 못한 작업(객체가 걸렸는데) 수. */
  matched: number;
  unmatched: number;
  /** 모델 코드가 한 작업에 모이지 않은 것(묶음이 다르거나 모델 입력 오류): 실제 코드 → 그 객체가 걸린 엔진 작업들. */
  split: { real: string; draft: string[] }[];
}

/** 한 작업이 실제 코드를 받으려면: 걸린 객체의 이 비율 이상이 그 코드, 그 코드 객체의 이 비율 이상이 이 작업에. */
const PURITY = 0.9, SHARE = 0.8;

/**
 * `links`: 객체 → 엔진 코드(규칙·AI·사람 연결), `existing`: 객체 → 모델의 실제 코드(없으면 뺌).
 * 엔진 코드 A 가 실제 코드 X 를 받는 조건: A 에 걸린 객체 중 PURITY 이상이 X 이고, X 객체 중 SHARE 이상이 A 에 걸림, X 가 이미 다른 작업
 * 코드가 아님. 예: 상선 P12 기초 객체가 P2 의 코드로 잘못 들어간 경우 P2 기초는 51/52 로 받고 P12 기초는 엔진 코드로 남아 7단계에서 고쳐진다.
 */
export function matchModelCodes(links: ReadonlyMap<string, string>, existing: ReadonlyMap<string, string>, scheduleCodes: ReadonlySet<string> = new Set()): CodeMatch {
  const byDraft = new Map<string, Map<string, number>>(), realTotal = new Map<string, number>(), realTo = new Map<string, Set<string>>();
  for (const real of existing.values()) if (real) realTotal.set(real, (realTotal.get(real) ?? 0) + 1);
  for (const [obj, draft] of links) {
    const real = existing.get(obj);
    if (!real) continue;
    const m = byDraft.get(draft) ?? byDraft.set(draft, new Map()).get(draft)!;
    m.set(real, (m.get(real) ?? 0) + 1);
    (realTo.get(real) ?? realTo.set(real, new Set()).get(real)!).add(draft);
  }
  const map: Record<string, string> = {};
  const taken = new Set<string>();
  let unmatched = 0;
  for (const [draft, counts] of [...byDraft].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = [...counts.values()].reduce((s, x) => s + x, 0);
    const [real, k] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const ok = k >= PURITY * n && k >= SHARE * (realTotal.get(real) ?? k) && !taken.has(real) && (real === draft || !scheduleCodes.has(real));
    if (ok) { taken.add(real); if (real !== draft) map[draft] = real; } else unmatched++;
  }
  const split = [...realTo].filter(([real, ds]) => ds.size > 1 && ![...ds].some(d => map[d] === real || d === real))
    .map(([real, ds]) => ({ real, draft: [...ds].sort() }));
  return { map, matched: taken.size, unmatched, split };
}

/** 코드 바꾸기(없는 것은 그대로). */
export const mapCode = (map: Readonly<Record<string, string>> | undefined, code: string) => map?.[code] ?? code;

export interface LinkRun {
  /** 객체별 결과 — 코드는 맞춘 뒤의 코드(채택안이 이 코드로 다시 계산된다). */
  results: LinkResult[];
  /** 대상 WBS 의 작업(맞춘 뒤 코드) — AI·사람이 고를 목록. */
  activities: LinkActivity[];
  /** 채택안일 때 모델 코드 맞춤 결과. */
  match: CodeMatch | null;
}

/**
 * 6단계 자동 연결(화면·AI 연결 공통). 올린 P6 면 그 작업에 바로 잇는다. 채택안(개략 IPS)이면 엔진 코드 작업(`rawActs`, 같은 WBS)에 이은 뒤
 * 모델의 실제 코드와 맞춰(matchModelCodes) 결과를 실제 코드로 바꾼다 — 이미 맞춘 공정표를 열어 둔 상태에서도 같은 결과.
 */
export function linkWithCodes(objects: (LinkObject & { code?: string })[], acts: LinkActivity[], rawActs?: LinkActivity[]): LinkRun {
  if (!rawActs) return { results: autoLink(objects, acts), activities: acts, match: null };
  const raw = autoLink(objects, rawActs);
  const links = new Map(raw.filter(r => r.code).map(r => [r.id, r.code!] as const));
  const existing = new Map(objects.filter(o => o.code).map(o => [o.id, o.code!] as const));
  const match = matchModelCodes(links, existing, new Set(rawActs.map(a => a.code)));
  const m = match.map;
  return {
    results: raw.map(r => ({ ...r, code: r.code ? m[r.code] ?? r.code : null, candidates: r.candidates.map(c => m[c] ?? c) })),
    activities: rawActs.map(a => ({ ...a, code: m[a.code] ?? a.code })),
    match,
  };
}
