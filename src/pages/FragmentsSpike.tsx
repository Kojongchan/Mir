import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import { listModels, downloadModelBytes } from '../lib/api';
import { errMessage } from '../lib/errors';

/**
 * 성능 마이그레이션 spike — ThatOpen Fragments 엔진으로 같은 프로젝트의 통합모델을
 * 로드해 기존 뷰어와 A/B 성능 비교용. 기존 IfcViewer 와 완전히 분리(별도 경로
 * /frag/:projectId). IFC→Fragments(인스턴싱·중복제거) 변환 후 렌더하므로 드로콜이
 * 크게 줄어 회전이 부드러운지 확인하는 것이 목적.
 */
export function FragmentsSpike() {
  const { projectId = '' } = useParams();
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('초기화 중…');

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const components = new OBC.Components();
    let cancelled = false;

    (async () => {
      try {
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
        world.scene = new OBC.SimpleScene(components);
        world.renderer = new OBC.SimpleRenderer(components, container);
        world.camera = new OBC.OrthoPerspectiveCamera(components);
        components.init();
        world.scene.setup();
        world.scene.three.background = new THREE.Color(0xffffff);

        // 동적 해상도: 회전/이동 중에는 낮은 픽셀비로 그려 FPS↑, 멈추면 선명하게 복원.
        const renderer = world.renderer.three;
        const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
        const setRes = (r: number) => {
          renderer.setPixelRatio(r);
          renderer.setSize(container.clientWidth, container.clientHeight, false);
        };
        setRes(maxDpr);
        world.camera.controls.addEventListener('control', () => setRes(Math.min(maxDpr, 1)));
        world.camera.controls.addEventListener('rest', () => setRes(maxDpr));

        const fragments = components.get(OBC.FragmentsManager);
        fragments.init('/thatopen/worker.mjs');

        // 회전/이동 중에도 LOD·컬링을 계속 갱신(멈출 때만 하면 회전 중 사라짐).
        world.camera.controls.addEventListener('control', () => fragments.core.update());
        world.camera.controls.addEventListener('update', () => fragments.core.update());
        world.camera.controls.addEventListener('rest', () => fragments.core.update(true));

        // 모델이 추가되면 씬에 붙이고, 양면 렌더로(뒷면 사라짐 방지) + 카메라 연결.
        fragments.list.onItemSet.add(({ value: model }) => {
          model.useCamera(world.camera.three);
          world.scene.three.add(model.object);
          model.object.traverse((o) => {
            const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
            if (!mat) return;
            for (const mm of Array.isArray(mat) ? mat : [mat]) mm.side = THREE.DoubleSide;
          });
          fragments.core.update(true);
        });

        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({ autoSetWasm: false, wasm: { path: '/web-ifc/', absolute: true } });

        const models = await listModels(projectId, 'integrated');
        if (cancelled) return;
        if (models.length === 0) {
          setStatus('통합모델이 없습니다.');
          return;
        }

        for (let i = 0; i < models.length; i++) {
          const m = models[i];
          setStatus(`Fragments 변환·로드 중: ${m.name} (${i + 1}/${models.length})`);
          const bytes = await downloadModelBytes(m.storage_path, m.bucket);
          if (cancelled) return;
          // coordinate=true: 원점으로 재정렬해 georeference 대좌표의 깊이/클리핑·작게보임 방지.
          await ifcLoader.load(bytes, true, m.name);
        }
        if (cancelled) return;

        // 전체 맞춤(로드 직후 + 살짝 뒤 한 번 더: Fragments 후처리 반영).
        const fit = async () => {
          try {
            await world.camera.controls.fitToBox(world.scene.three, false);
          } catch {
            /* 빈 박스 등은 무시 */
          }
          fragments.core.update(true);
        };
        await fit();
        setTimeout(() => void fit(), 600);
        setStatus(`완료 — 모델 ${models.length}개 (회전 부드러움 비교)`);
      } catch (e) {
        setStatus(`오류: ${errMessage(e)} (콘솔 로그를 알려주시면 바로 보완합니다)`);
      }
    })();

    return () => {
      cancelled = true;
      components.dispose();
    };
  }, [projectId]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 12,
          padding: '6px 10px',
          background: 'rgba(17,24,39,0.85)',
          color: '#fff',
          borderRadius: 8,
          fontSize: 12,
          maxWidth: '70vw',
        }}
      >
        🧪 Fragments 엔진 spike · {status}
      </div>
    </div>
  );
}
