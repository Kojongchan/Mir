import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementMeta } from '../viewer/IfcViewer';

interface Props {
  meta: ElementMeta[];
  query: string;
  hiddenCats: Set<string>;
  hiddenElems: Set<string>;
  onToggleCat: (cat: string) => void;
  onToggleElem: (key: string) => void;
  /** "modelID:expressID" of the currently selected element (3D ↔ tree 연동). */
  selectedKey: string | null;
  onSelectElem: (modelID: number, expressID: number) => void;
}

const keyOf = (m: ElementMeta) => `${m.modelID}:${m.expressID}`;

/**
 * 객체 트리(추가2) — 로드된 모든 요소를 카테고리별로 묶어 보여준다. 카테고리/개별
 * 객체마다 가시성 눈 토글, 객체 클릭 시 3D 선택(연동). 3D에서 객체를 고르면 해당
 * 카테고리가 자동으로 펼쳐지고 그 행으로 스크롤된다.
 */
export function ObjectTree({
  meta,
  query,
  hiddenCats,
  hiddenElems,
  onToggleCat,
  onToggleElem,
  selectedKey,
  onSelectElem,
}: Props) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCat = new Map<string, ElementMeta[]>();
    for (const m of meta) {
      if (q && !m.category.toLowerCase().includes(q) && !(m.name ?? '').toLowerCase().includes(q)) continue;
      const arr = byCat.get(m.category) ?? [];
      arr.push(m);
      byCat.set(m.category, arr);
    }
    return [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [meta, query]);

  // 선택된 객체가 속한 카테고리(자동 펼침용).
  const selectedCat = useMemo(() => {
    if (!selectedKey) return null;
    return meta.find((m) => keyOf(m) === selectedKey)?.category ?? null;
  }, [meta, selectedKey]);

  if (groups.length === 0) {
    return <ul className="model-list obj-tree"><li className="muted empty">객체가 없습니다.</li></ul>;
  }

  return (
    <ul className="model-list obj-tree">
      {groups.map(([cat, items]) => (
        <CatNode
          key={cat}
          cat={cat}
          items={items}
          catHidden={hiddenCats.has(cat)}
          hiddenElems={hiddenElems}
          onToggleCat={onToggleCat}
          onToggleElem={onToggleElem}
          selectedKey={selectedKey}
          forceOpen={selectedCat === cat}
          onSelectElem={onSelectElem}
        />
      ))}
    </ul>
  );
}

function CatNode({
  cat,
  items,
  catHidden,
  hiddenElems,
  onToggleCat,
  onToggleElem,
  selectedKey,
  forceOpen,
  onSelectElem,
}: {
  cat: string;
  items: ElementMeta[];
  catHidden: boolean;
  hiddenElems: Set<string>;
  onToggleCat: (cat: string) => void;
  onToggleElem: (key: string) => void;
  selectedKey: string | null;
  forceOpen: boolean;
  onSelectElem: (modelID: number, expressID: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // 대량 카테고리 렉 방지(성능): 한 번에 렌더하는 행 수를 제한하고 '더 보기'로 확장.
  const PAGE = 150;
  const [limit, setLimit] = useState(PAGE);
  // 3D에서 이 카테고리의 객체를 선택하면 자동으로 펼친다.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const shown = items.slice(0, limit);

  return (
    <li className="obj-cat">
      <div className="obj-cat-head">
        <button className="obj-twisty" onClick={() => setOpen((o) => !o)} aria-label={open ? '접기' : '펼치기'}>
          {open ? '▾' : '▸'}
        </button>
        <button
          className={`obj-eye${catHidden ? ' is-off' : ''}`}
          onClick={() => onToggleCat(cat)}
          title={catHidden ? '카테고리 표시' : '카테고리 숨김'}
        >
          {catHidden ? '🚫' : '👁'}
        </button>
        <button className="obj-cat-name" onClick={() => setOpen((o) => !o)} title={cat}>
          <span className="obj-name">{cat}</span>
          <span className="muted">{items.length}</span>
        </button>
      </div>
      {open && (
        <ul className="obj-elems">
          {shown.map((m) => {
            const k = keyOf(m);
            const hidden = hiddenElems.has(k) || catHidden;
            return (
              <li key={k} className={`obj-elem${selectedKey === k ? ' is-sel' : ''}`}>
                <button
                  className={`obj-eye${hidden ? ' is-off' : ''}`}
                  onClick={() => onToggleElem(k)}
                  title={hidden ? '객체 표시' : '객체 숨김'}
                  disabled={catHidden}
                >
                  {hidden ? '🚫' : '👁'}
                </button>
                <ElemRow
                  label={m.name || `#${m.expressID}`}
                  active={selectedKey === k}
                  onClick={() => onSelectElem(m.modelID, m.expressID)}
                />
              </li>
            );
          })}
          {items.length > limit && (
            <li className="obj-more">
              <button onClick={() => setLimit((n) => n + PAGE * 4)}>
                더 보기 (+{Math.min(PAGE * 4, items.length - limit)} / 남은 {items.length - limit})
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function ElemRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button ref={ref} className="obj-elem-name" onClick={onClick} title={label}>
      <span className="obj-name">{label}</span>
    </button>
  );
}
