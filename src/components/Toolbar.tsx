import type { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';

interface Props {
  viewer: IfcViewer | null;
}

/** View-manipulation controls (selection-aware). */
export function Toolbar({ viewer }: Props) {
  const { selected, setSelected } = useStore();
  const sel = selected ? { modelID: selected.modelID, expressID: selected.expressID } : null;

  return (
    <div className="toolbar">
      <button onClick={() => viewer?.fitToSelection(sel)}>맞춤</button>
      <button onClick={() => viewer?.hideSelected(sel)} disabled={!selected}>
        숨기기
      </button>
      <button onClick={() => viewer?.isolate(sel)} disabled={!selected}>
        격리
      </button>
      <button
        onClick={() => {
          viewer?.showAll();
          setSelected(null);
        }}
      >
        전체 표시
      </button>
    </div>
  );
}
