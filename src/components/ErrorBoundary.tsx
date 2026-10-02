import { Component, type ErrorInfo, type ReactNode } from 'react';

/** After a new deploy, an open tab may request code chunks that no longer exist. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \S+ failed/i.test(message);
}

const RELOAD_KEY = 'mir:chunk-reload-at';

/** Reload once for a stale-chunk error; never loop (one reload per minute at most). */
function reloadForNewDeploy(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* storage blocked: still try a single reload */ }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
  /** Changing this value (e.g. the route path) clears a previous error. */
  resetKey?: unknown;
  /** Compact fallback for use inside the project shell. */
  compact?: boolean;
}
interface State { error: Error | null }

/**
 * Keeps one failing screen from blanking the whole app. Inside the project shell the left menu
 * stays usable; navigating elsewhere clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error) && reloadForNewDeploy()) return;
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkLoadError(error);
    return (
      <div className={`empty-state${this.props.compact ? ' empty-state--compact' : ''}`} role="alert">
        <p className="empty-state__title">
          {stale ? '새 버전이 배포되었습니다. 새로고침이 필요합니다.' : '이 화면을 표시하는 중 문제가 발생했습니다.'}
        </p>
        {!stale && <p className="empty-state__desc">다른 메뉴는 계속 사용할 수 있습니다. 문제가 반복되면 관리자에게 알려주세요.</p>}
        <div className="empty-state__cta" style={{ display: 'flex', gap: 8 }}>
          {!stale && <button className="btn" onClick={() => this.setState({ error: null })}>다시 시도</button>}
          <button className="btn btn--primary" onClick={() => window.location.reload()}>새로고침</button>
        </div>
      </div>
    );
  }
}
