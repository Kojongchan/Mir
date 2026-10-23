// 공정표 WBS 에서 연결 대상 범위 고르기(순수 함수) — 6단계 화면과 AI 연결(MCP)이 같이 쓴다.
import type { P6Schedule } from '../p6/schedule';
import type { LinkActivity } from './autolink';

export interface WbsNode {
  id: string;
  /** 들여쓰기 + 이름(같은 이름이 여러 단계에 있으면 상위 이름을 붙임) + 하위 작업 수. */
  label: string;
  name: string;
  /** 루트부터 이름 경로. */
  path: string[];
  count: number;
}

export function wbsScope(s: P6Schedule, maxDepth = 6) {
  const byId = new Map(s.wbs.map(w => [w.id, w]));
  const chain = (id: string) => { const out: string[] = []; for (let w = byId.get(id); w; w = w.parentId ? byId.get(w.parentId) : undefined) out.unshift(w.id); return out; };
  const counts = new Map<string, number>();
  for (const a of s.activities) for (const id of chain(a.wbsId)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const shown = s.wbs.filter(w => (counts.get(w.id) ?? 0) > 0 && chain(w.id).length <= maxDepth);
  const dup = new Set(shown.map(w => w.name).filter((n, i, all) => all.indexOf(n) !== i));
  // 같은 이름이 여러 단계에 있으면(예: 연제교(상선) 이 준비공·구조물공 양쪽) 상위 이름을 붙여 구분
  const nodes: WbsNode[] = shown.map(w => {
    const parent = w.parentId ? byId.get(w.parentId)?.name : undefined;
    const name = dup.has(w.name) && parent ? `${w.name} — ${parent}` : w.name;
    const depth = chain(w.id).length;
    return { id: w.id, name, path: chain(w.id).map(id => byId.get(id)!.name), label: `${'　'.repeat(Math.max(0, depth - 2))}${name} (${counts.get(w.id)})`, count: counts.get(w.id)! };
  });
  /** rootId 아래 작업(경로는 root 다음부터). */
  const under = (rootId: string): LinkActivity[] => s.activities.flatMap(a => {
    const c = chain(a.wbsId), i = c.indexOf(rootId);
    return i < 0 ? [] : [{ code: a.code, name: a.name, path: c.slice(i + 1).map(id => byId.get(id)!.name) }];
  });
  return { nodes, under };
}
