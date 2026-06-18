import { useState } from 'react';
import { getStoredTheme, setTheme, type Theme } from '../lib/theme';

/** 라이트/다크 테마 전환 버튼. 선택은 localStorage 에 기억된다. */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme());

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title={theme === 'dark' ? '라이트 모드로' : '다크 모드로'}
      aria-label="테마 전환"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
