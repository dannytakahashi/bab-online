/**
 * Modal component for overlays and dialogs.
 */

/**
 * Create a modal overlay.
 *
 * @param {Object} options - Modal options
 * @param {string} options.id - Modal ID
 * @param {string} options.className - Additional CSS class
 * @param {boolean} options.closeOnBackdrop - Close when clicking backdrop
 * @param {Function} options.onClose - Close callback
 * @returns {Object} { container, content, close }
 */
export function createModal({
  id = 'modal',
  className = '',
  closeOnBackdrop = true,
  onClose = null,
} = {}) {
  // Backdrop/container
  const container = document.createElement('div');
  container.id = id;
  container.className = `modal-backdrop ${className}`.trim();
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;

  // Content wrapper
  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.cssText = `
    background: #1a1a2e;
    border-radius: 12px;
    padding: 24px;
    min-width: 300px;
    max-width: 90vw;
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `;

  container.appendChild(content);

  // Close function
  const close = () => {
    container.remove();
    if (onClose) onClose();
  };

  // Close on backdrop click
  if (closeOnBackdrop) {
    container.addEventListener('click', (e) => {
      if (e.target === container) {
        close();
      }
    });
  }

  // Close on Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  return { container, content, close };
}

/**
 * Show a confirmation dialog.
 *
 * @param {string} message - Confirmation message
 * @param {Object} options - Dialog options
 * @returns {Promise<boolean>} True if confirmed
 */
export function confirm(message, { title = 'Confirm', confirmText = 'OK', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let resolved = false;

    const { container, content, close } = createModal({
      id: 'confirm-modal',
      closeOnBackdrop: false,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      },
    });

    content.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #fff;">${title}</h3>
      <p style="margin: 0 0 24px 0; color: #ccc;">${message}</p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="cancel-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #444; color: #fff; cursor: pointer;">${cancelText}</button>
        <button id="confirm-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #23782d; color: #fff; cursor: pointer;">${confirmText}</button>
      </div>
    `;

    content.querySelector('#cancel-btn').onclick = () => {
      resolved = true;
      resolve(false);
      close();
    };

    content.querySelector('#confirm-btn').onclick = () => {
      resolved = true;
      resolve(true);
      close();
    };

    document.body.appendChild(container);
    content.querySelector('#confirm-btn').focus();
  });
}

/**
 * Show an alert dialog.
 *
 * @param {string} message - Alert message
 * @param {Object} options - Dialog options
 * @returns {Promise<void>}
 */
export function alert(message, { title = 'Notice', buttonText = 'OK' } = {}) {
  return new Promise((resolve) => {
    const { container, content, close } = createModal({
      id: 'alert-modal',
      onClose: resolve,
    });

    content.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #fff;">${title}</h3>
      <p style="margin: 0 0 24px 0; color: #ccc;">${message}</p>
      <div style="display: flex; justify-content: flex-end;">
        <button id="ok-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #23782d; color: #fff; cursor: pointer;">${buttonText}</button>
      </div>
    `;

    content.querySelector('#ok-btn').onclick = () => {
      close();
      resolve();
    };

    document.body.appendChild(container);
    content.querySelector('#ok-btn').focus();
  });
}
