import { useRef } from 'react';
import type { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';

interface Props {
  viewer: IfcViewer | null;
}

export function Toolbar({ viewer }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { selected, isLoading, setLoading, setStatus, setModelCount, setSelected } = useStore();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !viewer) return;

    setLoading(true);
    setStatus(`불러오는 중: ${file.name}`);
    try {
      const buffer = await file.arrayBuffer();
      await viewer.loadIfc(new Uint8Array(buffer));
      setModelCount(viewer.modelCount);
      setStatus(`불러옴: ${file.name}`);
    } catch (err) {
      console.error(err);
      setStatus(`불러오기 실패: ${(err as Error).message}`);
    } finally {
      setLoading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const sel = selected ? { modelID: selected.modelID, expressID: selected.expressID } : null;

  return (
    <div className="toolbar">
      <input
        ref={fileInput}
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        onChange={onFile}
      />
      <button onClick={() => fileInput.current?.click()} disabled={isLoading}>
        {isLoading ? '불러오는 중…' : 'IFC 열기'}
      </button>
      <div className="divider" />
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
