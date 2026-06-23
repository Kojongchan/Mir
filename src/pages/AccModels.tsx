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

/** ACC Data Management 프록시 호출(서버가 2-legged 처리). */
async function accFetch(params: Record<string, string>): Promise<any> {
  const { data } = await supabase.auth.getSession();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/aps-acc?${qs}`, {
    headers: data.session ? { authorization: `Bearer ${data.session.access_token}` } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `ACC 오류(${res.status})`);
  return body;
}

type Named = { id: string; name: string };
type Item = { id: string; name: string; urn: string | null };

export function AccModels() {
  const [params] = useSearchParams();
  const urnFromUrl = params.get('urn') ?? '';
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const [urn, setUrn] = useState(urnFromUrl);
  const [status, setStatus] = useState('APS Viewer 준비…');

  // ACC 탐색 상태.
  const [showBrowser, setShowBrowser] = useState(!urnFromUrl);
  const [hubs, setHubs] = useState<Named[]>([]);
  const [hub, setHub] = useState('');
  const [projects, setProjects] = useState<Named[]>([]);
  const [project, setProject] = useState('');
  const [folders, setFolders] = useState<Named[]>([]); // 현재 폴더의 하위 폴더
  const [folderPath, setFolderPath] = useState<Named[]>([]); // 브레드크럼
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  const loadHubs = async () => {
    setBusy(true);
    try {
      const { hubs } = await accFetch({ action: 'hubs' });
      setHubs(hubs);
    } catch (e) {
      setStatus(`허브 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pickHub = async (h: string) => {
    setHub(h);
    setProject('');
    setProjects([]);
    setFolders([]);
    setFolderPath([]);
    setItems([]);
    if (!h) return;
    setBusy(true);
    try {
      const { projects } = await accFetch({ action: 'projects', hub: h });
      setProjects(projects);
    } catch (e) {
      setStatus(`프로젝트 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pickProject = async (p: string) => {
    setProject(p);
    setFolders([]);
    setFolderPath([]);
    setItems([]);
    if (!p) return;
    setBusy(true);
    try {
      const { folders } = await accFetch({ action: 'topFolders', hub, project: p });
      setFolders(folders);
      setFolderPath([]);
      setItems([]);
    } catch (e) {
      setStatus(`폴더 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (f: Named, depth: number) => {
    setBusy(true);
    try {
      const { folders, items } = await accFetch({ action: 'contents', project, folder: f.id });
      setFolders(folders);
      setItems(items);
      setFolderPath((prev) => [...prev.slice(0, depth), f]);
    } catch (e) {
      setStatus(`내용 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pickItem = (it: Item) => {
    if (!it.urn) {
      setStatus(`${it.name}: 변환된 뷰가 없습니다(ACC에서 처리 중일 수 있음).`);
      return;
    }
    setUrn(it.urn);
    setShowBrowser(false);
    void openModel(it.urn);
  };

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
        setStatus(urnFromUrl ? 'URN 로딩…' : 'ACC에서 모델을 선택하세요.');
        if (urnFromUrl) void openModel(urnFromUrl);
        else void loadHubs();
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
        <strong style={{ fontSize: 13 }}>🅰 ACC 모델 (APS)</strong>
        <input
          value={urn}
          onChange={(e) => setUrn(e.target.value)}
          placeholder="base64 URN (ACC item version / OSS object)"
          style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: 'none', fontSize: 12 }}
        />
        <button onClick={() => void openModel(urn)} style={{ padding: '4px 10px', borderRadius: 6 }}>
          열기
        </button>
        <button
          onClick={() => setShowBrowser((s) => !s)}
          style={{ padding: '4px 10px', borderRadius: 6 }}
        >
          {showBrowser ? '탐색 닫기' : 'ACC 탐색'}
        </button>
        <span style={{ fontSize: 12, opacity: 0.85 }}>{status}</span>
      </div>
      <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
        {showBrowser && (
          <div
            style={{
              width: 320,
              borderRight: '1px solid #1f2937',
              background: '#0b1220',
              color: '#e5e7eb',
              padding: 10,
              overflowY: 'auto',
              fontSize: 13,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <strong>ACC 탐색</strong>
              {busy && <span style={{ opacity: 0.7 }}>로딩…</span>}
            </div>

            <label style={{ display: 'block', marginTop: 8 }}>허브</label>
            <select value={hub} onChange={(e) => void pickHub(e.target.value)} style={selStyle}>
              <option value="">선택…</option>
              {hubs.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>

            {projects.length > 0 && (
              <>
                <label style={{ display: 'block', marginTop: 8 }}>프로젝트</label>
                <select value={project} onChange={(e) => void pickProject(e.target.value)} style={selStyle}>
                  <option value="">선택…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            {project && (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
                📁 {folderPath.length ? folderPath.map((f) => f.name).join(' / ') : '최상위'}
              </div>
            )}

            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0' }}>
              {folders.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => void openFolder(f, folderPath.length)}
                    style={rowStyle}
                  >
                    📂 {f.name}
                  </button>
                </li>
              ))}
              {items.map((it) => (
                <li key={it.id}>
                  <button onClick={() => pickItem(it)} style={{ ...rowStyle, opacity: it.urn ? 1 : 0.5 }}>
                    🧱 {it.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div ref={containerRef} style={{ position: 'relative', flex: 1 }} />
      </div>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  borderRadius: 6,
  marginTop: 2,
  background: '#111827',
  color: '#e5e7eb',
  border: '1px solid #374151',
};
const rowStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 6px',
  background: 'transparent',
  color: '#e5e7eb',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 4,
};
