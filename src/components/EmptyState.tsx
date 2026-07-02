import type { ReactNode } from 'react';

/** 공통 빈 상태 표시(U1 디자인 시스템) — 아이콘 + 문구 + 선택 CTA.
 *  스타일은 index.css `.empty-state` (DESIGN_SYSTEM.md §3). */
export function EmptyState({
  icon = '📭',
  title,
  desc,
  cta,
  compact = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  cta?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' empty-state--compact' : ''}`} role="status">
      <span className="empty-state__icon" aria-hidden>
        {icon}
      </span>
      <p className="empty-state__title">{title}</p>
      {desc != null && <p className="empty-state__desc">{desc}</p>}
      {cta != null && <div className="empty-state__cta">{cta}</div>}
    </div>
  );
}
