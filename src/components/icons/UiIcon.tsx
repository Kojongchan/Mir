import type { CSSProperties } from 'react';

/** Generic UI 아이콘 — SVG sprite(<use href="#ui-...">)로 단일 정의 참조.
 *  스프라이트 defs 는 <UiIconSprite/> 가 앱에 1회 마운트한다(DESIGN_SYSTEM §10.2).
 *  도메인 아이콘(브랜드 정체성)은 Icon.tsx 를 쓰고, 여기는 chevron/x/plus 등 범용만. */

export type UiIconName =
  | 'chevron-down'
  | 'chevron-left'
  | 'folder'
  | 'bell'
  | 'sun'
  | 'moon'
  | 'plus'
  | 'x'
  | 'menu'
  | 'logout';

export interface UiIconProps {
  name: UiIconName;
  size?: number;
  className?: string;
  title?: string;
}

export function UiIcon({ name, size = 18, className, title }: UiIconProps) {
  const style: CSSProperties = { display: 'inline-block', flexShrink: 0 };
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <use href={`#ui-${name}`} />
    </svg>
  );
}

/** 스프라이트 정의 — App 루트에 1회 마운트(화면 밖 숨김). */
export function UiIconSprite() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        <symbol id="ui-chevron-down" viewBox="0 0 24 24">
          <path d="M6 9L12 15L18 9" />
        </symbol>
        <symbol id="ui-chevron-left" viewBox="0 0 24 24">
          <path d="M15 6L9 12L15 18" />
        </symbol>
        <symbol id="ui-folder" viewBox="0 0 24 24">
          <path d="M3 6H9L11 8H21V19H3V6Z" />
        </symbol>
        <symbol id="ui-bell" viewBox="0 0 24 24">
          <path d="M6 9C6 5.7 8.7 3 12 3C15.3 3 18 5.7 18 9V14L20 17H4L6 14V9Z" />
          <path d="M9.5 20C9.9 21.2 10.9 22 12 22C13.1 22 14.1 21.2 14.5 20" />
        </symbol>
        <symbol id="ui-sun" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2V4 M12 20V22 M4 12H2 M22 12H20 M5 5L6.5 6.5 M17.5 17.5L19 19 M19 5L17.5 6.5 M6.5 17.5L5 19" />
        </symbol>
        <symbol id="ui-moon" viewBox="0 0 24 24">
          <path d="M20 14.5A8 8 0 019.5 4A7 7 0 1020 14.5Z" />
        </symbol>
        <symbol id="ui-plus" viewBox="0 0 24 24">
          <path d="M12 5V19 M5 12H19" />
        </symbol>
        <symbol id="ui-x" viewBox="0 0 24 24">
          <path d="M6 6L18 18 M18 6L6 18" />
        </symbol>
        <symbol id="ui-menu" viewBox="0 0 24 24">
          <path d="M4 6H20 M4 12H20 M4 18H20" />
        </symbol>
        <symbol id="ui-logout" viewBox="0 0 24 24">
          <path d="M15 4H19V20H15 M10 8L14 12L10 16 M14 12H4" />
        </symbol>
      </defs>
    </svg>
  );
}
