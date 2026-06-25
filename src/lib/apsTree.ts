// =====================================================================
// APS 인스턴스 트리(모델 트리) 헬퍼 — S49-c. ACC 통합모델(nwd 등)은 구성요소
// (dwg·rvt·nwc…)와 그 하위 부재를 instanceTree 로 들고 있고, APS '모델 브라우저'가
// 그대로 보여준다. 간섭 대상 A/B 를 이 **트리 계층 그대로** 고르기 위한 순수 헬퍼.
//   childrenOf  : 한 노드의 직계 자식(지연 펼침)
// 　rootChildren: 최상위(구성요소 파일들)
//   collectLeaves: 한 노드 아래 모든 leaf dbId(간섭 대상으로 변환)
//   topLevelAncestor: leaf 의 최상위(파일) 조상(결과 시각화 격리용)
// =====================================================================

type ApsModel = any;

export interface ApsTreeNode {
  dbId: number;
  name: string;
  hasChildren: boolean;
}

function tree(model: ApsModel): any {
  return model?.getInstanceTree?.() ?? null;
}

/** 한 노드의 직계 자식 노드들(이름·자식유무 포함). */
export function childrenOf(model: ApsModel, dbId: number): ApsTreeNode[] {
  const it = tree(model);
  if (!it) return [];
  const out: ApsTreeNode[] = [];
  it.enumNodeChildren(dbId, (child: number) => {
    let n = 0;
    it.enumNodeChildren(child, () => {
      n++;
    });
    out.push({ dbId: child, name: it.getNodeName?.(child) ?? `#${child}`, hasChildren: n > 0 });
  });
  return out;
}

/**
 * 최상위 노드들(구성요소 파일). 인스턴스 트리 루트가 모델명 1개만 감싸는 흔한
 * 경우엔 그 한 단계를 자동으로 내려가 실제 파일 목록을 돌려준다.
 */
export function rootChildren(model: ApsModel): ApsTreeNode[] {
  const it = tree(model);
  if (!it) return [];
  const root = it.getRootId();
  let kids = childrenOf(model, root);
  if (kids.length === 1 && kids[0].hasChildren) {
    kids = childrenOf(model, kids[0].dbId);
  }
  return kids;
}

/** 한 노드 아래 모든 leaf dbId(실제 요소) 수집 — 간섭 대상으로 변환. */
export function collectLeaves(model: ApsModel, dbId: number): number[] {
  const it = tree(model);
  if (!it) return [];
  const out: number[] = [];
  const walk = (id: number) => {
    let n = 0;
    it.enumNodeChildren(id, (c: number) => {
      n++;
      walk(c);
    });
    if (n === 0) out.push(id);
  };
  walk(dbId);
  return out;
}

/** leaf(또는 임의 노드)의 최상위 파일 조상 dbId(결과 격리/시각화용). */
export function topLevelAncestor(model: ApsModel, dbId: number): number {
  const it = tree(model);
  if (!it) return dbId;
  const root = it.getRootId();
  // 루트가 모델명 1개만 감싸면 그 노드를 실질 루트로 본다.
  let pseudoRoot = root;
  const rk: number[] = [];
  it.enumNodeChildren(root, (c: number) => rk.push(c));
  if (rk.length === 1) pseudoRoot = rk[0];

  let cur = dbId;
  let parent = it.getNodeParent?.(cur);
  while (typeof parent === 'number' && parent !== pseudoRoot && parent !== root && parent >= 0) {
    cur = parent;
    parent = it.getNodeParent?.(cur);
  }
  return cur;
}

/** 노드 이름. */
export function nodeName(model: ApsModel, dbId: number): string {
  return tree(model)?.getNodeName?.(dbId) ?? `#${dbId}`;
}
