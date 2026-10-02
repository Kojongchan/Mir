import { useEffect } from 'react';

const APP = 'MIR SMART';

/** Browser tab title "<parts joined by ·> — MIR SMART", so several open tabs stay distinguishable. */
export function useDocumentTitle(...parts: (string | null | undefined | false)[]) {
  const title = parts.filter(Boolean).join(' · ');
  useEffect(() => {
    if (!title) return; // nothing to say yet (or an embedded page): leave the current title
    document.title = `${title} — ${APP}`;
    return () => { document.title = APP; }; // routes without a title must not inherit a stale one
  }, [title]);
}
