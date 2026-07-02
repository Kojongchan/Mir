// 테마 토글 (라이트/다크). <html data-theme="..."> 로 토큰을 전환하고 선택을
// localStorage 에 기억한다. 저장값이 없으면 시스템 선호(prefers-color-scheme)를 초기값으로
// 반영한다(U4). 기능 변경 없이 표현만 — S8 원칙.

export type Theme = 'light' | 'dark';

const KEY = 'mir.theme';

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 저장된 테마 — 없으면 시스템 선호로 결정. */
export function getStoredTheme(): Theme {
  const v = localStorage.getItem(KEY);
  if (v === 'dark' || v === 'light') return v;
  return prefersDark() ? 'dark' : 'light';
}

/** 사용자가 명시적으로 고른 값이 있는지(없으면 시스템 추종). */
function hasExplicitChoice(): boolean {
  const v = localStorage.getItem(KEY);
  return v === 'dark' || v === 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  localStorage.setItem(KEY, theme);
}

/** 앱 시작 시 1회 호출 — 저장된 테마(없으면 시스템 선호)를 적용하고, 명시적 선택이
 *  없는 동안에는 시스템 테마 변경을 실시간 반영한다. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
  if (window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener?.('change', (e) => {
      if (!hasExplicitChoice()) applyTheme(e.matches ? 'dark' : 'light');
    });
  }
}
