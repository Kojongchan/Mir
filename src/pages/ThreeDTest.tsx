import { useCallback, useEffect, useRef, useState } from 'react';
import { IfcViewer } from '../viewer/IfcViewer';
import { useStore } from '../store/useStore';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { UiIcon } from '../components/icons/UiIcon';
import { errMessage } from '../lib/errors';

/**
 * 3D뷰 (신규 테스트) — 네이티브 3D 뷰어 검증용 메뉴.
 *
 * iframe 임베드가 아니라, 레포에 이미 있는 자체 뷰어 엔진(`IfcViewer`,
 * Three.js + web-ifc)을 플랫폼 메뉴로 직접 띄운다. ACC/Supabase/인증 없이도
 * **로컬 IFC 파일을 드롭/선택**해 바로 렌더·선택·측정·단면까지 확인할 수 있어
 * 뷰어 자체를 독립적으로 테스트하는 표면이다.
 *
 * 확정 전까지 머지하지 않는 실험 메뉴(협의됨). 여기서 검증이 끝나면 지형(glTF)·
 * DWG 선형 로더를 얹어 통합 씬(실좌표 정합)으로 확장한다.
 */
export function ThreeDTest() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<IfcViewer | null>(null);
  const [viewer, setViewer] = useState<IfcViewer | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { setSelected } = useStore();

  // 뷰어 1회 생성/파기(컨테이너 라이프사이클과 동기).
  useEffect(() => {
    if (!containerRef.current) return;
    const v = new IfcViewer(containerRef.current);
    v.setOnSelect(setSelected);
    viewerRef.current = v;
    setViewer(v);
    return () => {
      viewerRef.current = null;
      setSelected(null);
      v.dispose();
    };
  }, [setSelected]);

  const loadFile = useCallback(async (file: File) => {
    const v = viewerRef.current;
    if (!v) return;
    if (!/\.ifc$/i.test(file.name)) {
      setStatus(`IFC 파일만 지원합니다 (선택: ${file.name})`);
      return;
    }
    setLoading(true);
    setStatus(`불러오는 중… ${file.name}`);
    try {
      const buf = await file.arrayBuffer();
      await v.loadIfc(new Uint8Array(buf), { label: file.name });
      v.frameAll();
      setModelName(file.name);
      setStatus('');
    } catch (e) {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void loadFile(f);
      e.target.value = ''; // 같은 파일 재선택 허용
    },
    [loadFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void loadFile(f);
    },
    [loadFile],
  );

  return (
    <div className="threed-test">
      <div className="threed-test__note">
        <UiIcon name="cube" size={16} />
        <span>
          <strong>3D뷰 (신규 테스트)</strong> — 자체 뷰어 엔진(Three.js + web-ifc)을 iframe 없이
          플랫폼에 직접 띄운 실험 메뉴입니다. 로컬 <code>.ifc</code> 파일을 드롭하거나 선택해
          렌더·선택·측정·단면을 확인하세요.
        </span>
      </div>

      <div className="inline-viewer threed-test__viewer">
        <div className="viewer-bar">
          <Toolbar viewer={viewer} />
          <button className="btn btn--sm" onClick={() => viewer?.frameAll()} disabled={!modelName}>
            전체 맞춤
          </button>
          <label className="btn btn--sm btn--primary threed-test__open">
            <UiIcon name="folder" size={14} /> IFC 열기
            <input type="file" accept=".ifc" onChange={onPick} hidden />
          </label>
          <div className="spacer" />
          {modelName && !loading && <span className="muted">{modelName}</span>}
          {status && <span className="muted">{status}</span>}
        </div>

        <div
          className={`viewport threed-test__viewport${dragOver ? ' is-dragover' : ''}`}
          ref={containerRef}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {!modelName && !loading && (
            <div className="threed-test__empty" aria-hidden={!!modelName}>
              <UiIcon name="cube" size={40} />
              <p>
                여기로 <strong>.ifc</strong> 파일을 드래그하거나 상단 <em>IFC 열기</em>를 누르세요.
              </p>
            </div>
          )}
        </div>

        <PropertiesPanel />
      </div>
    </div>
  );
}

export default ThreeDTest;
