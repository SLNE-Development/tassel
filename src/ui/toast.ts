import { Toast } from '@base-ui/react/toast';
import { getT } from '../i18n';

/** One manager for the whole app, so non-React code (shortcuts, actions) can raise toasts. */
export const toastManager = Toast.createToastManager();

export function notifyError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toastManager.add({ type: 'error', title: getT().toasts.failed, description: message, timeout: 7000 });
}

export function notifySuccess(title: string, description?: string): void {
  toastManager.add({ type: 'success', title, description, timeout: 3000 });
}

export function notifyInfo(title: string, description?: string): void {
  toastManager.add({ type: 'info', title, description, timeout: 3000 });
}
