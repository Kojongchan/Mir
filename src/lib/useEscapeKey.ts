import { useEffect, useRef } from 'react';

// Open dialogs, oldest first: Escape closes only the topmost one (a markup editor over an issue detail).
const stack: { current: () => void }[] = [];
const onKey = (e: KeyboardEvent) => {
  // Korean IME: Escape during composition cancels the composition, not the dialog.
  // defaultPrevented: an inner control (mention list, dropdown) already consumed it.
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || !stack.length) return;
  e.preventDefault();
  stack[stack.length - 1].current();
};

/** Close a dialog with the Escape key while `active` (latest handler is used without re-subscribing). */
export function useEscapeKey(onEscape: () => void, active = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    if (!stack.length) window.addEventListener('keydown', onKey);
    stack.push(handler);
    return () => {
      const i = stack.lastIndexOf(handler);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) window.removeEventListener('keydown', onKey);
    };
  }, [active]);
}
