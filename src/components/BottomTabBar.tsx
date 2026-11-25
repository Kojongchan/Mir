import { NavLink, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { Icon } from './icons/Icon';
import { bottomTabs, useProjectMenus } from '../lib/projectMenus';

/** 모바일(<640) 하단 탭바 — 주요 5메뉴(U4). 데스크톱/태블릿은 사이드바(.app-sidebar)를
 *  쓰고, <640 에서만 CSS(.app-bottom-tabbar)로 노출된다. 활성 항목 aria-current="page".
 *  현장별 메뉴 설정을 따르며, 꺼진 메뉴 자리는 켜진 다른 메뉴로 채운다. */
export function BottomTabBar() {
  const { projectId = '' } = useParams();
  const { canManage } = useProjectRole(projectId);
  const { enabled, ready } = useProjectMenus(projectId);
  const base = `/project/${projectId}`;
  const tabs = ready ? bottomTabs(enabled, canManage) : [];
  return (
    <nav className="app-bottom-tabbar" aria-label="하단 탭바">
      {tabs.map((t) => (
        <NavLink
          key={t.key}
          to={t.path ? `${base}/${t.path}` : base}
          end={!t.path}
          className={({ isActive }) => `bottom-tab${isActive ? ' is-active' : ''}`}
        >
          <span className="bottom-tab__ico" aria-hidden>
            <Icon name={t.icon} size={22} />
          </span>
          <span className="bottom-tab__label">{t.short}</span>
        </NavLink>
      ))}
    </nav>
  );
}
