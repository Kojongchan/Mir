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
    loaderRef.current = new GLTFLoaderPlugin(viewer);

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

  /** ACC 모델 선택 → (캐시 조회 → 없으면 변환 워크플로 dispatch → 폴링) → GLB 로드. */
  const openFromAcc = useCallback(
    async (f: PickedAccFile) => {
      if (!isAccModel(f.name)) {
        setStatus(`3D 모델(rvt·nwd·dwg·ifc)만 지원합니다 (선택: ${f.name})`);
        return;
      }
      if (!f.accUrn) {
        setStatus('이 파일은 아직 APS 파생(URN)이 없습니다. ACC에서 변환 완료 후 다시 시도하세요.');
        return;
      }
      const { data } = await supabase.auth.getSession();
      const authz: Record<string, string> = data.session
        ? { authorization: `Bearer ${data.session.access_token}` }
        : {};
      const urn = f.accUrn;

      const readJson = async (r: Response): Promise<Record<string, unknown>> => {
        const text = await r.text();
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error(`서버 오류(${r.status}): ${text.slice(0, 160)}`);
        }
      };
      const checkCache = async () => {
        const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(urn)}`, { headers: authz });
        return (await readJson(r)) as { ready?: boolean; url?: string };
      };
      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

      setBusy(true);
      setStatus(`변환 캐시 확인 중… ${f.name}`);
      try {
        // 1) 캐시 조회 — 이미 있으면 즉시 로드(모든 사용자 공통).
        const cj = await checkCache();
        if (cj.ready && cj.url) {
          setStatus(`불러오는 중… ${f.name}`);
          mountGlb(cj.url, f.name);
          return;
        }

        // 2) 변환 워크플로(GitHub Actions)에 위임(즉시 반환).
        const res = await fetch('/api/aps-convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authz },
          body: JSON.stringify({ urn }),
        });
        const rj = (await readJson(res)) as { ready?: boolean; url?: string; status?: string; error?: string };
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

        // 3) 백그라운드 변환 중 — 캐시에 GLB 뜰 때까지 폴링(최대 30분).
        const started = Date.now();
        const MAX_MS = 30 * 60 * 1000;
        for (;;) {
          if (Date.now() - started > MAX_MS) {
            setStatus('변환이 30분을 넘겨 중단했습니다. GitHub Actions 로그를 확인하세요.');
            setBusy(false);
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          const hint = secs > 240 ? ' · 오래 걸리면 GitHub Actions 로그를 확인하세요' : '';
          setStatus(`변환 중… ${f.name} (최초 1회, ${secs}s 경과 · 완료되면 자동 표시${hint})`);
          await sleep(5000);
          const poll = await checkCache().catch(() => ({ ready: false }) as { ready?: boolean; url?: string });
          if (poll.ready && poll.url) {
            setStatus(`불러오는 중… ${f.name}`);
            mountGlb(poll.url, f.name);
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

      <div className="threed-test__viewer">
        <div className="viewer-bar">
          <button className="btn btn--sm btn--primary" onClick={() => setPickerOpen(true)} disabled={busy}>
            <UiIcon name="folder" size={14} /> ACC에서 열기
          </button>
          <button className="btn btn--sm" onClick={fitAll} disabled={!modelName}>
            전체 맞춤
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
