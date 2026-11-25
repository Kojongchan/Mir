import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TilesViewer } from '../../viewer2/TilesViewer';
import { STATUS_LABEL, type Issue } from '../../lib/issues';
import { ISSUE_TYPES, TYPE_LABEL, type IssueType } from '../../lib/issueTypes';
import type { IssueCategory } from '../../lib/issueCategories';

// =====================================================================
// 통합모델(3D) 자체 엔진의 이슈 — 기존 Autodesk 뷰어(ApsIssuePins·AccModels)와 같은 데이터·같은 모양.
// 이슈는 객체의 외부 ID(global_id = Revit UniqueId·IFC GlobalId)에 묶여 있어, 같은 모델이면 두 뷰어가 같은 핀을 본다.
// 핀 위치 = 객체 상자(objects.bin)의 중심, 번호 = 생성 순(이슈 화면과 같음), 색 = 미해결 빨강 / 해결 초록.
// =====================================================================

const OPEN = new Set(['open', 'in_progress']);
const REF_DIST = 60; // 이 거리에서 기본 크기 — 가까우면 커지고 멀면 작아짐
const PIN_BASE = 38;

type Anchor = { issue: Issue; center: [number, number, number]; idx: number };
type PinPos = { issue: Issue; x: number; y: number; idx: number; scale: number };

/** 이슈 핀(객체 위 물방울 마커). 카메라가 움직일 때마다 화면 위치를 다시 계산한다. */
export function MirIssuePins({ viewer, issues, anchors, boxes, onPinClick }: {
  viewer: TilesViewer;
  issues: Issue[];
  /** global_id → 이 모델의 객체 번호(dbId). */
  anchors: ReadonlyMap<string, number>;
  /** objects.bin: 객체마다 [minX, minY, minZ, maxX, maxY, maxZ] (타일셋 좌표). */
  boxes: Float32Array;
  onPinClick: (issue: Issue) => void;
}) {
  const [pins, setPins] = useState<PinPos[]>([]);
  const anchorsRef = useRef<Anchor[]>([]);

  const recompute = useCallback(() => {
    const out: PinPos[] = [];
    for (const a of anchorsRef.current) {
      const p = viewer.toScreen(a.center[0], a.center[1], a.center[2]);
      if (!p) continue;
      const scale = Math.max(0.9, Math.min(1.5, REF_DIST / Math.max(1, p.distance)));
      out.push({ issue: a.issue, x: p.x, y: p.y, idx: a.idx, scale });
    }
    setPins(out);
  }, [viewer]);

  useEffect(() => {
    const order = new Map<string, number>();
    [...issues].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach((it, i) => order.set(it.id, i + 1));
    const next: Anchor[] = [];
    for (const issue of issues) {
      const dbId = issue.global_id ? anchors.get(issue.global_id) : undefined;
      if (dbId === undefined || dbId * 6 + 5 >= boxes.length || Number.isNaN(boxes[dbId * 6])) continue;
      const b = (k: number) => boxes[dbId * 6 + k];
      next.push({ issue, center: [(b(0) + b(3)) / 2, (b(1) + b(4)) / 2, (b(2) + b(5)) / 2], idx: order.get(issue.id) ?? 0 });
    }
    anchorsRef.current = next;
    recompute();
  }, [issues, anchors, boxes, recompute]);

  useEffect(() => viewer.onViewChange(recompute), [viewer, recompute]);

  return (
    <div className="mir-pins" aria-label="이슈 핀">
      {pins.map((p) => {
        const color = OPEN.has(p.issue.status) ? '#dc2626' : '#16a34a';
        const w = Math.round(PIN_BASE * p.scale);
        const h = Math.round(((PIN_BASE * 34) / 26) * p.scale);
        return (
          <svg key={p.issue.id} width={w} height={h} viewBox="0 0 26 34" className="mir-pin" style={{ left: p.x, top: p.y }}
            onClick={() => onPinClick(p.issue)} role="button" aria-label={`이슈 ${p.idx}: ${p.issue.title}`}>
            <title>{p.issue.title}</title>
            <path d="M13 1C6.4 1 1 6.4 1 13c0 8.4 12 20 12 20s12-11.6 12-20C25 6.4 19.6 1 13 1z" fill={color} stroke="#fff" strokeWidth="1.6" />
            <circle cx="13" cy="13" r="8" fill="rgba(255,255,255,0.18)" />
            <text x="13" y="17.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">{p.idx}</text>
          </svg>
        );
      })}
    </div>
  );
}

/** 핀을 누르면 뜨는 이슈 요약. */
export function MirIssuePopup({ issue, projectId, canEdit, onFocus, onSaveView, onClose }: {
  issue: Issue;
  projectId: string;
  canEdit: boolean;
  onFocus: (issue: Issue) => void;
  onSaveView: (issue: Issue) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="mir-issue-pop" role="dialog" aria-label={`이슈: ${issue.title}`}>
      <div className="mir-issue-pop__head">
        <strong>{issue.title}</strong>
        <button type="button" className="ic-only" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      <div className="muted mir-issue-pop__meta">
        상태: {STATUS_LABEL[issue.status]}{issue.assignee_name ? ` · 담당 ${issue.assignee_name}` : ''}
      </div>
      {issue.description && <div className="mir-issue-pop__desc">{issue.description}</div>}
      <div className="mir-issue-pop__acts">
        <button type="button" className="btn btn--sm" onClick={() => onFocus(issue)}>위치 보기</button>
        <button type="button" className="btn btn--sm" onClick={() => navigate(`/project/${projectId}/issues`, { state: { focusIssueId: issue.id } })}>
          이슈로 이동
        </button>
        {canEdit && (
          <button type="button" className="btn btn--sm" onClick={() => onSaveView(issue)} title="지금 3D 화면(시점·스냅샷)을 이 이슈의 뷰포인트로 저장">
            현재 뷰 저장
          </button>
        )}
      </div>
    </div>
  );
}

/** 선택한 객체 위치에 이슈 만들기(제목·항목·유형). */
export function MirIssueForm({ categories, onSubmit, onClose }: {
  categories: IssueCategory[];
  onSubmit: (form: { title: string; category_id: string; type: IssueType }) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<{ title: string; category_id: string; type: IssueType }>({ title: '', category_id: '', type: 'general' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try { await onSubmit({ ...form, title: form.title.trim() }); } finally { setBusy(false); }
  };
  return (
    <div className="mir-issue-form__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mir-issue-form" role="dialog" aria-label="이 위치에 이슈">
        <strong>＋ 이 위치에 이슈</strong>
        <div className="muted mir-issue-form__sub">선택한 3D 객체에 묶입니다. 지금 화면이 뷰포인트로 함께 저장됩니다.</div>
        <label>
          제목
          <input autoFocus value={form.title} placeholder="예: 슬래브 배근 간섭 확인"
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onClose(); }} />
        </label>
        <div className="mir-issue-form__row">
          <label>
            항목
            <select value={form.category_id} onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}>
              <option value="">미지정</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            유형
            <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as IssueType }))}>
              {ISSUE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </div>
        <div className="mir-issue-form__acts">
          <button type="button" className="btn btn--sm" onClick={onClose}>취소</button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()} disabled={!form.title.trim() || busy}>
            {busy ? '저장 중…' : '생성'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 뷰포인트 카메라: 자체 엔진 것은 engine:'mir' 로 표시해 기존 뷰어 상태와 구분한다. */
export type MirViewState = { engine: 'mir'; position: [number, number, number]; target: [number, number, number] };
export const isMirView = (v: unknown): v is MirViewState =>
  !!v && typeof v === 'object' && (v as { engine?: unknown }).engine === 'mir'
  && Array.isArray((v as { position?: unknown }).position) && Array.isArray((v as { target?: unknown }).target);
