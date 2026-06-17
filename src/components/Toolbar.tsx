import type { IfcViewer, UpAxis } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';

interface Props {
  viewer: IfcViewer | null;
  upAxis: UpAxis;
  onCycleUpAxis: () => void;
  canOrient: boolean;
}

/** View-manipulation controls (selection-aware). */
export function Toolbar({ viewer, upAxis, onCycleUpAxis, canOrient }: Props) {
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
      <button
        onClick={onCycleUpAxis}
        disabled={!canOrient}
        title="모델이 누워 보이면 눌러 세움축(Z↔Y)을 전환합니다. 선택은 모델별로 기억됩니다."
      >
        세움축: {upAxis.toUpperCase()}
      </button>
    </div>
  );
}
