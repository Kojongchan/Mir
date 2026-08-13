import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Viewer, GLTFLoaderPlugin, XKTLoaderPlugin, NavCubePlugin, FastNavPlugin } from '@xeokit/xeokit-sdk';
import { AccFilePicker, type PickedAccFile } from '../components/AccFilePicker';
import { useProjectRole } from '../auth/useProjectRole';
import { supabase } from '../lib/supabase';
import { isAccModel } from '../lib/aps';
import { UiIcon } from '../components/icons/UiIcon';
import { errMessage } from '../lib/errors';

/** 변환기가 구운 카메라 초점 박스(회전 전 실좌표). 이상치 제외한 중심/반경. */
type Focus = { center: [number, number, number]; half: [number, number, number] };

/**
 * 클릭한 '표면 지점'(worldPos)으로 카메라를 당긴다 — 병합 메시라 엔티티 AABB 로 flyTo 하면
 * 전체(20km)를 맞춰(=전체맞춤처럼) 확대가 안 되던 문제 해결. 시선 방향은 유지하고 그 지점을
 * 새 look 으로, eye 는 현재 거리의 factor 배(기본 35%=매번 65% 접근)로 당긴다. 반복 클릭 시
 * 점점 가까워짐. minDist 로 과접근(면 뚫기) 방지.
 */
function flyToWorldPoint(
  viewer: Viewer,
  worldPos: number[],
  factor = 0.35,
  minDist = 2,
): void {
  const cam = viewer.camera;
  const eye = cam.eye as number[];
  const look = cam.look as number[];
  let dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  const cur = Math.hypot(worldPos[0] - eye[0], worldPos[1] - eye[1], worldPos[2] - eye[2]);
  const dist = Math.max(cur * factor, minDist);
  const newEye = [worldPos[0] - dx * dist, worldPos[1] - dy * dist, worldPos[2] - dz * dist];
  viewer.cameraFlight.flyTo({ eye: newEye, look: worldPos, up: cam.up, duration: 0.4 });
}

/**
 * 카메라를 target 방향으로 '비율'만큼 당긴다(축척 무관). xeokit 기본 휠 줌은 절대속도(초당
 * ~10 units)라 측량좌표(225km)에선 사실상 안 움직인다 → 현재 거리의 비율로 dolly. factor<1
 * 이면 확대(target 쪽으로), >1 이면 축소. eye·look 을 함께 옮겨 target 이 화면 중앙으로.
 */
function dollyToward(viewer: Viewer, target: number[], factor: number): void {
  const cam = viewer.camera;
  const eye = [...(cam.eye as number[])];
  const look = [...(cam.look as number[])];
  const t = 1 - factor; // target 쪽으로 이동할 비율
  cam.eye = [eye[0] + (target[0] - eye[0]) * t, eye[1] + (target[1] - eye[1]) * t, eye[2] + (target[2] - eye[2]) * t];
  cam.look = [look[0] + (target[0] - look[0]) * t, look[1] + (target[1] - look[1]) * t, look[2] + (target[2] - look[2]) * t];
}

/**
 * world AABB [xmin,ymin,zmin,xmax,ymax,zmax] 를 카메라로 맞춘다. 높이(dy)가 수평폭보다
 * 훨씬 작은 '평평한 도면'(토목 DWG 지형·평면도)은 xeokit 기본 flyTo 가 비스듬히 잡아
 * edge-on(옆에서) 으로 얇은 선만 보인다 → 위에서 내려다보는 평면도(top-down) 시점으로.
 * 높이 있는 3D 모델은 기존대로 aabb fit(비스듬).
 */
function flyToFramed(viewer: Viewer, box: number[]): void {
  const dx = box[3] - box[0], dy = box[4] - box[1], dz = box[5] - box[2];
  const horiz = Math.max(dx, dz);
  const cx = (box[0] + box[3]) / 2, cy = (box[1] + box[4]) / 2, cz = (box[2] + box[5]) / 2;
  if (dy < 0.25 * horiz) {
    // 평면 도면 → 카메라를 '직접' top-down 으로 설정(flyTo 애니메이션보다 확실). 헤드리스
    // xeokit 테스트로 이 방식이 지형 삼각망을 화면 가득 렌더함을 확인.
    const d = horiz * 0.62;
    viewer.camera.eye = [cx, cy + d, cz];
    viewer.camera.look = [cx, cy, cz];
    viewer.camera.up = [0, 0, -1];
  } else {
    viewer.cameraFlight.flyTo({ aabb: box });
  }
}

/**
 * focus(회전 전 실좌표)를 로드 회전 [-90,0,0]과 같은 축변환((x,y,z)→(x,z,-y))으로 돌려
 * xeokit world AABB [xmin,ymin,zmin,xmax,ymax,zmax] 로 변환. 없으면 null.
 */
function focusToAabb(focus?: Focus): number[] | null {
  if (!focus || !focus.center || !focus.half) return null;
  const [cx, cy, cz] = focus.center;
  const [hx, hy, hz] = focus.half;
  // (x,y,z) → (x, z, -y):  center'=(cx, cz, -cy),  half'=(hx, hz, hy)
  const wcx = cx, wcy = cz, wcz = -cy;
  const whx = hx, why = hz, whz = hy;
  return [wcx - whx, wcy - why, wcz - whz, wcx + whx, wcy + why, wcz + whz];
}

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
  const navCubeRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const loaderRef = useRef<GLTFLoaderPlugin | null>(null);
  const xktLoaderRef = useRef<XKTLoaderPlugin | null>(null);
  const lodSubRef = useRef<string | null>(null); // 카메라 LOD 전환 리스너 핸들
  const pickedRef = useRef<{ id?: string | number; worldPos?: number[] } | null>(null);
  const highlightedRef = useRef<string | null>(null); // 현재 하이라이트된 엔티티 id
  const [status, setStatus] = useState('');
  const [dbg, setDbg] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [pick, setPick] = useState<{ id: string; name?: string; type?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [bgDark, setBgDark] = useState(false);
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
      // DTX(데이터텍스처) 모드 — 대용량 메시를 지오메트리 텍스처로 압축 저장해 GPU 메모리를
      // 급감시킨다. 통합모델 XKT 는 2억+ 정점이라 VBO 로는 GPU 초과 → dtx 필수. (dtx 는 선/점
      // 프리미티브는 안 그리지만, XKT(비-DWG)는 순수 메시라 무관. DWG 선형은 GLB+VBO 경로라
      // 이 설정과 별개 — 필요 시 DWG 전용 뷰어 옵션은 후속.)
      dtxEnabled: true,
      // SAO(스크린스페이스 앰비언트 오클루전)는 매 프레임 전체화면 연산이라 3.6억 삼각형에선
      // 정지 상태 렉의 주범 → 끈다(뷰잉 우선). 입체감은 노멀 음영으로도 충분. 필요 시 후속 토글.
      saoEnabled: false,
      // 로그 깊이버퍼 — 토목 DWG 는 측량좌표(예: X≈230km, 폭 20km)라 near/far 범위가
      // 극단적이다. 이게 없으면 전체를 담으면 near 가 커져 가까이 못 가고(콩알), 가까이
      // 맞추면 far 가 작아 잘린다. 로그버퍼로 km~m 스케일을 한 화면에서 오가게 한다.
      logarithmicDepthBufferEnabled: true,
    });
    // 줌이 '커서 아래 지오메트리'로 다가가게(followPointer) — 거대 좌표 모델에서 화면
    // 중앙 빈 공간으로 줌돼 대상에 못 닿던 문제 해결. smartPivot 으로 회전 피벗도 안정화.
    // ACC(Autodesk) 뷰어처럼: 더블클릭한 표면으로 카메라가 날아가고(doublePickFlyTo),
    // 우클릭 드래그로 팬. 이 조합으로 넓은 측량좌표 모델에서도 원하는 곳에 바로 접근.
    viewer.cameraControl.navMode = 'orbit';
    // followPointer=true 는 orbit 회전의 '피벗 시작' 조건(CameraControl 내부: 이게 false 면
    // 좌드래그 회전이 아예 동작 안 함). smartPivot=false 로 두면 빈 곳 드래그 시 피벗이
    // 20km 가상 구가 아니라 camera.look(=지오메트리) 이 되어 정상 회전한다.
    viewer.cameraControl.followPointer = true;
    viewer.cameraControl.smartPivot = false;
    viewer.cameraControl.panRightClick = true;
    // 내장 휠 줌은 절대속도라 측량좌표(225km)에선 안 움직인다 → 끄고(rate=0) 아래 커스텀
    // 비율 휠로 대체. doublePickFlyTo(엔티티=전체 20km)도 끔.
    viewer.cameraControl.doublePickFlyTo = false;
    viewer.cameraControl.mouseWheelDollyRate = 0;
    // 원거리 클리핑(far) 평면을 크게 — 이게 없으면(기본 far 작음) 17km 로 뻗은 지형 삼각망
    // 등 카메라에서 먼 지오메트리가 far 너머로 잘려 통째로 안 보인다(헤드리스 xeokit 테스트로
    // 확진: far 키우니 전부 렌더). 로그 깊이버퍼가 켜져 있어 near 작아도 z-파이팅 없다.
    viewer.camera.perspective.near = 0.5;
    viewer.camera.perspective.far = 1e7;
    viewer.camera.ortho.near = 0.5;
    viewer.camera.ortho.far = 1e7;
    viewer.camera.eye = [15, 15, 15];
    viewer.camera.look = [0, 0, 0];
    viewer.camera.up = [0, 1, 0];
    // 선택 하이라이트 — 클릭한 객체를 눈에 띄게(형광 노랑 채움 + 글로우). '뭐가 선택됐는지'
    // 바로 보이게. glowThrough=true 로 가려진 선/면도 강조. 선(line) 프리미티브도 색이 바뀐다.
    const hm = viewer.scene.highlightMaterial;
    hm.fill = true; hm.fillColor = [1.0, 0.9, 0.0]; hm.fillAlpha = 0.5;
    hm.edges = true; hm.edgeColor = [1.0, 0.85, 0.0]; hm.edgeAlpha = 1.0;
    (hm as unknown as { glowThrough?: boolean }).glowThrough = true;
    viewerRef.current = viewer;

    // FastNav — 통합모델 XKT 는 2억+ 정점이라 정지 상태 풀품질은 무겁다. 카메라를 움직이는
    // 동안엔 SAO·PBR·텍스처·엣지를 끄고 해상도를 절반으로 낮춰 '부드러운 네비'를 확보하고,
    // 멈추면 잠깐 뒤 풀품질로 복원한다(대용량 모델 렉의 표준 해법).
    new FastNavPlugin(viewer, {
      hideSAO: true,
      hidePBR: true,
      hideColorTexture: true,
      hideEdges: true,
      hideTransparentObjects: false,
      scaleCanvasResolution: true,
      scaleCanvasResolutionFactor: 0.5,
      delayBeforeRestore: true,
      delayBeforeRestoreSeconds: 0.4,
    } as unknown as ConstructorParameters<typeof FastNavPlugin>[1]);

    // 방향 큐브(ACC 뷰큐브 유사) — 코너 캔버스에 렌더. 면/모서리 클릭으로 정면·평면뷰 스냅.
    let navCube: NavCubePlugin | null = null;
    if (navCubeRef.current) {
      navCube = new NavCubePlugin(viewer, {
        canvasElement: navCubeRef.current,
        visible: true,
        cameraFly: true,
        cameraFlyDuration: 0.5,
        fitVisible: true,
      } as unknown as ConstructorParameters<typeof NavCubePlugin>[1]);
    }
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
      // XKTLoaderPlugin 은 getXKT 로 .xkt 바이너리를 받는다(R2 presigned URL → fetch 그대로).
      getXKT: (src: string, ok: (b: ArrayBuffer) => void, err: (e: string) => void) =>
        fetchBuf(src, ok, err),
      getArrayBuffer: (src: string, binSrc: string, ok: (b: ArrayBuffer) => void, err: (e: string) => void) => {
        const u = /^(https?:|blob:|data:)/.test(binSrc) ? binSrc : new URL(binSrc, src).href;
        fetchBuf(u, ok, err);
      },
    };
    loaderRef.current = new GLTFLoaderPlugin(viewer, {
      dataSource,
    } as unknown as ConstructorParameters<typeof GLTFLoaderPlugin>[1]);
    xktLoaderRef.current = new XKTLoaderPlugin(viewer, {
      dataSource,
    } as unknown as ConstructorParameters<typeof XKTLoaderPlugin>[1]);

    // 클릭 픽 → 엔티티 ID(+메타) → MIR_SMART DB 조인 지점. 표면 지점(worldPos)도 보관해
    // '선택 확대'·더블클릭 줌이 그 지점으로 당기게 한다(pickSurface:true).
    const onClick = viewer.scene.input.on('mouseclicked', (canvasPos: number[]) => {
      const hit = viewer.scene.pick({ canvasPos, pickSurface: true }) as
        | { entity?: { id?: string | number; isObject?: boolean }; worldPos?: number[] }
        | undefined;
      const entity = hit?.entity;
      // 이전 하이라이트 해제(항상 — 빈 곳 클릭·다른 객체 선택 모두).
      const objs = viewer.scene.objects as Record<string, { highlighted?: boolean }>;
      if (highlightedRef.current && objs[highlightedRef.current]) objs[highlightedRef.current].highlighted = false;
      highlightedRef.current = null;
      if (entity?.isObject && entity.id != null) {
        const id = String(entity.id);
        pickedRef.current = { id: entity.id, worldPos: hit?.worldPos };
        // 선택 객체 강조.
        if (objs[id]) { objs[id].highlighted = true; highlightedRef.current = id; }
        const meta = viewer.metaScene?.metaObjects?.[id];
        // 메타 이름 없으면 glTF 노드 id(=지표면(TIN) 등)를 이름으로 표시. 숫자 id 는 숨김.
        const fallback = /^\d+$/.test(id) ? undefined : id;
        setPick({ id, name: meta?.name ?? fallback, type: meta?.type });
      } else {
        pickedRef.current = hit?.worldPos ? { worldPos: hit.worldPos } : null;
        setPick(null);
      }
    });

    const canvasEl = canvasRef.current;
    // 비율 기반 커스텀 휠 줌 — 커서 아래 표면 지점(worldPos)을 향해, 없으면 현재 look 을
    // 향해 당긴다. 측량좌표(225km)에서도 축척 무관하게 즉시 확대/축소.
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvasEl.getBoundingClientRect();
      const canvasPos = [ev.clientX - rect.left, ev.clientY - rect.top];
      const hit = viewer.scene.pick({ canvasPos, pickSurface: true }) as { worldPos?: number[] } | undefined;
      const target = hit?.worldPos ?? [...(viewer.camera.look as number[])];
      dollyToward(viewer, target, ev.deltaY > 0 ? 1.18 : 0.82); // 축소 : 확대(약 18%/노치)
    };
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    // 더블클릭 → 클릭한 표면 지점으로 부드럽게 당긴다(반복 시 점점 접근).
    const onDblClick = (ev: MouseEvent) => {
      const rect = canvasEl.getBoundingClientRect();
      const canvasPos = [ev.clientX - rect.left, ev.clientY - rect.top];
      const hit = viewer.scene.pick({ canvasPos, pickSurface: true }) as { worldPos?: number[] } | undefined;
      if (hit?.worldPos) flyToWorldPoint(viewer, hit.worldPos);
    };
    canvasEl.addEventListener('dblclick', onDblClick);

    return () => {
      canvasEl.removeEventListener('wheel', onWheel);
      canvasEl.removeEventListener('dblclick', onDblClick);
      viewer.scene.input.off(onClick);
      navCube?.destroy();
      viewerRef.current = null;
      loaderRef.current = null;
      viewer.destroy();
    };
  }, []);

  // 배경색 토글 — CAD 선형 상당수가 '색상 7(흰색/자동)'이라 흰 배경에선 흰 선이 안 보인다.
  // 어두운 배경(Civil3D 모델공간처럼)으로 두면 흰 선형이 드러난다.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) {
      (viewer.scene.canvas as unknown as { backgroundColor: number[] }).backgroundColor = bgDark
        ? [0.13, 0.14, 0.16]
        : [1, 1, 1];
    }
  }, [bgDark]);

  /** 클릭한 '지점'으로 확대(ACC '선택 확대' 유사). 병합 메시라 엔티티 AABB(=전체)가 아니라
   *  클릭 표면 지점으로 당긴다. 클릭한 지점이 없으면 전체 맞춤. */
  const zoomToSelection = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const wp = pickedRef.current?.worldPos;
    if (wp) flyToWorldPoint(viewer, wp);
    else {
      const model = viewer.scene.models['test'];
      if (model) viewer.cameraFlight.flyTo(model);
    }
  }, []);

  /** 확대(+)/축소(−) — 항상 동작하는 비율 줌(현재 look 기준). 픽 실패와 무관. */
  const zoomStep = useCallback((factor: number) => {
    const viewer = viewerRef.current;
    if (viewer) dollyToward(viewer, [...(viewer.camera.look as number[])], factor);
  }, []);

  /** GLB(원격 URL 또는 로컬 objectURL)를 뷰어에 올린다. focus 있으면 그 박스로 flyTo. */
  const mountGlb = useCallback((src: string, label: string, focus?: Focus) => {
    const viewer = viewerRef.current;
    const loader = loaderRef.current;
    if (!viewer || !loader) return;
    setPick(null);
    highlightedRef.current = null;
    const prev = viewer.scene.models['test'];
    if (prev) prev.destroy();

    // BIM/APS(SVF)는 Z-up, xeokit/glTF는 Y-up → -90°(X축) 회전으로 세운다.
    // dtxEnabled:false — DTX(데이터텍스처)는 line/point 프리미티브를 렌더 안 함(DWG 선형이
    // 안 보이던 원인). GLTFLoaderPlugin 은 Viewer 기본이 아니라 load() 의 dtxEnabled 를 쓴다.
    // edges:false — xeokit 이 솔리드에 '계산해' 그리는 합성 엣지선(원본 데이터 아님).
    // IFC 등에서 불필요한 잡음 선으로 보였다. DWG 의 진짜 선형은 line 프리미티브로 별도
    // 로드되므로, 모든 포맷에서 합성 엣지는 끈다.
    const model = loader.load({
      id: 'test',
      src,
      edges: false,
      rotation: [-90, 0, 0],
      dtxEnabled: false,
    } as unknown as Parameters<typeof loader.load>[0]);
    model.on('loaded', () => {
      // focus(변환기가 이상치 제외해 구운 초점 박스)가 있으면 전체 AABB 대신 그걸 맞춘다.
      // DWG 등 멀리 떨어진 이상치로 모델이 콩알처럼 보이던 문제 해결. focus 좌표는 회전 전
      // (실좌표)이라 로드 회전 [-90,0,0]과 동일한 축변환((x,y,z)→(x,z,-y))을 적용한다.
      const box = focusToAabb(focus) ?? (model.aabb as number[] | undefined);
      if (box) flyToFramed(viewer, box);
      else viewer.cameraFlight.flyTo(model);
      setModelName(label);
      // DWG(CAD 선형)는 ACI 색상 체계 — 노랑·하늘색·연두 등 '밝은' 색은 흰 배경에선
      // 대비가 0에 가까워 사실상 안 보인다(그래서 CAD 모델공간은 검은 배경). Civil3D 원본도
      // 어두운 배경이라 그 색들이 보이는 것 → DWG 는 어두운 배경을 기본값으로 켠다.
      if (/\.dwg$/i.test(label)) setBgDark(true);
      setStatus('');
      setBusy(false);
      // === 화면 진단(당신 브라우저에서 실제로 로드/렌더된 상태를 스크린샷으로 확인) ===
      // 이 오버레이가 보이면 = 새 코드가 배포된 것. 안 보이면 = 옛 코드(하드 새로고침 필요).
      try {
        const ids = Object.keys(viewer.scene.objects || {});
        const a = (model.aabb as number[]) || [0, 0, 0, 0, 0, 0];
        const span = [a[3] - a[0], a[4] - a[1], a[5] - a[2]].map((x) => Math.round(x));
        const fx = focusToAabb(focus);
        const cam = viewer.camera;
        const r1 = (v: number[]) => v.map((x) => Math.round(x)).join(',');
        setDbg(
          `엔티티 ${ids.length}개 · 모델AABB span(${span.join(',')}) · ` +
            `focus=${fx ? '있음' : '없음(전체AABB사용)'} · ` +
            `cam eye(${r1(cam.eye as number[])}) look(${r1(cam.look as number[])}) up(${(cam.up as number[]).map((x) => x.toFixed(1)).join(',')})`,
        );
      } catch {
        setDbg('진단 수집 실패');
      }
    });
    model.on('error', (e: unknown) => {
      setStatus(`불러오기 실패: ${errMessage(e)}`);
      setBusy(false);
    });
  }, []);

  /**
   * 분할 XKT + LOD 스트리밍(우리 xeokit 확장). 개요(LOD1)를 먼저 띄워 즉시 보이게 하고,
   * 상세 청크(73개)는 백그라운드로 숨긴 채 순차 로드. 이후 **카메라 거리로 LOD 전환** —
   * 줌아웃(멀면) 개요만(수백만 삼각형=가벼움), 줌인(가까우면) 상세(프러스텀 컬링으로 보이는
   * 부분만) → 양 극단 모두 부드럽게. 3.6억 삼각형 렉의 근본 완화.
   */
  const mountXkt = useCallback((urls: string[], lod1Url: string | undefined, label: string, focus?: Focus) => {
    const viewer = viewerRef.current;
    const loader = xktLoaderRef.current;
    if (!viewer || !loader || urls.length === 0) return;
    setPick(null);
    highlightedRef.current = null;
    for (const id of Object.keys(viewer.scene.models)) viewer.scene.models[id].destroy();
    if (lodSubRef.current) { try { viewer.camera.off(lodSubRef.current); } catch { /* noop */ } lodSubRef.current = null; }

    const total = urls.length;
    let done = 0, failed = 0, framed = false;
    const models = viewer.scene.models as Record<string, { visible?: boolean }>;
    const frameOnce = () => {
      if (framed) return; framed = true;
      const box = focusToAabb(focus) ?? (viewer.scene.aabb as number[] | undefined);
      if (box) flyToFramed(viewer, box);
    };
    // 상세 로드 완료 후: 카메라 거리 기준 LOD 전환 설정.
    const setupSwap = () => {
      const box = (focusToAabb(focus) ?? (viewer.scene.aabb as number[])) || [0, 0, 0, 0, 0, 0];
      const diag = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) || 1000;
      // 기준 = '시점 거리'(eye→look = 줌 레벨). 넓은 모델(7.6km)에서 한 구석을 가까이 봐도
      // 중심과는 멀어 '중심거리'는 오판한다. 시점 거리는 어디를 보든 줌 정도를 정확히 반영.
      // 히스테리시스(NEAR/FAR)로 임계 근처 깜빡임 방지.
      // 디테일을 강한 기본값으로 — 개요(LOD1)는 '거의 전체맞춤 이상으로 멀 때'만. 웬만한 작업
      // 줌에선 항상 풀디테일이 보이게(개요가 거칠어 보이는 문제 회피). LOD1 화질 개선 후 재튜닝.
      const NEAR = diag * 0.6;  // 이보다 가까이 보면 상세
      const FAR = diag * 0.9;   // 이보다 멀리 보면 개요
      const hasLod = !!models['lod1'];
      let showingDetail = true;
      const apply = () => {
        const eye = viewer.camera.eye as number[];
        const look = viewer.camera.look as number[];
        const d = Math.hypot(look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]);
        if (!hasLod) return; // 개요 없으면 상세 유지
        if (showingDetail && d > FAR) showingDetail = false;
        else if (!showingDetail && d < NEAR) showingDetail = true;
        else return; // 변화 없음
        if (models['lod1']) models['lod1'].visible = !showingDetail;
        for (let i = 0; i < total; i++) { const m = models[`xkt${i}`]; if (m) m.visible = showingDetail; }
      };
      // 초기: 현재 시점 거리로 판정(전체맞춤이면 개요, 가까우면 상세).
      const eye0 = viewer.camera.eye as number[]; const look0 = viewer.camera.look as number[];
      const d0 = Math.hypot(look0[0] - eye0[0], look0[1] - eye0[1], look0[2] - eye0[2]);
      showingDetail = !(hasLod && d0 > FAR);
      if (models['lod1']) models['lod1'].visible = !showingDetail;
      for (let i = 0; i < total; i++) { const m = models[`xkt${i}`]; if (m) m.visible = showingDetail; }
      let t = 0;
      lodSubRef.current = viewer.camera.on('matrix', () => {
        const now = Date.now(); if (now - t < 120) return; t = now; apply();
      }) as unknown as string;
    };
    const finishDetail = () => {
      setModelName(label);
      setStatus('');
      setBusy(false);
      setupSwap();
      try {
        const ids = Object.keys(viewer.scene.objects || {});
        const a = (viewer.scene.aabb as number[]) || [0, 0, 0, 0, 0, 0];
        const span = [a[3] - a[0], a[4] - a[1], a[5] - a[2]].map((x) => Math.round(x));
        setDbg(`XKT ${done}/${total} + LOD1${lod1Url ? '✓' : '✗'} · 엔티티 ${ids.length}개 · AABB span(${span.join(',')})`);
      } catch { setDbg('진단 수집 실패'); }
    };
    // 상세 청크 순차 로드(숨긴 채) — 병렬이면 메모리 스파이크.
    const loadDetail = (i: number) => {
      if (i >= total) { finishDetail(); return; }
      setStatus(`상세 로딩 중… ${done + failed}/${total} 청크 (개요 표시 중)`);
      const model = loader.load({
        id: `xkt${i}`, src: urls[i], edges: false, rotation: [-90, 0, 0],
      } as unknown as Parameters<typeof loader.load>[0]);
      // 로드 즉시 숨김(로드 중 렌더 부하·깜빡임 방지 — 개요만 보이게).
      try { (model as unknown as { visible?: boolean }).visible = false; } catch { /* noop */ }
      model.on('loaded', () => { const m = models[`xkt${i}`]; if (m) m.visible = false; done++; frameOnce(); loadDetail(i + 1); });
      model.on('error', () => { failed++; loadDetail(i + 1); });
    };
    // 1) 개요(LOD1) 먼저 → 빠른 첫 화면, UI 즉시 해제. 없으면 바로 상세.
    if (lod1Url) {
      const lm = loader.load({ id: 'lod1', src: lod1Url, edges: false, rotation: [-90, 0, 0] } as unknown as Parameters<typeof loader.load>[0]);
      lm.on('loaded', () => { frameOnce(); setBusy(false); setStatus('개요 표시 · 상세 로딩 중…'); loadDetail(0); });
      lm.on('error', () => { loadDetail(0); });
    } else {
      loadDetail(0);
    }
  }, []);

  /** ACC 모델 선택 → (캐시/실패 조회 → 없으면 변환 dispatch → 폴링) → GLB/XKT 로드.
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
        xkt?: boolean;
        urls?: string[];
        lod1Url?: string;
        focus?: Focus;
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
      // XKT(분할) 우선, 없으면 단일 GLB(DWG 등).
      const doMount = (s: State) => {
        if (s.xkt && s.urls && s.urls.length) mountXkt(s.urls, s.lod1Url, f.name, s.focus);
        else if (s.url) mountGlb(s.url, f.name, s.focus);
      };
      const isReady = (s: State) => !!s.ready && (!!s.url || !!(s.urls && s.urls.length));

      setBusy(true);
      setPick(null);
      setStatus(force ? `재변환 요청 중… ${f.name}` : `변환 캐시 확인 중… ${f.name}`);
      try {
        // 1) 캐시/실패 조회(강제 재변환이면 건너뜀).
        if (!force) {
          const st = await getState();
          if (isReady(st)) {
            setStatus(`불러오는 중… ${f.name}`);
            doMount(st);
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
          body: JSON.stringify({ urn, name: f.name, project: f.accProjectId, item: f.accItemId, force, ackOverage }),
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
        if (isReady(rj)) {
          setStatus(`불러오는 중… ${f.name}`);
          doMount(rj);
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
          if (isReady(st)) {
            setStatus(`불러오는 중… ${f.name}`);
            doMount(st);
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
    [mountGlb, mountXkt],
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
    if (!viewer || !model) return;
    const box = model.aabb as number[] | undefined;
    // 평평한 도면은 top-down 으로(edge-on 방지). 3D 모델은 기존대로.
    if (box) flyToFramed(viewer, box);
    else viewer.cameraFlight.flyTo(model);
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
            onClick={zoomToSelection}
            disabled={!modelName}
            title="먼저 객체를 클릭한 뒤 누르면 그 지점으로 확대(반복하면 더 가까이). 뷰에서 더블클릭해도 그 지점으로 당겨집니다."
          >
            선택 확대
          </button>
          <button className="btn btn--sm" onClick={() => zoomStep(0.7)} disabled={!modelName} title="확대(휠 위와 동일)">
            ＋
          </button>
          <button className="btn btn--sm" onClick={() => zoomStep(1.43)} disabled={!modelName} title="축소(휠 아래와 동일)">
            －
          </button>
          <button
            className="btn btn--sm"
            onClick={() => setBgDark((v) => !v)}
            title="배경 밝기 전환 — CAD의 흰색(색상7) 선형은 어두운 배경에서 보입니다."
          >
            배경 {bgDark ? '흰색' : '어둡게'}
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
          {/* 방향 큐브(ACC 뷰큐브 유사) — 우상단 코너. */}
          <canvas ref={navCubeRef} className="threed-test__navcube" width={140} height={140} />
          {/* 진단 오버레이 — 로드된 지오메트리/카메라 상태를 화면에 표시(스크린샷 디버그용). */}
          {dbg && (
            <div
              style={{
                position: 'absolute',
                left: 8,
                bottom: 8,
                maxWidth: 'calc(100% - 16px)',
                padding: '6px 10px',
                background: 'rgba(0,0,0,0.78)',
                color: '#0f0',
                font: '11px/1.4 monospace',
                borderRadius: 6,
                pointerEvents: 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                zIndex: 20,
              }}
            >
              {dbg}
            </div>
          )}
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
