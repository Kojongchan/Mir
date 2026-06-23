import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { getProjectAcc, setProjectAcc } from '../lib/api';

/**
 * ACC 모델 (APS Viewer) — ACC 에 있는 모델(rvt·nwd·dwg·ifc, 텍스처 유지·SVF2)을
 * 우리 사이트에서 띄운다. 2-legged 토큰은 서버(/api/aps-token)가 발급하므로
 * **외부 사용자는 오토데스크 계정이 필요 없다**.
 *
 * 프로젝트별 ACC 고정(0020): 관리자가 허브·프로젝트를 이 MIR 프로젝트에 고정하고
 * '기본 모델'을 지정하면, 일반 사용자는 그 범위만(전체 ACC 탐색 없이) 보고 기본
 * 모델이 자동으로 열린다. 관리자는 좌측 패널에서 자유 탐색·고정·기본지정 가능.
 *
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

// 펼침 트리 노드(폴더). 자식은 펼칠 때 지연 로드한다(ACC 처럼).
type FolderNode = {
  id: string;
  name: string;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: FolderNode[];
  items: Item[];
};

const mkFolder = (id: string, name: string): FolderNode => ({
  id,
  name,
  expanded: false,
  loaded: false,
  loading: false,
  children: [],
  items: [],
});

/** id 로 트리 노드를 찾아 불변 갱신. */
function updateFolder(nodes: FolderNode[], id: string, fn: (n: FolderNode) => FolderNode): FolderNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children.length) return { ...n, children: updateFolder(n.children, id, fn) };
    return n;
  });
}

export function AccModels() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const isAdmin = !!profile?.is_admin;
  const [params] = useSearchParams();
  const urnFromUrl = params.get('urn') ?? '';
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const [urn, setUrn] = useState(urnFromUrl);
  const [status, setStatus] = useState('APS Viewer 준비…');

  // ACC 탐색 상태.
  const [showBrowser, setShowBrowser] = useState(!urnFromUrl);
  const [hubs, setHubs] = useState<Named[]>([]);
  const [hub, setHub] = useState('');
  const [projects, setProjects] = useState<Named[]>([]);
  const [project, setProject] = useState('');
  const [roots, setRoots] = useState<FolderNode[]>([]); // 펼침 트리 최상위
  const [busy, setBusy] = useState(false);

  // 프로젝트별 ACC 고정 매핑(0020). pinned = 허브·프로젝트가 고정된 상태.
  const [pinnedHubName, setPinnedHubName] = useState('');
  const [pinnedProjectName, setPinnedProjectName] = useState('');
  const [pinnedRootName, setPinnedRootName] = useState('');
  const [defaultName, setDefaultName] = useState('');
  const [openName, setOpenName] = useState('');
  const [openId, setOpenId] = useState(''); // 현재 연 파일(트리 체크 표시)
  const pinned = !!pinnedHubName && !!pinnedProjectName;

  // 좌측 트리 패널 가로폭(우측 가장자리 핸들 드래그) — 긴 파일명 대응.
  const [panelW, setPanelW] = useState(320);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const onMove = (ev: MouseEvent) =>
      setPanelW(Math.min(720, Math.max(220, startW + (ev.clientX - startX))));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

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
    setRoots([]);
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
    setRoots([]);
    if (!p) return;
    setBusy(true);
    try {
      const { folders } = await accFetch({ action: 'topFolders', hub, project: p });
      setRoots((folders as Named[]).map((f) => mkFolder(f.id, f.name)));
    } catch (e) {
      setStatus(`폴더 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 트리에서 폴더 펼치기/접기(처음 펼칠 때만 내용 지연 로드).
  const toggleFolder = async (node: FolderNode, projId?: string) => {
    const p = projId || project;
    if (node.loaded) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, expanded: !n.expanded })));
      return;
    }
    setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: true })));
    try {
      const { folders, items } = await accFetch({ action: 'contents', project: p, folder: node.id });
      setRoots((r) =>
        updateFolder(r, node.id, (n) => ({
          ...n,
          loading: false,
          loaded: true,
          expanded: true,
          children: (folders as Named[]).map((f) => mkFolder(f.id, f.name)),
          items: items as Item[],
        })),
      );
    } catch (e) {
      setRoots((r) => updateFolder(r, node.id, (n) => ({ ...n, loading: false })));
      setStatus(`폴더 열기 실패: ${(e as Error).message}`);
    }
  };

  const pickItem = (it: Item) => {
    if (!it.urn) {
      setStatus(`${it.name}: 변환된 뷰가 없습니다(ACC에서 처리 중일 수 있음).`);
      return;
    }
    setUrn(it.urn);
    setOpenName(it.name);
    setOpenId(it.id);
    void openModel(it.urn);
  };

  // 지정된 허브/프로젝트의 최상위 폴더를 트리 루트로 로드(고정 매핑 경로).
  const loadTopFolders = async (h: string, p: string) => {
    setBusy(true);
    try {
      const { folders } = await accFetch({ action: 'topFolders', hub: h, project: p });
      setRoots((folders as Named[]).map((f) => mkFolder(f.id, f.name)));
    } catch (e) {
      setStatus(`폴더 조회 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 고정된 허브/프로젝트 id → 표시용 이름 해석(+ 관리자 변경용 드롭다운 채움).
  const resolveNames = async (h: string, p: string) => {
    try {
      const { hubs } = await accFetch({ action: 'hubs' });
      setHubs(hubs);
      setPinnedHubName(hubs.find((x: Named) => x.id === h)?.name ?? h);
      const { projects } = await accFetch({ action: 'projects', hub: h });
      setProjects(projects);
      setPinnedProjectName(projects.find((x: Named) => x.id === p)?.name ?? p);
    } catch {
      setPinnedHubName(h);
      setPinnedProjectName(p);
    }
  };

  // 관리자: 현재 선택한 허브·프로젝트를 이 MIR 프로젝트에 고정.
  const pinCurrent = async () => {
    if (!hub || !project) {
      setStatus('허브·프로젝트를 먼저 선택하세요.');
      return;
    }
    try {
      await setProjectAcc(projectId, { acc_hub_id: hub, acc_project_id: project });
      setPinnedHubName(hubs.find((x) => x.id === hub)?.name ?? hub);
      setPinnedProjectName(projects.find((x) => x.id === project)?.name ?? project);
      setStatus('이 프로젝트에 ACC 허브·프로젝트를 고정했습니다.');
    } catch (e) {
      setStatus(`고정 실패: ${(e as Error).message}`);
    }
  };

  // 관리자: 특정 폴더를 '시작 폴더'로 고정(사용자는 그 안쪽만 봄).
  const pinFolder = async (node: FolderNode) => {
    try {
      await setProjectAcc(projectId, { acc_root_folder_id: node.id, acc_root_folder_name: node.name });
      setPinnedRootName(node.name);
      setStatus(`시작 폴더 고정: ${node.name}`);
    } catch (e) {
      setStatus(`폴더 고정 실패: ${(e as Error).message}`);
    }
  };

  // 관리자: 현재 연 모델을 '기본(자동 열림)' 모델로 지정.
  const setAsDefault = async () => {
    if (!urn) {
      setStatus('먼저 모델을 여세요.');
      return;
    }
    const name = openName || '기본 모델';
    try {
      await setProjectAcc(projectId, { acc_default_urn: urn, acc_default_name: name });
      setDefaultName(name);
      setStatus(`기본 모델로 지정: ${name}`);
    } catch (e) {
      setStatus(`지정 실패: ${(e as Error).message}`);
    }
  };

  // 트리 노드(폴더+하위)를 재귀 렌더. depth 로 들여쓰기.
  const renderFolder = (node: FolderNode, depth: number): React.ReactElement => (
    <li key={node.id}>
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: depth * 12 }}>
        <button onClick={() => void toggleFolder(node)} style={{ ...rowStyle, flex: 1 }}>
          <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>
            {node.loading ? '⏳' : node.expanded ? '▾' : '▸'}
          </span>
          📂 {node.name}
        </button>
        {isAdmin && (
          <button
            onClick={() => void pinFolder(node)}
            title="이 폴더를 시작 폴더로 고정"
            style={{ ...rowStyle, width: 'auto', flex: 'none', padding: '2px 6px' }}
          >
            📌
          </button>
        )}
      </div>
      {node.expanded && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {node.children.map((c) => renderFolder(c, depth + 1))}
          {node.items.map((it) => {
            const open = it.id === openId;
            return (
              <li key={it.id} style={{ paddingLeft: (depth + 1) * 12 }}>
                <button
                  onClick={() => pickItem(it)}
                  title={it.name}
                  style={{
                    ...rowStyle,
                    opacity: it.urn ? 1 : 0.5,
                    fontWeight: open ? 700 : 400,
                    color: open ? 'var(--accent)' : 'var(--text)',
                  }}
                >
                  <span style={{ display: 'inline-block', width: 14, color: 'var(--accent)' }}>
                    {open ? '✓' : ''}
                  </span>
                  🧱 {it.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );

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
        // 라이트회색 기본 배경이 앱 다크 테마와 안 맞아 어두운 그라데이션으로 통일.
        viewer.setBackgroundColor(40, 48, 64, 20, 26, 38);
        // ACC 와 동일한 휠 방향(휠 위=확대) + 커서 기준 줌.
        try {
          viewer.setReverseZoomDirection(true);
          viewer.navigation.setZoomTowardsPivot(true);
        } catch {
          /* 일부 버전 미지원 무시 */
        }
        // 패널 토글/리사이즈/창크기 변경 시 캔버스를 컨테이너에 맞춤(잘림·빈 박스 방지).
        const ro = new ResizeObserver(() => viewer.resize());
        ro.observe(containerRef.current);
        resizeObsRef.current = ro;
        viewerRef.current = viewer;

        // URL 에 urn 이 직접 오면 그걸 우선(딥링크).
        if (urnFromUrl) {
          setStatus('URN 로딩…');
          void openModel(urnFromUrl);
        } else {
          // 프로젝트별 ACC 고정 매핑을 적용.
          const acc = await getProjectAcc(projectId);
          if (cancelled) return;
          if (acc.acc_hub_id && acc.acc_project_id) {
            setHub(acc.acc_hub_id);
            setProject(acc.acc_project_id);
            setPinnedRootName(acc.acc_root_folder_name ?? '');
            void resolveNames(acc.acc_hub_id, acc.acc_project_id);
            if (acc.acc_root_folder_id) {
              // 고정된 시작 폴더를 펼쳐진 루트로(그 안쪽만 보임, ACC 내부 폴더 숨김).
              const root = mkFolder(acc.acc_root_folder_id, acc.acc_root_folder_name ?? '시작 폴더');
              setRoots([root]);
              void toggleFolder(root, acc.acc_project_id);
            } else {
              void loadTopFolders(acc.acc_hub_id, acc.acc_project_id);
            }
            if (acc.acc_default_urn) {
              // 관리자가 지정한 기본 모델 자동 오픈(트리는 그대로 둠).
              setUrn(acc.acc_default_urn);
              setOpenName(acc.acc_default_name ?? '');
              setDefaultName(acc.acc_default_name ?? '');
              setShowBrowser(true);
              void openModel(acc.acc_default_urn);
            } else {
              setShowBrowser(true);
              setStatus('폴더에서 모델을 선택하세요.');
            }
          } else if (isAdmin) {
            // 매핑 없음 + 관리자 → 전체 탐색해서 고정 가능.
            setShowBrowser(true);
            void loadHubs();
            setStatus('허브·프로젝트를 선택해 "이 프로젝트에 고정"을 누르세요.');
          } else {
            // 매핑 없음 + 일반 사용자 → 안내만.
            setShowBrowser(false);
            setStatus('관리자가 이 프로젝트의 ACC 모델을 아직 지정하지 않았습니다.');
          }
        }
      } catch (e) {
        setStatus(`초기화 오류: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      const v = viewerRef.current as any;
      if (v?.finish) v.finish();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 패널 열고/닫기·폭 변경 직후 캔버스 크기 재계산(메인뷰가 빈틈 없이 채워지게).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const v = viewerRef.current as any;
      if (v?.resize) v.resize();
    });
    return () => cancelAnimationFrame(id);
  }, [showBrowser, panelW]);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 8,
          background: 'var(--panel)',
          color: 'var(--text)',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: 13 }}>🅰 ACC 모델</strong>
        <button onClick={() => setShowBrowser((s) => !s)} style={btnStyle}>
          {showBrowser ? '◀ 폴더 닫기' : '폴더 펼치기 ▶'}
        </button>
        {defaultName && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>기본: {defaultName}</span>
        )}
        <span style={{ flex: 1 }} />
        {isAdmin && urn && (
          <button onClick={() => void setAsDefault()} style={btnStyle} title="이 모델을 자동으로 열리게 지정">
            ⭐ 기본 모델로 지정
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {status}
        </span>
      </div>
      <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
        {showBrowser && (
          <div
            style={{
              width: panelW,
              flex: 'none',
              position: 'relative',
              borderRight: '1px solid var(--border)',
              background: 'var(--panel)',
              color: 'var(--text)',
              padding: 10,
              overflowY: 'auto',
              fontSize: 13,
            }}
          >
            <div className="subtree-resizer" onMouseDown={startResize} title="좌우 폭 조절" />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <strong>{isAdmin ? 'ACC 탐색' : pinnedProjectName || 'ACC'}</strong>
              {busy && <span style={{ opacity: 0.7 }}>로딩…</span>}
            </div>

            {isAdmin ? (
              <>
                {/* 관리자: 허브·프로젝트를 자유 선택하고 이 MIR 프로젝트에 고정 */}
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
                {hub && project && (
                  <button onClick={() => void pinCurrent()} style={{ ...btnStyle, width: '100%', marginTop: 8 }}>
                    📌 이 프로젝트에 고정
                  </button>
                )}
                {pinned && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                    고정됨: {pinnedHubName} / {pinnedProjectName}
                  </div>
                )}
              </>
            ) : (
              /* 일반 사용자: 고정된 프로젝트만(드롭다운 없이) */
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                🏢 {pinnedHubName} / {pinnedProjectName}
              </div>
            )}

            {isAdmin && pinnedRootName && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                시작 폴더: {pinnedRootName} {isAdmin && '(폴더 옆 📌 로 변경)'}
              </div>
            )}

            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0' }}>
              {roots.map((n) => renderFolder(n, 0))}
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
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
};
const rowStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 6px',
  background: 'transparent',
  color: 'var(--text)',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
};
