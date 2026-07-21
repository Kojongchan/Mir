import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Viewer, XKTLoaderPlugin } from '@xeokit/xeokit-sdk';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { useProjectRole } from '../auth/useProjectRole';
import { supabase } from '../lib/supabase';
import { isAccModel } from '../lib/aps';
import { UiIcon } from '../components/icons/UiIcon';
import { errMessage } from '../lib/errors';

/**
 * 3D뷰 (신규 테스트) — 확정 스택(xeokit + 서버 사전변환 XKT)으로 붙인 네이티브 메뉴.
 *
 * ⛔ Three.js / web-ifc(브라우저 런타임 IFC 파싱) 금지 — 대용량에서 렉·메모리 폭발.
 * ✅ 엔진 = xeokit(더블프리시전, LOD/컬링/DTX). 지오메트리 = 서버에서 구운 경량 XKT 만
 *    스트리밍(브라우저는 파싱하지 않음).
 *
 * 주 시나리오: **ACC(자료관리)에 올라간 모델(rvt·nwd·dwg·ifc)을 선택 → 서버 변환
 * (SVF→glTF→XKT, `/api/aps-convert`, 캐시) → xeokit 로드**. 부가로 로컬 `.xkt` 드롭도
 * 지원(이미 변환된 산출물 테스트용). 확정 전까지 main 미머지(협의됨).
 */
export function ThreeDTest() {
  const { projectId = '' } = useParams();
  const { canEdit } = useProjectRole(projectId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const loaderRef = useRef<XKTLoaderPlugin | null>(null);
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
    loaderRef.current = new XKTLoaderPlugin(viewer);

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

  /** XKT(로컬 ArrayBuffer 또는 원격 URL)를 뷰어에 올린다. */
  const mountXkt = useCallback((params: { xkt?: ArrayBuffer; src?: string }, label: string) => {
    const viewer = viewerRef.current;
    const loader = loaderRef.current;
    if (!viewer || !loader) return;
    setPick(null);
    const prev = viewer.scene.models['test'];
    if (prev) prev.destroy();

    const model = loader.load({ id: 'test', edges: true, ...params });
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

  /** ACC 모델 선택 → 서버 변환(캐시) → XKT 로드. */
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

      // 서버가 JSON이 아닌 에러(플랫폼 오류 등)를 줘도 원문을 드러낸다.
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
          mountXkt({ src: cj.url }, f.name);
          return;
        }

        // 2) 변환 워커에 작업 위임(즉시 반환).
        const res = await fetch('/api/aps-convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authz },
          body: JSON.stringify({ urn }),
        });
        const rj = (await readJson(res)) as { ready?: boolean; url?: string; status?: string; error?: string };
        if (rj.ready && rj.url) {
          setStatus(`불러오는 중… ${f.name}`);
          mountXkt({ src: rj.url }, f.name);
          return;
        }
        if (!res.ok) {
          setStatus(`변환 요청 실패: ${rj.error ?? res.statusText}`);
          setBusy(false);
          return;
        }

        // 3) 워커가 백그라운드 변환 중 — 캐시에 XKT 뜰 때까지 폴링(최대 20분).
        const started = Date.now();
        const MAX_MS = 20 * 60 * 1000;
        for (;;) {
          if (Date.now() - started > MAX_MS) {
            setStatus('변환이 20분을 넘겨 중단했습니다. 매우 큰 모델일 수 있습니다(워커 로그 확인).');
            setBusy(false);
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          setStatus(`변환 중… ${f.name} (최초 1회, ${secs}s 경과 · 완료되면 자동 표시)`);
          await sleep(4000);
          const poll = await checkCache().catch(() => ({ ready: false }) as { ready?: boolean; url?: string });
          if (poll.ready && poll.url) {
            setStatus(`불러오는 중… ${f.name}`);
            mountXkt({ src: poll.url }, f.name);
            return;
          }
        }
      } catch (e) {
        setStatus(`변환/로드 실패: ${errMessage(e)}`);
        setBusy(false);
      }
    },
    [mountXkt],
  );

  /** 로컬 .xkt 드롭/선택(이미 변환된 산출물 테스트용). */
  const loadLocal = useCallback(
    async (file: File) => {
      if (/\.ifc$|\.rvt$|\.nwd$|\.dwg$/i.test(file.name)) {
        setStatus('원본 모델은 ACC에서 열어 서버 변환합니다("ACC에서 열기"). 로컬은 .xkt 만.');
        return;
      }
      if (!/\.xkt$/i.test(file.name)) {
        setStatus(`.xkt 파일만 지원합니다 (선택: ${file.name})`);
        return;
      }
      setBusy(true);
      setStatus(`불러오는 중… ${file.name}`);
      try {
        const buf = await file.arrayBuffer();
        mountXkt({ xkt: buf }, file.name);
      } catch (e) {
        setStatus(`불러오기 실패: ${errMessage(e)}`);
        setBusy(false);
      }
    },
    [mountXkt],
  );

  const onLocalInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void loadLocal(f);
      e.target.value = '';
    },
    [loadLocal],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void loadLocal(f);
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
          <strong>3D뷰 (신규 테스트)</strong> — 엔진 <strong>xeokit</strong>(더블프리시전) +
          서버 사전변환 <strong>XKT</strong> 스트리밍. <strong>ACC 모델(rvt·nwd·dwg·ifc)</strong>을
          선택하면 서버가 변환(캐시)해 로드합니다. Three.js/web-ifc 런타임 파싱은 폐기(대용량 렉).
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
          <label className="btn btn--sm threed-test__open" title="이미 변환된 .xkt 테스트">
            .xkt
            <input type="file" accept=".xkt" onChange={onLocalInput} hidden />
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
                (첫 열람 시 서버 변환 → 이후 캐시에서 즉시 로드 · 로컬 <strong>.xkt</strong> 드롭도 가능)
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
