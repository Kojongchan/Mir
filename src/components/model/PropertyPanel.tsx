import { useEffect, useMemo, useState } from 'react';
import type { ModelTree } from '../../viewer/ModelTree';

export type ObjectProps = { p: [string, string, unknown, string?][]; x?: string };

const SHOWN = 300; // result rows listed; highlight/zoom act on every match

/**
 * Right panel: search the model by name or type (highlight / zoom to every match), and the selected
 * object's properties grouped by category with its place in the tree.
 */
export function PropertyPanel({ tree, selected, loadProps, onSelect, onZoom, onHighlight }: {
  tree: ModelTree;
  selected: number | null;
  loadProps: (dbId: number) => Promise<ObjectProps | null>;
  onSelect: (id: number, zoom: boolean) => void;
  onZoom: (ids: number[]) => void;
  onHighlight: (ids: number[] | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [highlighted, setHighlighted] = useState(false);
  const [props, setProps] = useState<{ id: number; data: ObjectProps | null; error?: string } | null>(null);

  // Search after typing pauses (250k names per pass).
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const result = useMemo(() => (term ? tree.search(term) : null), [tree, term]);
  useEffect(() => { setHighlighted(false); onHighlight(null); }, [result, onHighlight]);

  useEffect(() => {
    if (selected === null) { setProps(null); return; }
    let alive = true;
    setProps({ id: selected, data: null });
    loadProps(selected)
      .then(data => { if (alive) setProps({ id: selected, data }); })
      .catch(e => { if (alive) setProps({ id: selected, data: null, error: (e as Error).message }); });
    return () => { alive = false; };
  }, [selected, loadProps]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; value: string }[]>();
    for (const [category, label, value, unit] of props?.data?.p ?? []) {
      const list = map.get(category || '기타') ?? [];
      list.push({ label, value: `${typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value)}${unit ? ` ${unit}` : ''}` });
      map.set(category || '기타', list);
    }
    return [...map.entries()];
  }, [props]);

  return (
    <div className="prop-panel">
      <div className="prop-panel__search">
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="객체 검색 (이름 · 유형)" aria-label="객체 검색" />
        {result && (
          <div className="prop-panel__search-bar">
            <span className="muted">{result.total.toLocaleString()}건</span>
            <div className="spacer" />
            <button type="button" className={`btn btn--sm${highlighted ? ' btn--primary' : ''}`} disabled={!result.total}
              title="검색된 객체를 모두 주황색으로 강조합니다"
              onClick={() => { const on = !highlighted; setHighlighted(on); onHighlight(on ? result.ids : null); }}>
              {highlighted ? '강조 해제' : '모두 강조'}
            </button>
            <button type="button" className="btn btn--sm" disabled={!result.total} onClick={() => onZoom(result.ids)} title="검색된 객체가 모두 보이도록 확대">확대</button>
          </div>
        )}
        {result && result.total > 0 && (
          <ul className="prop-panel__results">
            {result.ids.slice(0, SHOWN).map(id => (
              <li key={id}>
                <button type="button" className={selected === id ? 'is-selected' : ''} onClick={() => onSelect(id, true)}>
                  <span>{tree.name(id)}</span>
                  {tree.type(id) && <span className="muted">{tree.type(id)}</span>}
                </button>
              </li>
            ))}
            {result.total > SHOWN && <li className="muted prop-panel__more">외 {(result.total - SHOWN).toLocaleString()}건 (강조·확대는 전체에 적용)</li>}
          </ul>
        )}
      </div>

      <div className="prop-panel__body">
        {selected === null ? (
          <p className="muted prop-panel__hint">3D 화면이나 트리에서 객체를 선택하면 속성이 표시됩니다.</p>
        ) : (
          <>
            <div className="prop-panel__title">
              <strong>{tree.name(selected)}</strong>
              {tree.type(selected) && <span className="muted">{tree.type(selected)}</span>}
            </div>
            <nav className="prop-panel__path" aria-label="트리 경로">
              {tree.path(selected).slice(0, -1).map(id => (
                <button key={id} type="button" onClick={() => onSelect(id, false)}>{tree.name(id)}</button>
              ))}
            </nav>
            {props?.error && <p className="muted">속성을 불러오지 못했습니다: {props.error}</p>}
            {!props?.data && !props?.error && <p className="muted">속성 불러오는 중…</p>}
            {props?.data && !groups.length && <p className="muted">표시할 속성이 없습니다.</p>}
            {groups.map(([category, rows], i) => (
              <details key={category} className="prop-panel__group" open={i < 4}>
                <summary>{category} <span className="muted">{rows.length}</span></summary>
                <dl>
                  {rows.map((r, j) => (
                    <div key={j} className="prop-panel__row"><dt>{r.label}</dt><dd>{r.value}</dd></div>
                  ))}
                </dl>
              </details>
            ))}
            {props?.data?.x && <p className="muted prop-panel__ext">External ID · {props.data.x}</p>}
          </>
        )}
      </div>
    </div>
  );
}
