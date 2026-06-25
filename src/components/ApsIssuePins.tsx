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
  scale: number;
}

const OPEN = new Set(['open', 'in_progress']);
const REF_DIST = 30; // 이 거리에서 기본 크기. 가까우면 커지고 멀면 작아짐(원근감).

export function ApsIssuePins({ viewer, model, mapping, issues, onPinClick }: Props) {
  const [pins, setPins] = useState<PinPos[]>([]);
  const rafRef = useRef<number | null>(null);

  // 앵커된 이슈(global_id 존재)만, 검출 가능한 dbId 의 월드 중심을 미리 캐시.
  // 번호는 생성 순(오래된→최신)으로 부여 — 이슈 탭과 일치(#5).
  const anchorsRef = useRef<Array<{ issue: Issue; center: THREE.Vector3; idx: number }>>([]);
  useEffect(() => {
    const order = new Map<string, number>();
    [...issues]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach((it, i) => order.set(it.id, i + 1));
    const anchors: Array<{ issue: Issue; center: THREE.Vector3; idx: number }> = [];
    for (const issue of issues) {
      if (!issue.global_id) continue;
      const dbId = mapping.globalIdToDbId.get(issue.global_id);
      if (typeof dbId !== 'number') continue;
      const box = computeDbIdWorldBox(model, dbId);
      if (!box || box.isEmpty()) continue;
      anchors.push({ issue, center: box.getCenter(new THREE.Vector3()), idx: order.get(issue.id) ?? 0 });
    }
    anchorsRef.current = anchors;
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, mapping, model]);

  const recompute = () => {
    const out: PinPos[] = [];
    // 카메라 위치·시선으로 원근 스케일 + 뒤쪽 컬링(3D 느낌, #6).
    let camPos: THREE.Vector3 | null = null;
    let fwd: THREE.Vector3 | null = null;
    try {
      camPos = viewer.navigation.getPosition().clone();
      fwd = viewer.navigation.getTarget().clone().sub(camPos).normalize();
    } catch {
      /* 일부 상태에서 미지원 */
    }
    for (const a of anchorsRef.current) {
      try {
        if (camPos && fwd) {
          const toAnchor = a.center.clone().sub(camPos);
          if (toAnchor.dot(fwd) <= 0) continue; // 카메라 뒤 → 숨김
        }
        const pt = viewer.worldToClient(a.center.clone());
        if (!pt || Number.isNaN(pt.x) || Number.isNaN(pt.y)) continue;
        const dist = camPos ? camPos.distanceTo(a.center) : REF_DIST;
        const scale = Math.max(0.6, Math.min(1.8, REF_DIST / Math.max(1, dist)));
        out.push({ issue: a.issue, x: pt.x, y: pt.y, idx: a.idx, scale });
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
        const open = OPEN.has(p.issue.status);
        const color = open ? '#dc2626' : '#16a34a';
        const w = Math.round(26 * p.scale);
        const h = Math.round((26 * 34) / 26 * p.scale); // 26:34 비율 핀
        return (
          <svg
            key={p.issue.id}
            width={w}
            height={h}
            viewBox="0 0 26 34"
            onClick={() => onPinClick(p.issue)}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              transform: 'translate(-50%, -100%)', // 핀 끝(아래)이 객체를 가리키도록
              pointerEvents: 'auto',
              cursor: 'pointer',
              filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.55))',
            }}
          >
            <title>{p.issue.title}</title>
            {/* 물방울 핀 본체 */}
            <path
              d="M13 1C6.4 1 1 6.4 1 13c0 8.4 12 20 12 20s12-11.6 12-20C25 6.4 19.6 1 13 1z"
              fill={color}
              stroke="#fff"
              strokeWidth="1.6"
            />
            {/* 안쪽 하이라이트(입체감) */}
            <circle cx="13" cy="13" r="8" fill="rgba(255,255,255,0.18)" />
            <text x="13" y="17.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">
              {p.idx}
            </text>
          </svg>
        );
      })}
    </div>
  );
}
