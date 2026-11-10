/**
 * Connection banner: a pill at the top of the page while the socket is down
 * (driven by SocketManager.onStateChange). It appears only after the drop
 * has lasted SHOW_DELAY_MS, so the iOS Safari background workaround (a
 * forced disconnect/connect ~100 ms apart) never flashes it, and it goes
 * away as soon as the socket is connected again. Toasts live at the bottom
 * of the page, so the two never overlap.
 *
 * The element is a polite live region (role=status) that stays in the DOM
 * while empty, so screen readers announce the text when it appears.
 */

import { CONNECTION_STATE } from '../../socket/SocketManager.js';

export const BANNER_ID = 'connection-banner';
export const SHOW_DELAY_MS = 1000;

export const BANNER_TEXT = {
  lost: 'Connection lost. Reconnecting…',
  reconnecting: 'Reconnecting to the server…',
  unreachable: "Can't reach the server. Retrying…",
  failed: 'Connection lost. Reload the page to reconnect.',
  // The server closed the socket (forceLogout after a sign-in elsewhere,
  // or an account deletion on another device): Socket.IO never reconnects
  ended: 'Disconnected by the server. Reload the page to reconnect.',
};

// Socket.IO's disconnect reason when the server called socket.disconnect()
export const SERVER_DISCONNECT_REASON = 'io server disconnect';

/**
 * @param {import('../../socket/SocketManager.js').SocketManager} socketManager
 * @param {Object} [options]
 * @param {Document} [options.doc]
 * @param {number} [options.showDelayMs]
 * @returns {{ element: HTMLElement, destroy: Function, isVisible: Function }}
 */
export function installConnectionBanner(socketManager, { doc = document, showDelayMs = SHOW_DELAY_MS } = {}) {
  let element = doc.getElementById(BANNER_ID);
  if (!element) {
    element = doc.createElement('div');
    element.id = BANNER_ID;
    element.className = 'connection-banner';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    doc.body.appendChild(element);
  }

  let everConnected = socketManager.isConnected;
  let pendingText = null;
  let timer = null;

  const show = (text) => {
    element.textContent = text;
    element.classList.add('visible');
  };

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    pendingText = null;
    element.classList.remove('visible');
    element.textContent = '';
  };

  const isVisible = () => element.classList.contains('visible');

  // Show after the delay, or update the text at once if already showing
  const showSoon = (text) => {
    if (isVisible()) {
      if (element.textContent !== text) element.textContent = text;
      return;
    }
    pendingText = text;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pendingText) show(pendingText);
      pendingText = null;
    }, showDelayMs);
  };

  const showNow = (text) => {
    clearTimeout(timer);
    timer = null;
    pendingText = null;
    show(text);
  };

  const onState = (event, data = {}) => {
    if (event === 'reconnectFailed') {
      showNow(BANNER_TEXT.failed);
      return;
    }
    // Follows the DISCONNECTED stateChanged: no reconnect is coming, so the
    // 'Reconnecting…' text queued for it would never be true
    if (event === 'disconnect') {
      if (data.reason === SERVER_DISCONNECT_REASON) showNow(BANNER_TEXT.ended);
      return;
    }
    if (event !== 'stateChanged') return;
    switch (data.newState) {
      case CONNECTION_STATE.CONNECTED:
        everConnected = true;
        hide();
        break;
      case CONNECTION_STATE.RECONNECTING:
        showSoon(everConnected ? BANNER_TEXT.reconnecting : BANNER_TEXT.unreachable);
        break;
      case CONNECTION_STATE.DISCONNECTED:
        if (everConnected) showSoon(BANNER_TEXT.lost);
        break;
      default:
        break;
    }
  };

  const unsubscribe = socketManager.onStateChange(onState);

  return {
    element,
    isVisible,
    destroy() {
      unsubscribe();
      hide();
      element.remove();
    },
  };
}
