import { useEffect, useRef, useState } from 'react';
import { IfcViewer } from './viewer/IfcViewer';
import { useStore } from './store/useStore';
import { Toolbar } from './components/Toolbar';
import { PropertiesPanel } from './components/PropertiesPanel';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);
  const { status, modelCount, setSelected } = useStore();

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    setViewer(v);
    return () => v.dispose();
  }, [setSelected]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Mir BIM</span>
        <Toolbar viewer={viewer} />
      </header>

      <div className="viewport" ref={containerRef} />

      <PropertiesPanel />

      <footer className="statusbar">
        <span>{status}</span>
        <span className="muted">모델 {modelCount}개</span>
      </footer>
    </div>
  );
}
