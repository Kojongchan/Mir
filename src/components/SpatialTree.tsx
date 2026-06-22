import { useEffect, useRef, useState } from 'react';
import type { SpatialNode } from '../viewer/IfcViewer';

interface Props {
  nodes: SpatialNode[];
  hiddenElems: Set<string>;
  /** Hide/show a batch of "modelID:expressID" keys (spatial 노드의 모든 하위 부재). */
  onSetHidden: (keys: string[], hidden: boolean) => void;
  selectedKey: string | null;
  onSelectElem: (modelID: number, expressID: number) => void;
}

const keyOf = (n: SpatialNode) => `${n.modelID}:${n.expressID}`;

/** 모든 하위 isElement 노드의 키 수집(공간 노드 가시성/검색용). */
function leafKeys(n: SpatialNode, acc: string[] = []): string[] {
  if (n.isElement) acc.push(keyOf(n));
  for (const c of n.children) leafKeys(c, acc);
  return acc;
}

/**
 * IFC 공간/분해 트리(추가3) — Project→Site→Building→Storey→부재 계층. 노드별 눈
 * 토글(하위 부재 일괄), 부재 클릭 시 3D 선택, 3D 선택 시 자동 펼침·스크롤.
 */
export function SpatialTree({ nodes, hiddenElems, onSetHidden, selectedKey, onSelectElem }: Props) {
  if (nodes.length === 0) {
    return (
      <ul className="model-list obj-tree">
        <li className="muted empty">공간 구조 정보가 없습니다. (카테고리 보기를 사용하세요)</li>
      </ul>
    );
  }
  return (
    <ul className="model-list obj-tree">
      {nodes.map((n) => (
        <TreeNode
          key={keyOf(n)}
          node={n}
          depth={0}
          hiddenElems={hiddenElems}
          onSetHidden={onSetHidden}
          selectedKey={selectedKey}
          onSelectElem={onSelectElem}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  hiddenElems,
  onSetHidden,
  selectedKey,
  onSelectElem,
}: {
  node: SpatialNode;
  depth: number;
  hiddenElems: Set<string>;
  onSetHidden: (keys: string[], hidden: boolean) => void;
  selectedKey: string | null;
  onSelectElem: (modelID: number, expressID: number) => void;
}) {
  const hasChildren = node.children.length > 0;
  // 상위 2단계는 기본 펼침, 그 아래는 접힘.
  const [open, setOpen] = useState(depth < 2);
  const rowRef = useRef<HTMLDivElement>(null);
  const k = keyOf(node);
  const isSel = selectedKey === k;

  // 선택된 부재를 포함하면 자동으로 펼친다.
  const containsSel = selectedKey != null && leafKeys(node).includes(selectedKey);
  useEffect(() => {
    if (containsSel) setOpen(true);
  }, [containsSel]);
  useEffect(() => {
    if (isSel) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSel]);

  const keys = leafKeys(node);
  const allHidden = keys.length > 0 && keys.every((kk) => hiddenElems.has(kk));
  const toggleVis = () => onSetHidden(keys, !allHidden);

  return (
    <li className="obj-cat">
      <div className="obj-cat-head" ref={rowRef} style={{ paddingLeft: depth * 10 }}>
        <button
          className="obj-twisty"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? '접기' : '펼치기'}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <button
          className={`obj-eye${allHidden ? ' is-off' : ''}`}
          onClick={toggleVis}
          title={allHidden ? '표시' : '숨김'}
          disabled={keys.length === 0}
        >
          {allHidden ? '🚫' : '👁'}
        </button>
        <button
          className={`obj-cat-name${isSel ? ' is-sel-name' : ''}`}
          onClick={() => (node.isElement ? onSelectElem(node.modelID, node.expressID) : setOpen((o) => !o))}
          title={`${node.name} · ${node.type}`}
        >
          <span className="obj-name">{node.name}</span>
          {hasChildren && <span className="muted">{node.children.length}</span>}
        </button>
      </div>
      {open && hasChildren && (
        <ul className="obj-elems" style={{ paddingLeft: 0 }}>
          {node.children.map((c) => (
            <TreeNode
              key={keyOf(c)}
              node={c}
              depth={depth + 1}
              hiddenElems={hiddenElems}
              onSetHidden={onSetHidden}
              selectedKey={selectedKey}
              onSelectElem={onSelectElem}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
