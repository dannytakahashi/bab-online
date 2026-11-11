/**
 * Toast notifications: the page's one toast queue (ui/kit/toast.js; its
 * look is .kit-toast in styles/kit.css). main.js's error toasts go
 * through here too, so two toasts never stack on top of each other.
 */
import { toast, TOAST_DURATION } from '../kit/toast.js';

/**
 * Show a toast notification (queued behind the one on screen; a toast of
 * the same type replaces it).
 *
 * @param {string} message - Toast message
 * @param {Object} options - Toast options
 * @param {string} options.type - 'info' | 'success' | 'error' | 'warning'
 * @param {number} options.duration - Display duration in ms
 * @returns {HTMLElement}
 */
export function showToast(message, { type = 'info', duration = TOAST_DURATION } = {}) {
  return toast(message, { type, duration });
}

/** Show an error toast. */
export function showError(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'error', duration });
}

/** Show a success toast. */
export function showSuccess(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'success', duration });
}

/** Show a warning toast. */
export function showWarning(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'warning', duration });
}

/** Show an info toast. */
export function showInfo(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'info', duration });
}
