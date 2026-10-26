// 4D(8단계) 색칠용 작업 → 화면 객체(3차 뷰어 dbId). 화면 모델(현장 통합 NWD 등)은 6단계에서 연결한 모델(구조물 RVT·IFC)과 다른 파일이라
// 객체 번호가 다르다 — 통합 모델에 들어 있는 원본 속성(요소 IfcGUID · UniqueId)으로 찾는다(연제교 상선 833객체 모두 있음, 10-26 확인).
// 6단계 연결이 없는 객체는 모델 속성 A3_WBS CODE (IPS) 가 공정표 작업 코드와 같으면 그 작업(실제 IPS 를 올렸거나 모델 코드로 맞춘 채택안).
// 화면 쪽 찾기는 속성 색인(useModelIndex.lookupValues, 'label value' 정확히 같음).
import type { LinkSet } from './setup';

const GUID = 'IfcGUID', UID = 'UniqueId';
const CODE_LABELS = ['A3_WBS CODE (IPS)', 'A3_WBS CODE(IPS)'];

/** 속성 색인에 물을 항목들. */
export function linkEntries(links: LinkSet['links'], codes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const l of links) {
    if (l.ifcGuid) out.add(`${GUID} ${l.ifcGuid}`);
    if (l.ext) { out.add(`${UID} ${l.ext}`); out.add(`${GUID} ${l.ext}`); } // IFC 로 연결했으면 외부 ID 가 곧 IfcGUID
  }
  for (const c of codes) for (const label of CODE_LABELS) out.add(`${label} ${c}`);
  return [...out];
}

export interface ResolvedLinks {
  /** 작업 코드 → 화면 객체(요소 노드 — 칠할 때는 하위까지). */
  byCode: Map<string, number[]>;
  /** 6단계 연결 중 화면 모델에서 찾은 것 · 못 찾은 것 · 모델 코드로 이은 객체. */
  found: number;
  missing: number;
  byModelCode: number;
}

/** 색인 답(`found`: 항목 → 객체)으로 작업별 객체를 만든다. 6단계 연결이 모델 코드보다 우선. 공정표에 없는 코드는 뺀다. */
export function resolveLinks(links: LinkSet['links'], codes: readonly string[], found: Readonly<Record<string, number[]>>): ResolvedLinks {
  const inSchedule = new Set(codes);
  const owner = new Map<number, string>();
  let ok = 0, missing = 0, byModelCode = 0;
  for (const l of links) {
    if (!inSchedule.has(l.code)) continue;
    const ids = (l.ifcGuid && found[`${GUID} ${l.ifcGuid}`]?.length ? found[`${GUID} ${l.ifcGuid}`] : null)
      ?? (l.ext && found[`${UID} ${l.ext}`]?.length ? found[`${UID} ${l.ext}`] : null)
      ?? (l.ext && found[`${GUID} ${l.ext}`]?.length ? found[`${GUID} ${l.ext}`] : null);
    if (!ids) { missing++; continue; }
    ok++;
    for (const id of ids) owner.set(id, l.code);
  }
  for (const c of codes) {
    for (const label of CODE_LABELS) {
      for (const id of found[`${label} ${c}`] ?? []) if (!owner.has(id)) { owner.set(id, c); byModelCode++; }
    }
  }
  const byCode = new Map<string, number[]>();
  for (const [id, c] of owner) (byCode.get(c) ?? byCode.set(c, []).get(c)!).push(id);
  for (const ids of byCode.values()) ids.sort((a, b) => a - b);
  return { byCode, found: ok, missing, byModelCode };
}
