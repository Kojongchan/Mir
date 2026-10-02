import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ModalBackdrop } from './ModalBackdrop';
import { closeDialog, dismissToast, useDialogState, type DialogRequest } from '../lib/dialogs';

/** Renders confirmDialog/promptDialog/formDialog requests and toasts. Mount once at the app root. */
export function DialogHost() {
  const { dialogs, toasts } = useDialogState();
  return createPortal(
    <>
      {dialogs.map((d) => <AppDialog key={d.id} req={d} />)}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}
            onClick={() => dismissToast(t.id)} title="클릭하면 닫힘">
            {t.message}
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}

function AppDialog({ req }: { req: DialogRequest }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    req.kind === 'form' ? Object.fromEntries(req.fields.map((f) => [f.key, f.defaultValue ?? ''])) : {});
  const [error, setError] = useState<string | null>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  // Focus like native dialogs (input text selected, else the confirm button); give focus back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (firstInput.current) { firstInput.current.focus(); firstInput.current.select(); } else confirmBtn.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);

  const cancel = () => closeDialog(req.id, () => (req.kind === 'confirm' ? req.resolve(false) : req.resolve(null)));
  const accept = () => {
    if (req.kind === 'confirm') return closeDialog(req.id, () => req.resolve(true));
    const problem = req.validate?.(values) ?? null;
    if (problem) { setError(problem); return; }
    closeDialog(req.id, () => req.resolve(values));
  };
  // Enter submits, except while a Korean IME is composing (that Enter commits the syllable).
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); accept(); }
  };

  const titleId = `app-dialog-${req.id}`;
  return (
    <ModalBackdrop className="modal-backdrop app-dialog-back" onClose={cancel}>
      <div className="modal app-dialog" role={req.kind === 'confirm' ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={req.title ? titleId : undefined} aria-label={req.title ? undefined : req.message}>
        {req.title && <div className="modal-head"><h3 id={titleId}>{req.title}</h3></div>}
        <div className="modal-body">
          {req.message && <p className="app-dialog__msg">{req.message}</p>}
          {req.kind === 'form' && req.fields.map((f, i) => (
            <label key={f.key} className="app-dialog__field">
              {f.label && <span>{f.label}</span>}
              <input ref={i === 0 ? firstInput : undefined} type={f.type ?? 'text'} value={values[f.key] ?? ''}
                placeholder={f.placeholder} autoComplete="off"
                onChange={(e) => { setValues((v) => ({ ...v, [f.key]: e.target.value })); setError(null); }}
                onKeyDown={onKeyDown} />
            </label>
          ))}
          {error && <p className="app-dialog__error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" onClick={cancel}>취소</button>
          <button ref={confirmBtn} type="button" className={req.danger ? 'danger' : 'primary'} onClick={accept}>
            {req.confirmLabel ?? '확인'}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
