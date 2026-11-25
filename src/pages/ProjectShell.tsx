import { Suspense, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { firstMenuPath, isMenuOn, menuForPath, useProjectMenus } from '../lib/projectMenus';
import { BrandLogo } from '../components/BrandLogo';
import { ThemeToggle } from '../components/ThemeToggle';
import { ProjectNav } from '../components/ProjectNav';
import { NotificationBell } from '../components/NotificationBell';
import { BottomTabBar } from '../components/BottomTabBar';
import { TopUserMenu } from '../components/TopUserMenu';
import { UiIcon } from '../components/icons/UiIcon';
import { RouteFallback } from '../components/RouteFallback';
import { getProject, type Project } from '../lib/api';

const RAIL_KEY = 'mir.sidebar.collapsed';

/**
 * Portal layout for a project: top chrome + left module rail + routed content
 * (사업개요 / 공사일보 …). Heavy full-screen tools (3D viewer, 자료 관리) are
 * separate routes the rail links out to.
 *
 * U-Shell(Phase2): 사이드바를 라이트 톤으로 전환하고, TopBar 를 프로젝트 스위처 +
 * 테마 토글 + 알림 + 아바타로 재구성. 사이드바 collapse(240↔64) 토글 지원.
 */
export function ProjectShell() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(RAIL_KEY) === '1',
  );
  const location = useLocation();
  const { canManage } = useProjectRole(projectId);
  const { enabled, ready } = useProjectMenus(projectId);

  // 현장별 메뉴(0042): 꺼진 메뉴 주소(첫 화면 포함)로 들어오면 켜진 첫 메뉴로 보낸다.
  // 예: 사업개요를 끈 현장은 현장을 고르면 바로 통합모델(3D)이 열린다.
  const base = `/project/${projectId}`;
  const current = menuForPath(location.pathname.slice(base.length));
  let redirectTo: string | null = null;
  if (ready && current && !isMenuOn(enabled, current.key)) {
    const first = firstMenuPath(enabled, canManage);
    if (first !== null && first !== current.path) redirectTo = first ? `${base}/${first}` : base;
  }

  useEffect(() => {
    getProject(projectId).then(setProject);
  }, [projectId]);

  const toggleRail = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div className="portal">
      <header className="app-topbar">
        <button
          type="button"
          className="btn btn--ghost btn--sm rail-toggle"
          onClick={toggleRail}
          aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          aria-pressed={collapsed}
        >
          <UiIcon name="menu" />
        </button>
        <span className="app-topbar__brand"><BrandLogo size="sm" /></span>

        <button
          type="button"
          className="btn btn--ghost project-switcher"
          onClick={() => navigate('/', { state: { pick: true } })}
          title={project?.name ? `${project.name} — 프로젝트 변경` : '프로젝트 변경'}
        >
          <UiIcon name="folder" size={16} />
          <span className="project-switcher__name">{project?.name ?? '…'}</span>
          {project?.code && <span className="project-switcher__code">{project.code}</span>}
          <UiIcon name="chevron-down" size={16} />
        </button>

        <div className="spacer" />

        <NotificationBell />
        <ThemeToggle />
        <TopUserMenu projectId={projectId} />
      </header>

      <div className="portal-body" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
        <ProjectNav />
        <main className="portal-main">
          {redirectTo ? (
            <Navigate to={redirectTo} replace />
          ) : ready || !current ? (
            // 화면 청크를 받는 동안 상단바·메뉴는 그대로, 본문 자리만 자리표시
            <Suspense fallback={<RouteFallback />}>
              <Outlet context={{ project }} />
            </Suspense>
          ) : null}
        </main>
      </div>

      <BottomTabBar />
    </div>
  );
}
