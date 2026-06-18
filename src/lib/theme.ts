// 테마 토글 (라이트 기본 · 다크 보존). <html data-theme="..."> 로 토큰을 전환하고
// 선택을 localStorage 에 기억한다. 기능 변경 없이 표현만 — S8 원칙.

export type Theme = 'light' | 'dark';

const KEY = 'mir.theme';

export function getStoredTheme(): Theme {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  localStorage.setItem(KEY, theme);
}

/** 앱 시작 시 1회 호출 — 저장된 테마(기본 light)를 적용. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
