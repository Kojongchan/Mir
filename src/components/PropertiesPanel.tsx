import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import type { PropertyGroup } from '../viewer/IfcViewer';

/**
 * 객체 속성 팝업 — 선택 객체의 속성을 IFC 속성세트(일반·치수·구속조건·재료 및 마감재
 * 등 Revit 그룹명 그대로)별로 묶어 접을 수 있게 보여준다. 팝업은 우측 상단에 떠 있고
 * CSS `resize` 로 사용자가 크기를 조절(좌하단 핸들)할 수 있다. `onClose` 로 숨김.
 */
export function PropertiesPanel({ onClose }: { onClose?: () => void } = {}) {
  const selected = useStore((s) => s.selected);

  if (!selected) {
    return (
      <div className="panel properties props-popup">
        <div className="props-head">
          <h2>속성</h2>
          {onClose && (
            <button className="props-close" onClick={onClose} title="닫기">
              ✕
            </button>
          )}
        </div>
        <p className="muted props-empty">객체를 클릭하면 속성이 표시됩니다.</p>
      </div>
    );
  }

  const groups: PropertyGroup[] =
    selected.groups?.length ? selected.groups : [{ name: '일반', props: selected.attributes }];

  return (
    <div className="panel properties props-popup">
      <div className="props-head">
        <h2>속성</h2>
        {onClose && (
          <button className="props-close" onClick={onClose} title="닫기">
            ✕
          </button>
        )}
      </div>
      <div className="prop-header">
        <div className="prop-type">{selected.type}</div>
        <div className="prop-name">{selected.name}</div>
        <div className="muted">#{selected.expressID}</div>
      </div>
      <div className="props-groups">
        {groups.map((g, i) => (
          <PropGroup key={`${g.name}-${i}`} group={g} defaultOpen={i < 2} selKey={selected.expressID} />
        ))}
      </div>
    </div>
  );
}

function PropGroup({
  group,
  defaultOpen,
  selKey,
}: {
  group: PropertyGroup;
  defaultOpen: boolean;
  selKey: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // 다른 객체를 선택하면 기본 펼침 상태로 리셋.
  useEffect(() => setOpen(defaultOpen), [selKey, defaultOpen]);
  return (
    <div className="prop-group">
      <button className="prop-group-head" onClick={() => setOpen((o) => !o)} title={group.name}>
        <span className="prop-group-twisty">{open ? '▾' : '▸'}</span>
        <span className="prop-group-name">{group.name}</span>
        <span className="muted">{group.props.length}</span>
      </button>
      {open && (
        <table className="prop-table">
          <tbody>
            {group.props.map((a, i) => (
              <tr key={`${a.key}-${i}`}>
                <td className="prop-key">{a.key}</td>
                <td className="prop-val">{a.value}</td>
              </tr>
            ))}
            {group.props.length === 0 && (
              <tr>
                <td className="muted" colSpan={2}>값 없음</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
