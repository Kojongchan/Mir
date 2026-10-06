import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelTree } from '../../viewer/ModelTree';

const ROW = 24;

/**
 * Left panel: the loaded model's object tree (files → layers → objects), like Navisworks' selection
 * tree. Rows are virtualized (a file can hold tens of thousands of objects). The checkbox hides or shows
 * a whole branch; clicking a name selects it. `reveal` expands and scrolls to an object picked in 3D.
 */
export function ModelTreePanel({ tree, hiddenNodes, selected, reveal, onToggle, onSelect }: {
  tree: ModelTree;
  hiddenNodes: ReadonlySet<number>;
  selected: number | null;
  reveal: number | null;
  onToggle: (id: number, visible: boolean) => void;
  onSelect: (id: number) => void;
}) {
  // Open the roots, and a single root's children (the appended files of an integrated model).
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(tree.roots.length === 1 ? tree.roots : []));
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: { id: number; depth: number }[] = [];
    const walk = (ids: ArrayLike<number>, depth: number) => {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        out.push({ id, depth });
        if (expanded.has(id)) walk(tree.children(id), depth + 1);
      }
    };
    walk(tree.roots, 0);
    return out;
  }, [tree, expanded]);

  // An object picked in 3D: open its ancestors and bring its row into view.
  useEffect(() => {
    if (reveal === null) return;
    const path = tree.path(reveal);
    setExpanded(prev => {
      const next = new Set(prev);
      for (const id of path.slice(0, -1)) next.add(id);
      return next;
    });
  }, [reveal, tree]);
  useEffect(() => {
    if (reveal === null || !box.current) return;
    const index = rows.findIndex(r => r.id === reveal);
    if (index < 0) return;
    const top = index * ROW, el = box.current;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ROW) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [reveal, rows]);

  const hiddenBy = (id: number) => {
    for (let cur = id, guard = 0; cur > 0 && guard < 256; cur = tree.parent[cur], guard++) if (hiddenNodes.has(cur)) return true;
    return false;
  };
  const toggleOpen = (id: number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 10);
  return (
    <div className="model-tree" ref={box} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} role="tree" aria-label="모델 트리">
      <div style={{ height: rows.length * ROW, position: 'relative' }}>
        {rows.slice(first, last).map(({ id, depth }, i) => {
          const count = tree.childCount(id);
          const hidden = hiddenBy(id);
          return (
            <div key={id} role="treeitem" aria-expanded={count ? expanded.has(id) : undefined} aria-selected={selected === id}
              className={`model-tree__row${selected === id ? ' is-selected' : ''}${hidden ? ' is-hidden' : ''}`}
              style={{ top: (first + i) * ROW, paddingLeft: 4 + depth * 14 }}>
              <button type="button" className="model-tree__caret" tabIndex={-1} disabled={!count} onClick={() => toggleOpen(id)}
                aria-label={expanded.has(id) ? '접기' : '펼치기'}>{count ? (expanded.has(id) ? '▾' : '▸') : ''}</button>
              <input type="checkbox" checked={!hidden} disabled={hidden && !hiddenNodes.has(id)} title={hidden ? '보이기' : '숨기기'}
                onChange={e => onToggle(id, e.target.checked)} />
              <button type="button" className="model-tree__name" onClick={() => onSelect(id)} onDoubleClick={() => count && toggleOpen(id)}
                title={tree.type(id) ? `${tree.name(id)} · ${tree.type(id)}` : tree.name(id)}>
                {tree.name(id)}
                {count > 0 && <span className="model-tree__count">{count.toLocaleString()}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
