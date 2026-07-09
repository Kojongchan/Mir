import { NavLink, useParams } from 'react-router-dom';
import { Icon, type IconName } from './icons/Icon';

interface Tab {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
}

/** 모바일(<640) 하단 탭바 — 주요 5메뉴(U4). 데스크톱/태블릿은 사이드바(.app-sidebar)를
 *  쓰고, <640 에서만 CSS(.app-bottom-tabbar)로 노출된다. 활성 항목 aria-current="page". */
export function BottomTabBar() {
  const { projectId = '' } = useParams();
  const base = `/project/${projectId}`;
  const tabs: Tab[] = [
    { to: base, icon: 'dashboard', label: '사업개요', end: true },
    { to: `${base}/schedule`, icon: 'schedule', label: '공정' },
    { to: `${base}/model`, icon: 'model-3d', label: '3D' },
    { to: `${base}/logs`, icon: 'daily-report', label: '일보' },
    { to: `${base}/issues`, icon: 'issue', label: '이슈' },
  ];
  return (
    <nav className="app-bottom-tabbar" aria-label="하단 탭바">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => `bottom-tab${isActive ? ' is-active' : ''}`}
        >
          <span className="bottom-tab__ico" aria-hidden>
            <Icon name={t.icon} size={22} />
          </span>
          <span className="bottom-tab__label">{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
