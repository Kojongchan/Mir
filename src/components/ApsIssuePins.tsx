import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { computeDbIdWorldBox } from '../lib/apsClash';
import type { ApsMapping } from '../lib/apsMapping';
import type { Issue } from '../lib/issues';

// =====================================================================
// APS 이슈 핀 오버레이 — S49 / Step 2. 이슈(global_id 앵커)를 APS 캔버스 위
// HTML 마커로 렌더한다. dbId(=GlobalId 해석) 의 월드 bbox 중심을 viewer.worldToClient
// 로 화면좌표로 변환해 절대배치. 카메라 이동 시 rAF 스로틀로 재계산. 클릭 → 팝업
// (데이터/팝업 UI 는 기존 이슈 모듈 재사용, 3D 렌더 레이어만 신규).
// 색은 상태별 토큰(미해결=빨강/해결=초록) — 핀 마커 hex 예외(3D 시각화).
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

interface Props {
  viewer: ApsViewer;
  model: ApsModel;
  mapping: ApsMapping;
  issues: Issue[];
  onPinClick: (issue: Issue) => void;
}

interface PinPos {
  issue: Issue;
  x: number;
  y: number;
  idx: number;
}

const OPEN = new Set(['open', 'in_progress']);

export function ApsIssuePins({ viewer, model, mapping, issues, onPinClick }: Props) {
  const [pins, setPins] = useState<PinPos[]>([]);
  const rafRef = useRef<number | null>(null);

  // 앵커된 이슈(global_id 존재)만, 검출 가능한 dbId 의 월드 중심을 미리 캐시.
  const anchorsRef = useRef<Array<{ issue: Issue; center: THREE.Vector3; idx: number }>>([]);
  useEffect(() => {
    const anchors: Array<{ issue: Issue; center: THREE.Vector3; idx: number }> = [];
    issues.forEach((issue, i) => {
      if (!issue.global_id) return;
      const dbId = mapping.globalIdToDbId.get(issue.global_id);
      if (typeof dbId !== 'number') return;
      const box = computeDbIdWorldBox(model, dbId);
      if (!box || box.isEmpty()) return;
      anchors.push({ issue, center: box.getCenter(new THREE.Vector3()), idx: i + 1 });
    });
    anchorsRef.current = anchors;
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, mapping, model]);

  const recompute = () => {
    const out: PinPos[] = [];
    for (const a of anchorsRef.current) {
      try {
        const pt = viewer.worldToClient(a.center.clone());
        if (!pt || Number.isNaN(pt.x) || Number.isNaN(pt.y)) continue;
        out.push({ issue: a.issue, x: pt.x, y: pt.y, idx: a.idx });
      } catch {
        /* 변환 실패 무시 */
      }
    }
    setPins(out);
  };

  // 마운트/모델 준비 직후 카메라가 잡히면 한 번 더 계산(첫 프레임 누락 방지).
  useEffect(() => {
    const t = setTimeout(() => recompute(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorsRef.current.length]);

  // 카메라 이동/리사이즈 시 rAF 스로틀 재계산.
  useEffect(() => {
    const Autodesk = (window as unknown as { Autodesk?: any }).Autodesk;
    if (!Autodesk || !viewer) return;
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
      viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, schedule);
      window.removeEventListener('resize', schedule);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 20 }}>
      {pins.map((p) => {
        const color = OPEN.has(p.issue.status) ? '#dc2626' : '#16a34a';
        return (
          <button
            key={p.issue.id}
            onClick={() => onPinClick(p.issue)}
            title={p.issue.title}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'auto',
              width: 22,
              height: 22,
              borderRadius: '50% 50% 50% 0',
              transformOrigin: 'center',
              rotate: '-45deg',
              background: color,
              border: '2px solid #fff',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ rotate: '45deg' }}>{p.idx}</span>
          </button>
        );
      })}
    </div>
  );
}
