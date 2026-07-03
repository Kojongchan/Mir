import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';

/** 모듈 페이지 공통 헤더 — 도메인 아이콘 + 제목 + 부제 + 우측 액션.
 *  리스트형 페이지들이 서로 구분되도록 아이콘·부제로 정체성을 부여한다. */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header__main">
        <span className="page-header__icon" aria-hidden><Icon name={icon} size={24} /></span>
        <div className="page-header__text">
          <h1 className="dash-h1" style={{ margin: 0 }}>{title}</h1>
          {subtitle && <p className="page-header__sub">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}
