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

        const fragments = components.get(OBC.FragmentsManager);
        fragments.init('/thatopen/worker.mjs');

        // 카메라가 멈출 때 Fragments LOD/컬링 갱신.
        world.camera.controls.addEventListener('rest', () => fragments.core.update(true));
        world.camera.controls.addEventListener('update', () => fragments.core.update());

        // 모델이 추가되면 씬에 붙이고 카메라를 연결.
        fragments.list.onItemSet.add(({ value: model }) => {
          model.useCamera(world.camera.three);
          world.scene.three.add(model.object);
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
          await ifcLoader.load(bytes, false, m.name);
        }
        if (cancelled) return;

        // 전체 맞춤.
        try {
          await world.camera.controls.fitToBox(world.scene.three, false);
        } catch {
          /* 빈 박스 등은 무시 */
        }
        fragments.core.update(true);
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
