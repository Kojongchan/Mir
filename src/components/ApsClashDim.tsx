import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// =====================================================================
// 간섭 치수 라벨 — S49 (아이디어 #3). 활성 간섭의 관통깊이/이격거리를 그 위치에
// 3D 앵커 라벨로 표시(카메라를 돌려도 따라옴). 기본 OFF, 패널 토글로 켠다.
// 가벼운 HTML 오버레이(라인+알약 라벨) — 결과 1건에만 표시해 성능 부담 없음.
// =====================================================================

type ApsViewer = any;

interface Props {
  viewer: ApsViewer;
  point: { x: number; y: number; z: number };
  label: string;
  color: string;
}

export function ApsClashDim({ viewer, point, label, color }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const world = useRef(new THREE.Vector3(point.x, point.y, point.z));
  world.current.set(point.x, point.y, point.z);

  const recompute = () => {
    try {
      // 카메라 뒤면 숨김.
      const camPos = viewer.navigation.getPosition();
      const fwd = viewer.navigation.getTarget().clone().sub(camPos).normalize();
      if (world.current.clone().sub(camPos).dot(fwd) <= 0) {
        setPos(null);
        return;
      }
      const pt = viewer.worldToClient(world.current.clone());
      if (!pt || Number.isNaN(pt.x)) return setPos(null);
      // worldToClient 는 캔버스 기준 px → position:fixed(뷰포트) 보정용 offset 가산.
      const rect = viewer.container?.getBoundingClientRect?.() ?? viewer.canvas?.getBoundingClientRect?.();
      setPos({ x: pt.x + (rect?.left ?? 0), y: pt.y + (rect?.top ?? 0) });
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
  }, [viewer, point.x, point.y, point.z]);

  if (!pos) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 22 }}>
      <div
        style={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          transform: 'translate(-50%, -140%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            background: '#0f1722',
            color: '#fff',
            border: `2px solid ${color}`,
            borderRadius: 14,
            padding: '3px 10px',
            fontSize: 12,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}
        >
          {label}
        </div>
        {/* 지시선 */}
        <div style={{ width: 2, height: 18, background: color }} />
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, marginTop: -2, border: '1px solid #fff' }} />
      </div>
    </div>
  );
}
