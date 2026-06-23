import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

/**
 * APS(Autodesk Platform Services) Viewer 스파이크 — ACC/OSS 에 있는 모델(rvt·nwd·
 * dwg·ifc, 텍스처 유지·SVF2 스트리밍)을 우리 사이트에서 띄운다. 2-legged 토큰은
 * 서버(/api/aps-token)가 발급하므로 **외부 사용자는 오토데스크 계정이 필요 없다**.
 *
 * 사용: /aps?urn=<base64 URN>  (URN 은 ACC 아이템 버전/OSS 오브젝트의 인코딩 값)
 * 사전조건: Vercel 환경변수 APS_CLIENT_ID / APS_CLIENT_SECRET + ACC 앱 통합 승인.
 */
const VIEWER_VER = '7.*';
const VIEWER_CSS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VER}/style.min.css`;
const VIEWER_JS = `https://developer.api.autodesk.com/modelderivative/v2/viewers/${VIEWER_VER}/viewer3D.min.js`;

function loadScriptOnce(src: string, css: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { Autodesk?: unknown }).Autodesk) return resolve();
    if (!document.querySelector(`link[href="${css}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = css;
      document.head.appendChild(l);
    }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('APS Viewer 스크립트 로드 실패')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('APS Viewer 스크립트 로드 실패'));
    document.body.appendChild(s);
  });
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

export function ApsViewerSpike() {
  const [params] = useSearchParams();
  const urnFromUrl = params.get('urn') ?? '';
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const [urn, setUrn] = useState(urnFromUrl);
  const [status, setStatus] = useState('APS Viewer 준비…');

  const openModel = async (rawUrn: string) => {
    const Autodesk = (window as unknown as { Autodesk?: any }).Autodesk;
    const viewer = viewerRef.current as any;
    if (!Autodesk || !viewer || !rawUrn) return;
    const docId = rawUrn.startsWith('urn:') ? rawUrn : `urn:${rawUrn}`;
    setStatus('모델 불러오는 중…');
    Autodesk.Viewing.Document.load(
      docId,
      (doc: any) => {
        const node = doc.getRoot().getDefaultGeometry();
        viewer.loadDocumentNode(doc, node);
        setStatus('완료 — 회전/확대해 성능·텍스처 확인');
      },
      (code: unknown, msg: unknown) => setStatus(`문서 로드 실패: ${msg ?? code} (URN/권한 확인)`),
    );
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadScriptOnce(VIEWER_JS, VIEWER_CSS);
        if (cancelled) return;
        const Autodesk = (window as unknown as { Autodesk?: any }).Autodesk;
        await new Promise<void>((resolve) =>
          Autodesk.Viewing.Initializer(
            {
              env: 'AutodeskProduction2',
              api: 'streamingV2',
              getAccessToken: async (onToken: (t: string, exp: number) => void) => {
                try {
                  const t = await getApsToken();
                  onToken(t.access_token, t.expires_in);
                } catch (e) {
                  setStatus(`토큰 발급 실패: ${(e as Error).message}`);
                }
              },
            },
            () => resolve(),
          ),
        );
        if (cancelled || !containerRef.current) return;
        const viewer = new Autodesk.Viewing.GuiViewer3D(containerRef.current);
        viewer.start();
        viewerRef.current = viewer;
        setStatus(urnFromUrl ? 'URN 로딩…' : 'URN 을 입력하세요(ACC/OSS 인코딩 값).');
        if (urnFromUrl) void openModel(urnFromUrl);
      } catch (e) {
        setStatus(`초기화 오류: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      const v = viewerRef.current as any;
      if (v?.finish) v.finish();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, background: '#111827', color: '#fff', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>🅰 APS Viewer 스파이크</strong>
        <input
          value={urn}
          onChange={(e) => setUrn(e.target.value)}
          placeholder="base64 URN (ACC item version / OSS object)"
          style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: 'none', fontSize: 12 }}
        />
        <button onClick={() => void openModel(urn)} style={{ padding: '4px 10px', borderRadius: 6 }}>
          열기
        </button>
        <span style={{ fontSize: 12, opacity: 0.85 }}>{status}</span>
      </div>
      <div ref={containerRef} style={{ position: 'relative', flex: 1 }} />
    </div>
  );
}
