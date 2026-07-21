import { useCallback, useEffect, useRef, useState } from 'react';
import { Viewer, XKTLoaderPlugin } from '@xeokit/xeokit-sdk';
import { UiIcon } from '../components/icons/UiIcon';
import { errMessage } from '../lib/errors';

/**
 * 3D뷰 (신규 테스트) — 확정 스택(xeokit + 서버 사전변환 XKT)으로 붙인 네이티브 메뉴.
 *
 * ⛔ Three.js / web-ifc(브라우저 런타임 IFC 파싱) 금지 — 대용량에서 렉·메모리 폭발
 *    (논문 때 That Open 실패 + ACC 렉의 재현). 그래서 초판(web-ifc)은 폐기했다.
 * ✅ 엔진 = xeokit(더블프리시전, LOD/컬링/DTX). 지오메트리 = 서버에서 convert2xkt 로
 *    구운 경량 XKT 만 스트리밍(브라우저는 파싱하지 않음).
 *
 * 이 메뉴는 로컬 `.xkt`(이미 변환된 산출물)를 드롭/선택해 **xeokit 엔진 자체를 60fps로
 * 검증**한다. IFC 입력은 반드시 서버(convert2xkt→XKT) 경유 — 아래 안내 참조.
 * 확정 전까지 main 미머지(협의됨).
 */
export function ThreeDTest() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const loaderRef = useRef<XKTLoaderPlugin | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [pick, setPick] = useState<{ id: string; name?: string; type?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // xeokit Viewer 1회 생성/파기.
  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer({
      canvasElement: canvasRef.current,
      transparent: false,
      backgroundColor: [1, 1, 1],
      dtxEnabled: true, // 더블프리시전 — 실좌표(대좌표) 지터 없음
      saoEnabled: true,
    });
    viewer.camera.eye = [15, 15, 15];
    viewer.camera.look = [0, 0, 0];
    viewer.camera.up = [0, 1, 0];
    viewerRef.current = viewer;
    loaderRef.current = new XKTLoaderPlugin(viewer);

    // 클릭 픽 → 엔티티 ID(+메타) → 여기서 MIR_SMART DB 조인 지점.
    const onClick = viewer.scene.input.on('mouseclicked', (canvasPos: number[]) => {
      const hit = viewer.scene.pick({ canvasPos });
      const entity = hit?.entity as { id?: string | number; isObject?: boolean } | undefined;
      if (entity?.isObject && entity.id != null) {
        const id = String(entity.id);
        const meta = viewer.metaScene?.metaObjects?.[id];
        setPick({ id, name: meta?.name, type: meta?.type });
      } else {
        setPick(null);
      }
    });

    return () => {
      viewer.scene.input.off(onClick);
      viewerRef.current = null;
      loaderRef.current = null;
      viewer.destroy();
    };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    const viewer = viewerRef.current;
    const loader = loaderRef.current;
    if (!viewer || !loader) return;

    if (/\.ifc$/i.test(file.name)) {
      setStatus(
        'IFC는 브라우저에서 파싱하지 않습니다(정책). 서버에서 XKT로 변환 후 .xkt 를 여세요.',
      );
      return;
    }
    if (!/\.xkt$/i.test(file.name)) {
      setStatus(`.xkt 파일만 지원합니다 (선택: ${file.name})`);
      return;
    }

    setLoading(true);
    setPick(null);
    setStatus(`불러오는 중… ${file.name}`);
    try {
      // 기존 모델 제거(단일 모델 테스트).
      const prev = viewer.scene.models['test'];
      if (prev) prev.destroy();

      const buf = await file.arrayBuffer();
      const model = loader.load({ id: 'test', xkt: buf, edges: true });
      model.on('loaded', () => {
        viewer.cameraFlight.flyTo(model);
        setModelName(file.name);
        setStatus('');
        setLoading(false);
      });
      model.on('error', (e: unknown) => {
        setStatus(`불러오기 실패: ${errMessage(e)}`);
        setLoading(false);
      });
    } catch (e) {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
      setLoading(false);
    }
  }, []);

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void loadFile(f);
      e.target.value = '';
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

  const fitAll = () => {
    const viewer = viewerRef.current;
    const model = viewer?.scene.models['test'];
    if (viewer && model) viewer.cameraFlight.flyTo(model);
  };

  return (
    <div className="threed-test">
      <div className="threed-test__note">
        <UiIcon name="cube" size={16} />
        <span>
          <strong>3D뷰 (신규 테스트)</strong> — 엔진 <strong>xeokit</strong>(더블프리시전) +
          서버 사전변환 <strong>XKT</strong> 스트리밍. Three.js/web-ifc 런타임 IFC 파싱은
          폐기(대용량 렉). 로컬 <code>.xkt</code> 를 드롭해 60fps를 확인하세요. IFC는 서버에서
          <code>convert2xkt</code>로 변환 후 로드합니다.
        </span>
      </div>

      <div className="threed-test__viewer">
        <div className="viewer-bar">
          <button className="btn btn--sm" onClick={fitAll} disabled={!modelName}>
            전체 맞춤
          </button>
          <label className="btn btn--sm btn--primary threed-test__open">
            <UiIcon name="folder" size={14} /> XKT 열기
            <input type="file" accept=".xkt" onChange={onPick} hidden />
          </label>
          <div className="spacer" />
          {modelName && !loading && <span className="muted">{modelName}</span>}
          {status && <span className="muted">{status}</span>}
        </div>

        <div
          className={`threed-test__viewport${dragOver ? ' is-dragover' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <canvas ref={canvasRef} className="threed-test__canvas" />
          {!modelName && !loading && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              <p>
                여기로 <strong>.xkt</strong> 파일을 드래그하거나 상단 <em>XKT 열기</em>를 누르세요.
              </p>
              <p className="threed-test__empty-sub">
                (IFC는 서버 <code>convert2xkt</code> 변환 후 XKT로 로드 — 브라우저 파싱 금지)
              </p>
            </div>
          )}
        </div>

        {pick && (
          <div className="threed-test__props">
            <div className="threed-test__props-h">선택 객체</div>
            <dl>
              <dt>ID</dt>
              <dd>{pick.id}</dd>
              {pick.name && (
                <>
                  <dt>이름</dt>
                  <dd>{pick.name}</dd>
                </>
              )}
              {pick.type && (
                <>
                  <dt>유형</dt>
                  <dd>{pick.type}</dd>
                </>
              )}
            </dl>
            <p className="muted threed-test__props-note">
              이 ID로 MIR_SMART DB(물량·진도·RFI)를 조인하는 지점입니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default ThreeDTest;
