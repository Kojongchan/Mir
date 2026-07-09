import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

// =====================================================================
// 경량 APS 3D 뷰어 — 이슈 '관련 자료'의 모델(rvt·nwd·ifc…)을 그 자리에서 3D 로 연다.
// AccModels 의 전체 뷰어와 별개로, urn 하나를 받아 GuiViewer3D 를 띄운다. 스크립트/
// Initializer 는 페이지 단위로 1회만 로드(모듈 싱글턴).
// =====================================================================

const VIEWER_VER = '7.*';
const VIEWER_CSS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VER}/style.min.css`;
const VIEWER_JS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VER}/viewer3D.min.js`;

let scriptP: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (scriptP) return scriptP;
  scriptP = new Promise<void>((resolve, reject) => {
    if ((window as unknown as { Autodesk?: unknown }).Autodesk) return resolve();
    if (!document.querySelector(`link[href="${VIEWER_CSS}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = VIEWER_CSS;
      document.head.appendChild(l);
    }
    const existing = document.querySelector(`script[src="${VIEWER_JS}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('APS Viewer 스크립트 로드 실패')));
      return;
    }
    const s = document.createElement('script');
    s.src = VIEWER_JS;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('APS Viewer 스크립트 로드 실패'));
    document.body.appendChild(s);
  });
  return scriptP;
}

async function getApsToken(): Promise<{ access_token: string; expires_in: number }> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/aps-token', {
    method: 'POST',
    headers: data.session ? { authorization: `Bearer ${data.session.access_token}` } : {},
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `토큰 오류(${res.status})`);
  return res.json();
}

let initP: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (initP) return initP;
  initP = loadScript().then(
    () =>
      new Promise<void>((resolve) => {
        const A = (window as unknown as { Autodesk?: any }).Autodesk;
        A.Viewing.Initializer(
          {
            env: 'AutodeskProduction2',
            api: 'streamingV2',
            getAccessToken: async (onToken: (t: string, exp: number) => void) => {
              const t = await getApsToken();
              onToken(t.access_token, t.expires_in);
            },
          },
          () => resolve(),
        );
      }),
  );
  return initP;
}

export function ApsMiniViewer({ urn }: { urn: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [status, setStatus] = useState('3D 뷰 불러오는 중…');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureInit();
        if (cancelled || !ref.current) return;
        const A = (window as unknown as { Autodesk?: any }).Autodesk;
        const viewer = new A.Viewing.GuiViewer3D(ref.current, {
          extensions: ['Autodesk.Measure', 'Autodesk.Section', 'Autodesk.PropertiesManager', 'Autodesk.ModelStructure', 'Autodesk.DocumentBrowser'],
        });
        viewer.start();
        viewer.setBackgroundColor(40, 48, 64, 20, 26, 38);
        viewerRef.current = viewer;
        const docId = urn.startsWith('urn:') ? urn : `urn:${urn}`;
        A.Viewing.Document.load(
          docId,
          (doc: any) => {
            if (cancelled) return;
            const node = doc.getRoot().getDefaultGeometry();
            viewer.loadDocumentNode(doc, node);
            setStatus('');
          },
          (code: unknown, msg: unknown) => {
            if (!cancelled) setStatus(`3D 로드 실패: ${msg ?? code} (변환 전이거나 권한)`);
          },
        );
      } catch (e) {
        if (!cancelled) setStatus(`뷰어 오류: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      try {
        viewerRef.current?.finish?.();
      } catch {
        /* 무시 */
      }
      viewerRef.current = null;
    };
  }, [urn]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {status && (
        <div className="muted" style={{ position: 'absolute', top: 10, left: 14, background: 'var(--panel)', padding: '4px 10px', borderRadius: 6 }}>
          {status}
        </div>
      )}
    </div>
  );
}
