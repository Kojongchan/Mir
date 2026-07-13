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
  | 'logout'
  // 협업·이슈에서 쓰는 범용 아이콘(이모지 대체) — 도메인 정체성이 없는 조작/객체 계열.
  | 'list'
  | 'columns'
  | 'pin'
  | 'search'
  | 'download'
  | 'settings'
  | 'edit'
  | 'bookmark'
  | 'file-text'
  | 'printer'
  | 'eye'
  | 'user'
  | 'clipboard'
  | 'cube'
  | 'ruler';

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
        <symbol id="ui-list" viewBox="0 0 24 24">
          <path d="M8 6H20 M8 12H20 M8 18H20 M4 6H4.01 M4 12H4.01 M4 18H4.01" />
        </symbol>
        <symbol id="ui-columns" viewBox="0 0 24 24">
          <path d="M5 5H9V19H5V5Z M10.5 5H14.5V19H10.5V5Z M16 5H20V19H16V5Z" />
        </symbol>
        <symbol id="ui-pin" viewBox="0 0 24 24">
          <path d="M12 22C12 22 5 15 5 9.5A7 7 0 0 1 19 9.5C19 15 12 22 12 22Z" />
          <circle cx="12" cy="9.5" r="2.4" />
        </symbol>
        <symbol id="ui-search" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20 20L16 16" />
        </symbol>
        <symbol id="ui-download" viewBox="0 0 24 24">
          <path d="M12 4V15 M7 10.5L12 15.5L17 10.5 M5 20H19" />
        </symbol>
        <symbol id="ui-settings" viewBox="0 0 24 24">
          <path d="M4 7H13 M17 7H20 M4 17H7 M11 17H20" />
          <circle cx="15" cy="7" r="2.2" />
          <circle cx="9" cy="17" r="2.2" />
        </symbol>
        <symbol id="ui-edit" viewBox="0 0 24 24">
          <path d="M5 19H9L19 9L15 5L5 15V19Z M13 7L17 11" />
        </symbol>
        <symbol id="ui-bookmark" viewBox="0 0 24 24">
          <path d="M7 4H17V20L12 16L7 20V4Z" />
        </symbol>
        <symbol id="ui-file-text" viewBox="0 0 24 24">
          <path d="M6 3H14L18 7V21H6V3Z M14 3V7H18 M9 12H15 M9 16H14" />
        </symbol>
        <symbol id="ui-printer" viewBox="0 0 24 24">
          <path d="M7 8V3H17V8 M5 8H19V17H16 M8 17H16V21H8V17Z M17 11H17.01" />
        </symbol>
        <symbol id="ui-eye" viewBox="0 0 24 24">
          <path d="M2 12C2 12 6 5 12 5C18 5 22 12 22 12C22 12 18 19 12 19C6 19 2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </symbol>
        <symbol id="ui-user" viewBox="0 0 24 24">
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20C5 16.5 8 14 12 14C16 14 19 16.5 19 20" />
        </symbol>
        <symbol id="ui-clipboard" viewBox="0 0 24 24">
          <path d="M9 4H15V6H9V4Z M8 5H6V21H18V5H16 M9 11H15 M9 15H13" />
        </symbol>
        <symbol id="ui-cube" viewBox="0 0 24 24">
          <path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z M12 21V12 M12 12L20 7.5 M12 12L4 7.5" />
        </symbol>
        <symbol id="ui-ruler" viewBox="0 0 24 24">
          <path d="M4 4V20H20L4 4Z M4 9H8 M4 13H11 M4 17H15" />
        </symbol>
      </defs>
    </svg>
  );
}
