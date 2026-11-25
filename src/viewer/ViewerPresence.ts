type ScreenLock = { released: boolean; release(): Promise<void>; addEventListener(type: string, listener: () => void, options?: { once: boolean }): void };
type Visibility = EventTarget & { visibilityState: string };

/** Keep a visible viewer awake. No idle timer, model mutation, reload or render loop. */
export function keepViewerPresent(doc: Visibility, win: EventTarget,
  requestLock: (() => Promise<ScreenLock>) | undefined, redraw: () => void) {
  let disposed = false, pending = false;
  let lock: ScreenLock | undefined;
  const release = () => {
    const previous = lock; lock = undefined;
    if (previous) void previous.release().catch(() => {});
  };
  const acquire = async () => {
    if (disposed || pending || !requestLock || doc.visibilityState !== 'visible' || (lock && !lock.released)) return;
    pending = true;
    try {
      const next = await requestLock();
      if (disposed || doc.visibilityState !== 'visible') { await next.release(); return; }
      lock = next;
      next.addEventListener('release', () => { if (lock === next) lock = undefined; }, { once: true });
    } catch { /* Unsupported/denied power policy never hides the viewer. */ }
    finally { pending = false; }
  };
  const resume = () => {
    if (disposed || doc.visibilityState !== 'visible') return;
    redraw(); void acquire();
  };
  const visibility = () => { if (doc.visibilityState === 'visible') resume(); else release(); };
  doc.addEventListener('visibilitychange', visibility);
  win.addEventListener('focus', resume);
  win.addEventListener('pageshow', resume);
  void acquire();
  return () => {
    disposed = true;
    doc.removeEventListener('visibilitychange', visibility);
    win.removeEventListener('focus', resume);
    win.removeEventListener('pageshow', resume);
    release();
  };
}
