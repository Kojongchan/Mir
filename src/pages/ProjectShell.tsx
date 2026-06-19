import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { BrandLogo } from '../components/BrandLogo';
import { ThemeToggle } from '../components/ThemeToggle';
import { ProjectNav } from '../components/ProjectNav';
import { getProject, type Project } from '../lib/api';

/**
 * Portal layout for a project: top chrome + left module rail + routed content
 * (사업개요 / 공사일보 …). Heavy full-screen tools (3D viewer, 자료 관리) are
 * separate routes the rail links out to.
 */
export function ProjectShell() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    getProject(projectId).then(setProject);
  }, [projectId]);

  return (
    <div className="portal">
      <header className="topbar">
        <span className="brand"><BrandLogo size="sm" /></span>
        <span className="project-title">{project?.name ?? '…'}</span>
        {project?.code && <span className="project-code">{project.code}</span>}
        <div className="spacer" />
        <ThemeToggle />
        <button onClick={() => navigate('/')}>프로젝트 변경</button>
        <button onClick={signOut}>로그아웃</button>
      </header>

      <div className="portal-body">
        <ProjectNav />
        <main className="portal-main">
          <Outlet context={{ project }} />
        </main>
      </div>
    </div>
  );
}
