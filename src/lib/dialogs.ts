import { useSyncExternalStore } from 'react';
import { errMessage } from './errors';

/**
 * In-app replacements for window.alert/confirm/prompt (rendered by <DialogHost/>).
 * Native dialogs block the page, cannot be styled or themed, show the site URL as their
 * title, and some browsers offer to suppress them after a few. These return promises instead.
 */

export interface DialogField {
  key: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  type?: 'text' | 'password';
}

interface DialogBase {
  id: number;
  title?: string;
  message?: string;
  confirmLabel?: string;
  /** Destructive action: red confirm button. */
  danger?: boolean;
}
export type DialogRequest =
  | (DialogBase & { kind: 'confirm'; resolve: (ok: boolean) => void })
  | (DialogBase & {
      kind: 'form';
      fields: DialogField[];
      /** Return an error message to keep the dialog open. */
      validate?: (values: Record<string, string>) => string | null;
      resolve: (values: Record<string, string> | null) => void;
    });

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface Toast { id: number; kind: ToastKind; message: string }

let seq = 0;
let state: { dialogs: DialogRequest[]; toasts: Toast[] } = { dialogs: [], toasts: [] };
const listeners = new Set<() => void>();
const emit = (next: typeof state) => { state = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useDialogState() {
  return useSyncExternalStore(subscribe, () => state);
}

/** Settle and remove a dialog (DialogHost calls this). */
export function closeDialog(id: number, settle: () => void) {
  emit({ ...state, dialogs: state.dialogs.filter((d) => d.id !== id) });
  settle();
}

export function confirmDialog(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    emit({ ...state, dialogs: [...state.dialogs, { id: ++seq, kind: 'confirm', message, ...opts, resolve }] });
  });
}

/** Several inputs in one dialog (e.g. project name + code); null when cancelled. */
export function formDialog(opts: {
  title?: string;
  message?: string;
  fields: DialogField[];
  confirmLabel?: string;
  validate?: (values: Record<string, string>) => string | null;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    emit({ ...state, dialogs: [...state.dialogs, { id: ++seq, kind: 'form', ...opts, resolve }] });
  });
}

/** Single input; null when cancelled (like window.prompt). */
export async function promptDialog(message: string, defaultValue = '', opts: {
  title?: string;
  placeholder?: string;
  confirmLabel?: string;
  type?: 'text' | 'password';
  validate?: (value: string) => string | null;
} = {}): Promise<string | null> {
  const { validate, type, placeholder, ...rest } = opts;
  const values = await formDialog({
    ...rest,
    message,
    fields: [{ key: 'value', defaultValue, placeholder, type }],
    validate: validate && ((v) => validate(v.value)),
  });
  return values ? values.value : null;
}

/** Same minimum the account API enforces, checked before the request. */
export const passwordRule = (pw: string) => (pw.length >= 6 ? null : '비밀번호는 6자 이상이어야 합니다.');

const TOAST_MS: Record<ToastKind, number> = { info: 4000, success: 4000, warning: 6000, error: 8000 };

/** Non-blocking notice in the corner; errors stay longer. Click to dismiss. */
export function toast(message: string, kind: ToastKind = 'info') {
  const id = ++seq;
  emit({ ...state, toasts: [...state.toasts.slice(-4), { id, kind, message }] });
  setTimeout(() => dismissToast(id), TOAST_MS[kind]);
}

/** `${action}: <reason>` error toast, for catch blocks. */
export function toastError(action: string, e: unknown) {
  toast(`${action}: ${errMessage(e)}`, 'error');
}

export function dismissToast(id: number) {
  if (state.toasts.some((t) => t.id === id)) emit({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
}
