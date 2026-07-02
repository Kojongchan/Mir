import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { BrandLogo } from '../components/BrandLogo';
import { ThemeToggle } from '../components/ThemeToggle';
import { ProjectNav } from '../components/ProjectNav';
import { NotificationBell } from '../components/NotificationBell';
import { BottomTabBar } from '../components/BottomTabBar';
import { UiIcon } from '../components/icons/UiIcon';
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
  const { signOut, profile } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(RAIL_KEY) === '1',
  );

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

  const displayName = profile?.full_name ?? profile?.username ?? '사용자';
  const initial = displayName.trim().charAt(0) || '·';

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
          onClick={() => navigate('/')}
          title="프로젝트 변경"
        >
          <UiIcon name="folder" size={16} />
          <span className="project-switcher__name">{project?.name ?? '…'}</span>
          {project?.code && <span className="project-switcher__code">{project.code}</span>}
          <UiIcon name="chevron-down" size={16} />
        </button>

        <div className="spacer" />

        <NotificationBell />
        <ThemeToggle />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={signOut}
          aria-label="로그아웃"
          title="로그아웃"
        >
          <UiIcon name="logout" />
        </button>
        <span className="topbar-user" title={displayName}>
          <span className="avatar" aria-hidden>{initial}</span>
          <span className="topbar-user__name">{displayName}</span>
        </span>
      </header>

      <div className="portal-body" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
        <ProjectNav />
        <main className="portal-main">
          <Outlet context={{ project }} />
        </main>
      </div>

      <BottomTabBar />
    </div>
  );
}
