import type { CSSProperties, ReactNode } from 'react';

/** MIR SMART 커스텀 도메인 아이콘 (DESIGN_SYSTEM §4 / PDF §5.2).
 *  스타일: Solid Geometric — 외곽선(stroke=currentColor) + 옅은 fill(0.12) +
 *  브랜드 레드닷(var(--color-brand-accent)). generic Lucide/emoji 대체.
 *  색은 currentColor 상속(부모 텍스트색) — nav-item 활성 시 brand 로 따라감. */

export type IconName =
  | 'dashboard'
  | 'schedule'
  | 'model-3d'
  | 'schedule-4d'
  | 'clash'
  | 'qto'
  | 'drawing'
  | 'daily-report'
  | 'weather'
  | 'subcontract'
  | 'board'
  | 'files'
  // 12개 세트 외 — 동일 톤(레드닷·currentColor)으로 채운 확장 아이콘
  | 'issue'
  | 'billing'
  | 'members'
  // 이슈 타입 아이콘(일반·RFI·하자·안전·품질) — 타입색으로 tint 되도록 레드닷 생략,
  // currentColor(칩/뱃지의 타입 fg 색) 기반. 이모지 TYPE_ICON 대체.
  | 'issue-general'
  | 'issue-rfi'
  | 'issue-punch'
  | 'issue-safety'
  | 'issue-quality';

const DOT = 'var(--color-brand-accent)';
const ON = 'var(--color-text-on-brand)'; // 레드닷 위 흰 체크

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="18" height="18" fill="currentColor" fillOpacity="0.12" />
      <rect x="3" y="3" width="18" height="18" />
      <path d="M7 15V11 M11 15V8 M15 15V13" />
      <circle cx="18" cy="6.5" r="1.4" fill={DOT} stroke="none" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" fill="currentColor" fillOpacity="0.12" />
      <rect x="3" y="5" width="18" height="16" />
      <path d="M3 10H21 M8 3V7 M16 3V7" />
      <circle cx="16" cy="15" r="1.8" fill={DOT} stroke="none" />
    </>
  ),
  'model-3d': (
    <>
      <path d="M12 2L21 7V17L12 22L3 17V7L12 2Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M12 2L21 7V17L12 22L3 17V7L12 2Z M12 22V12 M12 12L21 7 M12 12L3 7" />
      <circle cx="19" cy="5" r="1.4" fill={DOT} stroke="none" />
    </>
  ),
  'schedule-4d': (
    <>
      <path d="M4 6L12 3L20 6V14L12 17L4 14V6Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M4 6L12 3L20 6V14L12 17L4 14V6Z M12 17V10 M12 10L20 6 M12 10L4 6" />
      <circle cx="17.5" cy="18" r="3.5" fill={DOT} stroke="none" />
      <path d="M17.5 16V18L18.8 19.3" stroke={ON} strokeWidth="1.3" />
    </>
  ),
  clash: (
    <>
      <circle cx="9" cy="12" r="6" fill="currentColor" fillOpacity="0.12" />
      <circle cx="15" cy="12" r="6" fill="currentColor" fillOpacity="0.12" />
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.6" fill={DOT} stroke="none" />
    </>
  ),
  qto: (
    <>
      <path d="M4 7L12 3L20 7V17L12 21L4 17V7Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M4 7L12 3L20 7V17L12 21L4 17V7Z M12 21V12 M4 7L12 12 M20 7L12 12" />
      <rect x="14.5" y="15" width="6" height="6" fill={DOT} stroke="none" />
      <path d="M16 18H19 M17.5 16.5V19.5" stroke={ON} strokeWidth="1.3" />
    </>
  ),
  drawing: (
    <>
      <rect x="4" y="3" width="16" height="18" fill="currentColor" fillOpacity="0.12" />
      <rect x="4" y="3" width="16" height="18" />
      <path d="M7 8H17 M7 12H17 M7 16H13" strokeOpacity="0.5" />
      <circle cx="17" cy="17" r="1.5" fill={DOT} stroke="none" />
    </>
  ),
  'daily-report': (
    <>
      <path d="M6 3H15L19 7V21H6V3Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M6 3H15L19 7V21H6V3Z M15 3V7H19 M9 12H16 M9 16H14" />
      <circle cx="17" cy="17" r="2.5" fill={DOT} stroke="none" />
      <path d="M15.8 17L16.7 17.9L18.2 16.2" stroke={ON} strokeWidth="1.3" />
    </>
  ),
  weather: (
    <>
      <path
        d="M7 14C4.79 14 3 12.21 3 10C3 7.79 4.79 6 7 6C7.42 4.27 8.96 3 10.8 3C12.99 3 14.77 4.79 14.77 7C16.99 7 18.77 8.79 18.77 11C18.77 12.66 17.66 14 16 14H7Z"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path d="M7 14C4.79 14 3 12.21 3 10C3 7.79 4.79 6 7 6C7.42 4.27 8.96 3 10.8 3C12.99 3 14.77 4.79 14.77 7C16.99 7 18.77 8.79 18.77 11C18.77 12.66 17.66 14 16 14H7Z" />
      <path d="M8 18L9 21 M13 18L14 21" strokeOpacity="0.6" />
      <path d="M18 17L19.5 21" stroke={DOT} strokeWidth="2.2" />
    </>
  ),
  subcontract: (
    <>
      <path d="M5 4H15L19 8V20H5V4Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M5 4H15L19 8V20H5V4Z M15 4V8H19 M8 12H16 M8 15H14" />
      <path d="M14 18L15.5 19.5L18 17" stroke={DOT} strokeWidth="2" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="5" width="18" height="14" fill="currentColor" fillOpacity="0.12" />
      <rect x="3" y="5" width="18" height="14" />
      <path d="M7 9H17 M7 13H17 M7 16H12" strokeOpacity="0.5" />
      <circle cx="17" cy="5" r="2" fill={DOT} stroke="none" />
    </>
  ),
  files: (
    <>
      <path d="M3 6H10L12 8H21V19H3V6Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M3 6H10L12 8H21V19H3V6Z" />
      <rect x="15.5" y="11" width="4" height="2.5" fill={DOT} stroke="none" />
    </>
  ),
  // ── 확장(동일 톤) ──
  issue: (
    <>
      <path d="M4 5H20V16H10L6 20V16H4V5Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M4 5H20V16H10L6 20V16H4V5Z M8 9H16 M8 12H13" strokeOpacity="0.9" />
      <circle cx="17.5" cy="6.5" r="1.6" fill={DOT} stroke="none" />
    </>
  ),
  billing: (
    <>
      <path d="M6 3H18V21L15 19L12 21L9 19L6 21V3Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M6 3H18V21L15 19L12 21L9 19L6 21V3Z M9 8H15 M9 11H15" />
      <circle cx="15.5" cy="14.5" r="1.6" fill={DOT} stroke="none" />
    </>
  ),
  members: (
    <>
      <circle cx="9" cy="8" r="3.2" fill="currentColor" fillOpacity="0.12" />
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20C3.5 16.4 6 14 9 14C12 14 14.5 16.4 14.5 20" />
      <circle cx="17.5" cy="9" r="2.4" fill={DOT} stroke="none" />
    </>
  ),
  // ── 이슈 타입(레드닷 없이 타입색 tint) ──
  'issue-general': (
    <>
      <rect x="5" y="3" width="14" height="18" fill="currentColor" fillOpacity="0.12" />
      <rect x="5" y="3" width="14" height="18" />
      <path d="M8 8H16 M8 12H16 M8 16H13" strokeOpacity="0.85" />
    </>
  ),
  'issue-rfi': (
    <>
      <path d="M4 5H20V15H11L7 19V15H4V5Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M4 5H20V15H11L7 19V15H4V5Z" />
      <path
        d="M10 8.6C10 7.5 10.9 6.8 12 6.8C13.1 6.8 14 7.5 14 8.6C14 10 12 10 12 11.4 M12 13.1H12.01"
        strokeLinecap="round"
      />
    </>
  ),
  'issue-punch': (
    <>
      <path d="M6 4H17L14.5 8L17 12H6" fill="currentColor" fillOpacity="0.12" />
      <path d="M6 21V4 M6 4H17L14.5 8L17 12H6" />
    </>
  ),
  'issue-safety': (
    <>
      <path d="M12 4L21 19H3L12 4Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M12 4L21 19H3L12 4Z" />
      <path d="M12 10V13.5 M12 16.4H12.01" strokeLinecap="round" />
    </>
  ),
  'issue-quality': (
    <>
      <circle cx="12" cy="12" r="8.5" fill="currentColor" fillOpacity="0.12" />
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.3 12.2L11 14.9L15.7 9.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  /** 색 지정 — 미지정 시 currentColor 상속(부모 텍스트색을 따라감). */
  color?: 'brand' | 'muted' | 'danger';
  className?: string;
  title?: string;
}

const TONE: Record<NonNullable<IconProps['color']>, string> = {
  brand: 'var(--color-brand-primary)',
  muted: 'var(--color-text-tertiary)',
  danger: 'var(--color-error)',
};

export function Icon({ name, size = 20, color, className, title }: IconProps) {
  const style: CSSProperties | undefined = color ? { color: TONE[color] } : undefined;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="square"
      strokeLinejoin="miter"
      style={style}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
