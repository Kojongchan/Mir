import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { errMessage } from '../lib/errors';
import {
  listDrawings,
  createDrawing,
  deleteDrawing,
  drawingKindOf,
  type Drawing,
} from '../lib/drawings';
import { DrawingSheet } from '../components/DrawingSheet';
import { formatDate } from '../lib/dashboard';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 도면 (2D) — 현장 PDF/DXF 도면을 업로드·열람하고 도면 위에 이슈 핀을 찍는다.
 * DWG 직접열기는 변환(APS/ODA)이 필요해 S17 로 분리(A안: PDF/DXF 우선).
 */
export function Drawings() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  // 도면 업로드·삭제·핀 작성 = 실무자(editor) 이상. RLS(0023)와 일치.
  const { canEdit } = useProjectRole(projectId);
  const authorName = profile?.full_name ?? profile?.username ?? null;

  // 이슈 상세 '도면에서 보기' 딥링크 — 해당 도면을 바로 선택.
  const location = useLocation();
  const openDrawingId = (location.state as { openDrawingId?: string } | null)?.openDrawingId ?? null;

  const [list, setList] = useState<Drawing[]>([]);
  const [selId, setSelId] = useState<string | null>(openDrawingId);
  const [msg, setMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const d = await listDrawings(projectId);
      setList(d);
      setSelId((cur) => cur ?? d[0]?.id ?? null);
    } catch (e) {
      setMsg(errMessage(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (openDrawingId) setSelId(openDrawingId);
  }, [openDrawingId]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const kind = drawingKindOf(file.name);
    if (!kind) {
      setMsg('PDF 또는 DXF 파일만 지원합니다. (DWG는 PDF/DXF로 내보내 업로드)');
      return;
    }
    setUploading(true);
    setMsg('');
    try {
      let pageCount = 1;
      if (kind === 'pdf') {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        pageCount = pdf.numPages;
        await pdf.destroy();
      }
      const created = await createDrawing({ projectId, name: file.name, kind, file, pageCount });
      setMsg(`업로드 완료: ${created.name}`);
      await refresh();
      setSelId(created.id);
    } catch (err) {
      setMsg(`업로드 실패: ${errMessage(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (d: Drawing) => {
    if (!window.confirm(`"${d.name}" 도면과 핀을 삭제할까요?`)) return;
    try {
      await deleteDrawing(d);
      setList((l) => l.filter((x) => x.id !== d.id));
      setSelId((cur) => (cur === d.id ? null : cur));
      setMsg('도면 삭제 완료');
    } catch (e) {
      setMsg(`삭제 실패: ${errMessage(e)}`);
    }
  };

  const sel = list.find((d) => d.id === selId) ?? null;

  return (
    <div className="dash draw-page">
      <div className="dash-head">
        <h1 className="dash-h1">📐 도면 (2D)</h1>
      </div>
      <p className="muted draw-intro">
        PDF·DXF 도면을 열람하고 도면 위에 이슈 핀을 찍어 3D 이슈와 연계합니다. (DWG는 PDF/DXF로
        내보내 업로드)
      </p>

      {msg && <p className="muted dash-msg">{msg}</p>}

      <div className="draw-layout">
        <aside className="draw-list">
          {canEdit && (
            <div className="draw-list-head">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.dxf,application/pdf"
                hidden
                onChange={onPick}
              />
              <button
                className="primary"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? '업로드 중…' : '＋ 도면 업로드'}
              </button>
            </div>
          )}
          {list.length === 0 ? (
            <EmptyState
              compact
              icon="📐"
              title="등록된 도면이 없습니다"
              desc={canEdit ? '상단에서 PDF/DXF를 업로드하세요.' : undefined}
            />
          ) : (
            <ul className="draw-list-items">
              {list.map((d) => (
                <li
                  key={d.id}
                  className={`draw-list-item${d.id === selId ? ' is-active' : ''}`}
                  onClick={() => setSelId(d.id)}
                >
                  <span className={`draw-kind draw-kind-${d.kind}`}>{d.kind}</span>
                  <span className="draw-list-name" title={d.name}>
                    {d.name}
                  </span>
                  <span className="draw-list-date muted">{formatDate(d.created_at)}</span>
                  {canEdit && (
                    <button
                      className="draw-list-del"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(d);
                      }}
                      title="삭제"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="draw-main">
          {sel ? (
            <DrawingSheet
              key={sel.id}
              drawing={sel}
              projectId={projectId}
              canEdit={canEdit}
              authorName={authorName}
            />
          ) : (
            <div className="draw-placeholder muted">왼쪽에서 도면을 선택하세요.</div>
          )}
        </main>
      </div>
    </div>
  );
}
