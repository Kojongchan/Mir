import { useEffect, useRef, useState } from 'react';
import { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { Toolbar } from './Toolbar';
import { PropertiesPanel } from './PropertiesPanel';
import { downloadFileBytes } from '../lib/files';
import { downloadModelBytes } from '../lib/api';
import { errMessage } from '../lib/errors';

/**
 * Self-contained IFC viewer for embedding in a panel (e.g. opening a model from
 * 자료관리). Downloads bytes from the given bucket, renders with web-ifc, and
 * cleans up the WebGL context on unmount. Selection feeds the shared store so
 * the PropertiesPanel works as in the 4D workspace.
 */
export function IfcModelViewer({ bucket, path }: { bucket: 'docs' | 'models'; path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);
  const [status, setStatus] = useState('불러오는 중…');
  const { setSelected } = useStore();

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    setViewer(v);
    let cancelled = false;
    (async () => {
      try {
        const bytes = bucket === 'models' ? await downloadModelBytes(path) : await downloadFileBytes(path);
        if (cancelled) return;
        await v.loadIfc(bytes);
        if (!cancelled) setStatus('');
      } catch (e) {
        if (!cancelled) setStatus(`불러오기 실패: ${errMessage(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      setSelected(null);
      v.dispose();
    };
  }, [bucket, path, setSelected]);

  return (
    <div className="inline-viewer">
      <div className="viewer-bar">
        <Toolbar viewer={viewer} />
        <div className="spacer" />
        {status && <span className="muted">{status}</span>}
      </div>
      <div className="viewport" ref={containerRef} />
      <PropertiesPanel />
    </div>
  );
}
