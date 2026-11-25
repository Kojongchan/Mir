import { useRef, type ReactNode } from 'react';
import { useEscapeKey } from '../lib/useEscapeKey';
import { confirmDialog } from '../lib/dialogs';

/**
 * Dialog backdrop: closes on Escape or a click that both starts and ends on the backdrop.
 * A plain onClick also fired when a drag began inside the dialog (selecting input text, drawing
 * markup, dragging a movable window to the screen edge) and ended outside it, which closed the
 * dialog and discarded what was typed.
 * `confirmClose` guards these accidental paths only (explicit 취소/✕ buttons call onClose directly).
 */
export function ModalBackdrop({ onClose, confirmClose, className = 'modal-backdrop', children }: {
  onClose: () => void;
  confirmClose?: () => boolean | Promise<boolean>;
  className?: string;
  children: ReactNode;
}) {
  const pressed = useRef(false);
  const asking = useRef(false);
  const dismiss = async () => {
    if (asking.current) return;
    asking.current = true;
    try { if (!confirmClose || await confirmClose()) onClose(); } finally { asking.current = false; }
  };
  useEscapeKey(() => void dismiss());
  return (
    <div className={className}
      onPointerDown={(e) => { pressed.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const fromBackdrop = pressed.current && e.target === e.currentTarget;
        pressed.current = false;
        if (fromBackdrop) void dismiss();
      }}>
      {children}
    </div>
  );
}

/** confirmClose helper: ask only when there is unsaved input. */
export const confirmDiscard = (dirty: boolean) => async () =>
  !dirty || confirmDialog('작성 중인 내용이 저장되지 않았습니다. 닫을까요?', { confirmLabel: '닫기', danger: true });
