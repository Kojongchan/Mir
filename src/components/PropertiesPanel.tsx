import { useStore } from '../store/useStore';

export function PropertiesPanel() {
  const selected = useStore((s) => s.selected);

  if (!selected) {
    return (
      <div className="panel properties">
        <h2>속성</h2>
        <p className="muted">객체를 클릭하면 속성이 표시됩니다.</p>
      </div>
    );
  }

  return (
    <div className="panel properties">
      <h2>속성</h2>
      <div className="prop-header">
        <div className="prop-type">{selected.type}</div>
        <div className="prop-name">{selected.name}</div>
        <div className="muted">#{selected.expressID}</div>
      </div>
      <table className="prop-table">
        <tbody>
          {selected.attributes.map((a) => (
            <tr key={a.key}>
              <td className="prop-key">{a.key}</td>
              <td className="prop-val">{a.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
