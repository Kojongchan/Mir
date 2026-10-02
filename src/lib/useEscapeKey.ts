import { useEffect, useRef } from 'react';

/** Close a dialog with the Escape key while `active` (latest handler is used without re-subscribing). */
export function useEscapeKey(onEscape: () => void, active = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handler.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
