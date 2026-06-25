import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// =====================================================================
// 간섭 치수 라벨 — S49 (아이디어 #3). 활성 간섭의 관통깊이/이격거리를 그 위치에
// 3D 앵커 라벨로 표시(카메라를 돌려도 따라옴). 기본 OFF, 패널 토글로 켠다.
// 이슈 핀과 동일하게 **뷰어 컨테이너 안 absolute 오버레이**로 렌더(좌표 보정 불필요).
// =====================================================================

type ApsViewer = any;

export interface ClashDim {
  point: { x: number; y: number; z: number };
  label: string;
  color: string;
}

interface Props {
  viewer: ApsViewer;
  dim: ClashDim;
}

export function ApsClashDim({ viewer, dim }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const world = useRef(new THREE.Vector3());
  world.current.set(dim.point.x, dim.point.y, dim.point.z);

  const recompute = () => {
    try {
      const camPos = viewer.navigation.getPosition();
      const fwd = viewer.navigation.getTarget().clone().sub(camPos).normalize();
      if (world.current.clone().sub(camPos).dot(fwd) <= 0) return setPos(null);
      const pt = viewer.worldToClient(world.current.clone());
      if (!pt || Number.isNaN(pt.x)) return setPos(null);
      setPos({ x: pt.x, y: pt.y });
    } catch {
      setPos(null);
    }
  };

  useEffect(() => {
    const Autodesk = (window as unknown as { Autodesk?: any }).Autodesk;
    recompute();
    const t = setTimeout(recompute, 200);
    if (!Autodesk || !viewer) return () => clearTimeout(t);
    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, schedule);
    window.addEventListener('resize', schedule);
    return () => {
      clearTimeout(t);
      viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, schedule);
      window.removeEventListener('resize', schedule);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, dim.point.x, dim.point.y, dim.point.z]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 22 }}>
      {pos && (
        <div
          style={{
            position: 'absolute',
            left: pos.x,
            top: pos.y,
            transform: 'translate(-50%, -150%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              background: '#0f1722',
              color: '#fff',
              border: `2px solid ${dim.color}`,
              borderRadius: 14,
              padding: '3px 10px',
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            }}
          >
            {dim.label}
          </div>
          <div style={{ width: 2, height: 20, background: dim.color }} />
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: dim.color, marginTop: -2, border: '1px solid #fff' }} />
        </div>
      )}
    </div>
  );
}
