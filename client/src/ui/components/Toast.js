/**
 * Toast notification component.
 */

const TOAST_DURATION = 5000;

/**
 * Show a toast notification.
 *
 * @param {string} message - Toast message
 * @param {Object} options - Toast options
 * @param {string} options.type - 'info' | 'success' | 'error' | 'warning'
 * @param {number} options.duration - Display duration in ms
 * @param {string} options.position - 'top' | 'bottom'
 */
export function showToast(message, {
  type = 'info',
  duration = TOAST_DURATION,
  position = 'bottom',
} = {}) {
  // Remove existing toast of same type
  const existing = document.querySelector(`.toast.toast-${type}`);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const colors = {
    info: '#2196F3',
    success: '#4CAF50',
    error: '#f44336',
    warning: '#ff9800',
  };

  toast.style.cssText = `
    position: fixed;
    ${position}: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${colors[type] || colors.info};
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 9999;
    animation: toastSlideIn 0.3s ease-out;
  `;

  toast.textContent = message;
  document.body.appendChild(toast);

  // Add animation keyframes if not present
  if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      @keyframes toastSlideIn {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(${position === 'bottom' ? '20px' : '-20px'});
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
      @keyframes toastFadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-remove
  setTimeout(() => {
    toast.style.animation = 'toastFadeOut 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, duration);

  return toast;
}

/**
 * Show an error toast.
 */
export function showError(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'error', duration });
}

/**
 * Show a success toast.
 */
export function showSuccess(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'success', duration });
}

/**
 * Show a warning toast.
 */
export function showWarning(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'warning', duration });
}

/**
 * Show an info toast.
 */
export function showInfo(message, duration = TOAST_DURATION) {
  return showToast(message, { type: 'info', duration });
}
