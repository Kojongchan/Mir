import { useEffect, useMemo, useState } from 'react';
import type { ModelTree } from '../../viewer/ModelTree';

export type ObjectProps = { p: [string, string, unknown, string?][]; x?: string };
export type ValueSearch = (query: string, onProgress: (done: number, total: number) => void) => Promise<number[]>;

const SHOWN = 300; // result rows listed; highlight/zoom act on every match

type Section = { id: number; groups: [string, { label: string; value: string }[]][]; ext?: string; rich: boolean };

function groupsOf(data: ObjectProps | null): Section['groups'] {
  const map = new Map<string, { label: string; value: string }[]>();
  for (const [category, label, value, unit] of data?.p ?? []) {
    const list = map.get(category || '기타') ?? [];
    list.push({ label, value: `${typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value)}${unit ? ` ${unit}` : ''}` });
    map.set(category || '기타', list);
  }
  return [...map.entries()];
}

/**
 * Right panel: search the model by name/type, optionally by property values too (highlight / zoom to
 * every match), and the selected object's properties. In Navisworks exports the picked node is often
 * plain geometry (Item only) while the design data (element, family, material, schedule…) sits on its
 * parent objects, so the parents' properties are listed below, nearest first.
 */
export function PropertyPanel({ tree, selected, loadProps, searchValues, onSelect, onZoom, onHighlight }: {
  tree: ModelTree;
  selected: number | null;
  loadProps: (dbId: number) => Promise<ObjectProps | null>;
  searchValues: ValueSearch;
  onSelect: (id: number, zoom: boolean) => void;
  onZoom: (ids: number[]) => void;
  onHighlight: (ids: number[] | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [byValue, setByValue] = useState(false);
  const [valueHits, setValueHits] = useState<{ term: string; ids: number[] } | null>(null);
  const [valueNote, setValueNote] = useState('');
  const [highlighted, setHighlighted] = useState(false);
  const [sections, setSections] = useState<{ id: number; list: Section[]; loading: boolean; error?: string } | null>(null);

  // Search after typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!byValue || !term) { setValueHits(null); setValueNote(''); return; }
    let alive = true;
    setValueNote('속성 값 검색 중…');
    searchValues(term, (done, total) => { if (alive) setValueNote(`속성 색인 불러오는 중 ${done}/${total}`); })
      .then(ids => { if (alive) { setValueHits({ term, ids }); setValueNote(''); } })
      .catch(e => { if (alive) setValueNote(`속성 값 검색 실패: ${(e as Error).message}`); });
    return () => { alive = false; };
  }, [byValue, term, searchValues]);
  const result = useMemo(() => {
    if (!term) return null;
    const byName = tree.search(term);
    if (!byValue || valueHits?.term !== term) return byName;
    const ids = [...new Set([...byName.ids, ...valueHits.ids])].sort((a, b) => a - b);
    return { total: ids.length, ids };
  }, [tree, term, byValue, valueHits]);
  useEffect(() => { setHighlighted(false); onHighlight(null); }, [result, onHighlight]);

  // The selected object, then its parents (nearest first) that carry more than the Item basics.
  useEffect(() => {
    if (selected === null) { setSections(null); return; }
    let alive = true;
    const chain = tree.path(selected).reverse();
    setSections({ id: selected, list: [], loading: true });
    Promise.all(chain.map(id => loadProps(id).then(data => ({ id, data }))))
      .then(rows => {
        if (!alive) return;
        const list = rows.map(({ id, data }) => {
          const groups = groupsOf(data);
          return { id, groups, ext: data?.x, rich: groups.some(([c]) => c !== 'Item' && c !== '항목') };
        }).filter((s, i) => i === 0 || s.rich);
        setSections({ id: selected, list, loading: false });
      })
      .catch(e => { if (alive) setSections({ id: selected, list: [], loading: false, error: (e as Error).message }); });
    return () => { alive = false; };
  }, [selected, tree, loadProps]);

  return (
    <div className="prop-panel">
      <div className="prop-panel__search">
        <input type="search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder={byValue ? '이름 · 유형 · 속성 값 검색' : '객체 검색 (이름 · 유형)'} aria-label="객체 검색" />
        <label className="prop-panel__mode">
          <input type="checkbox" checked={byValue} onChange={e => setByValue(e.target.checked)} />
          속성 값 포함 <span className="muted">(재료, 공정, 요소 ID 등 · 여러 단어는 모두 포함)</span>
        </label>
        {valueNote && <span className="muted">{valueNote}</span>}
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
                <button type="button" className={selected === id ? 'is-selected' : ''} onClick={() => onSelect(id, true)}
                  title={tree.path(id).map(p => tree.name(p)).join(' › ')}>
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
            {sections?.error && <p className="muted">속성을 불러오지 못했습니다: {sections.error}</p>}
            {sections?.loading && <p className="muted">속성 불러오는 중…</p>}
            {sections && !sections.loading && !sections.list.some(s => s.groups.length) && <p className="muted">표시할 속성이 없습니다.</p>}
            {sections?.list.map((section, si) => (
              <section key={section.id} className="prop-panel__section">
                {si > 0 && (
                  <div className="prop-panel__parent">
                    상위 객체 ·{' '}
                    <button type="button" onClick={() => onSelect(section.id, false)}>{tree.name(section.id)}</button>
                    {tree.type(section.id) && <span className="muted"> {tree.type(section.id)}</span>}
                  </div>
                )}
                {section.groups.map(([category, rows]) => (
                  <details key={category} className="prop-panel__group" open={si === 0 ? section.groups.length <= 4 || category !== 'Item' : si === 1}>
                    <summary>{category} <span className="muted">{rows.length}</span></summary>
                    <dl>
                      {rows.map((r, j) => (
                        <div key={j} className="prop-panel__row"><dt>{r.label}</dt><dd>{r.value}</dd></div>
                      ))}
                    </dl>
                  </details>
                ))}
                {section.ext && <p className="muted prop-panel__ext">External ID · {section.ext}</p>}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
