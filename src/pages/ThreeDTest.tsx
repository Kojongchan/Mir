import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Viewer, GLTFLoaderPlugin } from '@xeokit/xeokit-sdk';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { useProjectRole } from '../auth/useProjectRole';
import { supabase } from '../lib/supabase';
import { isAccModel } from '../lib/aps';
import { UiIcon } from '../components/icons/UiIcon';
import { errMessage } from '../lib/errors';

/**
 * 3D뷰 (신규 테스트) — 엔진 xeokit(더블프리시전) + 서버 사전변환 GLB.
 *
 * 주 시나리오: **ACC(자료관리) 모델(rvt·nwd·dwg·ifc) 선택 → 서버 변환 → xeokit 로드**.
 * 변환은 **이미 있는 검증된 파이프라인**(GitHub Actions: convert-4d.yml → SVF→GLB,
 * 거대 모델 데시메이션·CI 다운로드 안정화 완료)을 재사용한다. 결과 GLB 는 Supabase
 * `models4d` 공용 캐시에 저장 → 모델당 1회 변환, 이후 모든 사용자가 즉시 로드.
 *
 * 부가로 로컬 `.glb` 드롭도 지원(이미 변환된 산출물 눈확인용). 확정 전까지 main 미머지.
 */
export function ThreeDTest() {
  const { projectId = '' } = useParams();
  const { canEdit } = useProjectRole(projectId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const loaderRef = useRef<GLTFLoaderPlugin | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [pick, setPick] = useState<{ id: string; name?: string; type?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lastFile, setLastFile] = useState<PickedAccFile | null>(null);
  const [overage, setOverage] = useState<
    { file: PickedAccFile; force: boolean; usedGB: number; freeGB: number } | null
  >(null);

  // xeokit Viewer 1회 생성/파기.
  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer({
      canvasElement: canvasRef.current,
      transparent: false,
      backgroundColor: [1, 1, 1],
      // DTX(데이터텍스처) 모드는 선(line) 프리미티브를 렌더하지 않는다(DWG 선형이 안 보이는 원인).
      // VBO 로 그려도 60fps 나오므로 끈다. (더블프리시전은 DTX 와 무관 — RTC 로 자동 처리)
      dtxEnabled: false,
      saoEnabled: true,
    });
    viewer.camera.eye = [15, 15, 15];
    viewer.camera.look = [0, 0, 0];
    viewer.camera.up = [0, 1, 0];
    viewerRef.current = viewer;
    // 커스텀 데이터소스: xeokit 기본 XHR 은 URL 에 캐시버스터(&_=timestamp)를 붙이는데,
    // 이게 R2 presigned URL 의 서명을 깨서 403 을 낸다. fetch 로 URL 을 '그대로' 가져온다.
    const fetchBuf = (url: string, ok: (b: ArrayBuffer) => void, err: (e: string) => void) =>
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(ok)
        .catch((e) => err(String(e)));
    const dataSource = {
      getMetaModel: (src: string, ok: (j: unknown) => void, err: (e: string) => void) =>
        fetch(src)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then(ok)
          .catch((e) => err(String(e))),
      getGLTF: (src: string, ok: (b: ArrayBuffer) => void, err: (e: string) => void) =>
        fetchBuf(src, ok, err),
      getArrayBuffer: (src: string, binSrc: string, ok: (b: ArrayBuffer) => void, err: (e: string) => void) => {
        const u = /^(https?:|blob:|data:)/.test(binSrc) ? binSrc : new URL(binSrc, src).href;
        fetchBuf(u, ok, err);
      },
    };
    loaderRef.current = new GLTFLoaderPlugin(viewer, {
      dataSource,
    } as unknown as ConstructorParameters<typeof GLTFLoaderPlugin>[1]);

    // 클릭 픽 → 엔티티 ID(+메타) → MIR_SMART DB 조인 지점.
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

  /** GLB(원격 URL 또는 로컬 objectURL)를 뷰어에 올린다. */
  const mountGlb = useCallback((src: string, label: string) => {
    const viewer = viewerRef.current;
    const loader = loaderRef.current;
    if (!viewer || !loader) return;
    setPick(null);
    const prev = viewer.scene.models['test'];
    if (prev) prev.destroy();

    // BIM/APS(SVF)는 Z-up, xeokit/glTF는 Y-up → -90°(X축) 회전으로 세운다.
    // (안 하면 교량 등 모든 모델이 90° 누움.)
    const model = loader.load({ id: 'test', src, edges: true, rotation: [-90, 0, 0] });
    model.on('loaded', () => {
      viewer.cameraFlight.flyTo(model);
      setModelName(label);
      setStatus('');
      setBusy(false);
    });
    model.on('error', (e: unknown) => {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
      setBusy(false);
    });
  }, []);

  /** ACC 모델 선택 → (캐시/실패 조회 → 없으면 변환 dispatch → 폴링) → GLB 로드.
   *  force=true 면 캐시/실패 마커를 지우고 재변환(빈 캐시 갱신·재시도). */
  const openFromAcc = useCallback(
    async (f: PickedAccFile, force = false, ackOverage = false) => {
      if (!isAccModel(f.name)) {
        setStatus(`3D 모델(rvt·nwd·dwg·ifc)만 지원합니다 (선택: ${f.name})`);
        return;
      }
      if (!f.accUrn) {
        setStatus('이 파일은 아직 APS 파생(URN)이 없습니다. ACC에서 변환 완료 후 다시 시도하세요.');
        return;
      }
      setLastFile(f);
      const { data } = await supabase.auth.getSession();
      const authz: Record<string, string> = data.session
        ? { authorization: `Bearer ${data.session.access_token}` }
        : {};
      const urn = f.accUrn;

      type State = {
        ready?: boolean;
        url?: string;
        failed?: boolean;
        error?: string;
        status?: string;
        warn?: boolean;
        usedGB?: number;
        freeGB?: number;
      };
      const getState = async (): Promise<State> => {
        const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(urn)}`, { headers: authz });
        const text = await r.text();
        try {
          return JSON.parse(text) as State;
        } catch {
          throw new Error(`서버 오류(${r.status}): ${text.slice(0, 160)}`);
        }
      };
      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

      setBusy(true);
      setPick(null);
      setStatus(force ? `재변환 요청 중… ${f.name}` : `변환 캐시 확인 중… ${f.name}`);
      try {
        // 1) 캐시/실패 조회(강제 재변환이면 건너뜀).
        if (!force) {
          const st = await getState();
          if (st.ready && st.url) {
            setStatus(`불러오는 중… ${f.name}`);
            mountGlb(st.url, f.name);
            return;
          }
          if (st.failed) {
            setStatus(`변환 실패: ${st.error ?? '알 수 없음'} — '재변환'으로 다시 시도할 수 있습니다.`);
            setBusy(false);
            return;
          }
        }

        // 2) 변환 워크플로 dispatch(즉시 반환).
        const res = await fetch('/api/aps-convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authz },
          body: JSON.stringify({ urn, force, ackOverage }),
        });
        let rj: State = {};
        try {
          rj = JSON.parse(await res.text()) as State;
        } catch {
          /* 비-JSON */
        }
        if (rj.warn) {
          // R2 무료 한도 임박 — 사용자 확인 후에만 진행(추가 결제 방지).
          setOverage({ file: f, force, usedGB: rj.usedGB ?? 0, freeGB: rj.freeGB ?? 0 });
          setStatus('');
          setBusy(false);
          return;
        }
        if (rj.ready && rj.url) {
          setStatus(`불러오는 중… ${f.name}`);
          mountGlb(rj.url, f.name);
          return;
        }
        if (!res.ok) {
          setStatus(`변환 요청 실패: ${rj.error ?? res.statusText}`);
          setBusy(false);
          return;
        }

        // 3) 백그라운드 변환 중 — 완료(GLB) 또는 실패(error.json) 까지 폴링.
        const started = Date.now();
        const MAX_MS = 30 * 60 * 1000;
        for (;;) {
          if (Date.now() - started > MAX_MS) {
            setStatus('변환이 30분을 넘겨 중단했습니다. GitHub Actions 로그를 확인하세요.');
            setBusy(false);
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          setStatus(`변환 중… ${f.name} (최초 1회, ${secs}s 경과 · 완료되면 자동 표시)`);
          await sleep(5000);
          let st: State;
          try {
            st = await getState();
          } catch {
            st = { ready: false };
          }
          if (st.ready && st.url) {
            setStatus(`불러오는 중… ${f.name}`);
            mountGlb(st.url, f.name);
            return;
          }
          if (st.failed) {
            setStatus(`변환 실패: ${st.error ?? '알 수 없음'} — '재변환'으로 다시 시도할 수 있습니다.`);
            setBusy(false);
            return;
          }
        }
      } catch (e) {
        setStatus(`변환/로드 실패: ${errMessage(e)}`);
        setBusy(false);
      }
    },
    [mountGlb],
  );

  /** 로컬 .glb 드롭/선택(이미 변환된 산출물 눈확인용). */
  const loadLocal = useCallback(
    (file: File) => {
      if (!/\.(glb|gltf)$/i.test(file.name)) {
        setStatus(`.glb 파일만 지원합니다 (원본 모델은 "ACC에서 열기"). 선택: ${file.name}`);
        return;
      }
      setBusy(true);
      setStatus(`불러오는 중… ${file.name}`);
      mountGlb(URL.createObjectURL(file), file.name);
    },
    [mountGlb],
  );

  const onLocalInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) loadLocal(f);
      e.target.value = '';
    },
    [loadLocal],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) loadLocal(f);
    },
    [loadLocal],
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
          <strong>3D뷰 (신규 테스트)</strong> — 엔진 <strong>xeokit</strong>(더블프리시전).
          <strong>ACC 모델(rvt·nwd·dwg·ifc)</strong>을 선택하면 검증된 변환 파이프라인이 GLB로 변환
          (캐시)해 로드합니다. 첫 변환만 대기, 이후 모든 사용자는 즉시.
        </span>
      </div>

      {overage && (
        <div className="threed-test__overage" role="alert">
          <span>
            ⚠️ 저장소 <strong>{overage.usedGB}GB / 10GB</strong> 사용 — 이 변환은 무료 한도를 넘어
            <strong> 추가 결제</strong>가 발생할 수 있습니다(남은 {overage.freeGB}GB).
          </span>
          <div className="threed-test__overage-btns">
            <button
              className="btn btn--sm btn--primary"
              onClick={() => {
                const o = overage;
                setOverage(null);
                void openFromAcc(o.file, o.force, true);
              }}
            >
              추가 결제 감수하고 변환
            </button>
            <button className="btn btn--sm" onClick={() => setOverage(null)}>
              취소
            </button>
          </div>
        </div>
      )}

      <div className="threed-test__viewer">
        <div className="viewer-bar">
          <button className="btn btn--sm btn--primary" onClick={() => setPickerOpen(true)} disabled={busy}>
            <UiIcon name="folder" size={14} /> ACC에서 열기
          </button>
          <button className="btn btn--sm" onClick={fitAll} disabled={!modelName}>
            전체 맞춤
          </button>
          <button
            className="btn btn--sm"
            onClick={() => lastFile && void openFromAcc(lastFile, true)}
            disabled={busy || !lastFile}
            title="캐시를 지우고 다시 변환(빈 캐시·실패 재시도)"
          >
            재변환
          </button>
          <label className="btn btn--sm threed-test__open" title="이미 변환된 .glb 눈확인">
            .glb
            <input type="file" accept=".glb,.gltf" onChange={onLocalInput} hidden />
          </label>
          <div className="spacer" />
          {modelName && !busy && <span className="muted">{modelName}</span>}
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
          {!modelName && !busy && (
            <div className="threed-test__empty">
              <UiIcon name="cube" size={40} />
              <p>
                상단 <em>ACC에서 열기</em>로 자료관리 모델(rvt·nwd·dwg·ifc)을 여세요.
              </p>
              <p className="threed-test__empty-sub">
                (첫 열람 시 서버 변환 → 이후 캐시에서 즉시 로드 · 로컬 <strong>.glb</strong> 드롭도 가능)
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

      {pickerOpen && (
        <AccFilePicker
          projectId={projectId}
          canEdit={canEdit}
          onClose={() => setPickerOpen(false)}
          onPick={(f) => {
            setPickerOpen(false);
            void openFromAcc(f);
          }}
        />
      )}
    </div>
  );
}

export default ThreeDTest;
