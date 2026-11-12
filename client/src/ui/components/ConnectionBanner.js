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
 *
 * Server restart (serverShutdown, V1_REMOVALS #17 kept, owner 2026-11-11):
 * `noteServerRestart()` shows the calm restart text at once (the server
 * closes every socket about 1 s later) and keeps it, in place of the
 * generic lost / reconnecting text, until the socket is connected again.
 * The same slot and live region: never a second banner.
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
  // serverShutdown: a deploy restarts the server; the page reconnects by itself
  restarting: "BAB Online is restarting for an update. You'll reconnect in a moment.",
};

// The restart text goes if the socket never dropped after the notice (a
// shutdown that did not happen): it would stay true-looking forever
export const RESTART_STALE_MS = 30000;
const RESTART_CLASS = 'is-restart';

// Socket.IO's disconnect reason when the server called socket.disconnect()
export const SERVER_DISCONNECT_REASON = 'io server disconnect';

/**
 * @param {import('../../socket/SocketManager.js').SocketManager} socketManager
 * @param {Object} [options]
 * @param {Document} [options.doc]
 * @param {number} [options.showDelayMs]
 * @param {number} [options.restartStaleMs]
 * @returns {{ element: HTMLElement, destroy: Function, isVisible: Function, noteServerRestart: Function, isRestarting: Function }}
 */
export function installConnectionBanner(socketManager, { doc = document, showDelayMs = SHOW_DELAY_MS, restartStaleMs = RESTART_STALE_MS } = {}) {
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
  // serverShutdown came and the socket has not been connected since
  let restarting = false;
  let staleTimer = null;

  const show = (text) => {
    // The same text again (every reconnect attempt) is not re-announced
    if (element.textContent !== text) element.textContent = text;
    element.classList.toggle(RESTART_CLASS, text === BANNER_TEXT.restarting);
    element.classList.add('visible');
  };

  const endRestart = () => {
    restarting = false;
    clearTimeout(staleTimer);
    staleTimer = null;
  };

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    pendingText = null;
    element.classList.remove('visible', RESTART_CLASS);
    element.textContent = '';
  };

  const isVisible = () => element.classList.contains('visible');

  // Show after the delay, or update the text at once if already showing
  const showSoon = (text) => {
    if (isVisible()) {
      if (element.textContent !== text) show(text);
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
      endRestart();
      showNow(BANNER_TEXT.failed);
      return;
    }
    // Follows the DISCONNECTED stateChanged: no reconnect is coming, so the
    // 'Reconnecting…' text queued for it would never be true
    if (event === 'disconnect') {
      // (a restart closes the transport instead: Socket.IO reconnects)
      if (data.reason === SERVER_DISCONNECT_REASON) {
        endRestart();
        showNow(BANNER_TEXT.ended);
      } else if (restarting) {
        // The socket dropped as announced: the clock no longer matters
        clearTimeout(staleTimer);
        staleTimer = null;
      }
      return;
    }
    if (event !== 'stateChanged') return;
    switch (data.newState) {
      case CONNECTION_STATE.CONNECTED:
        everConnected = true;
        endRestart();
        hide();
        break;
      case CONNECTION_STATE.RECONNECTING:
        if (restarting) showNow(BANNER_TEXT.restarting);
        else showSoon(everConnected ? BANNER_TEXT.reconnecting : BANNER_TEXT.unreachable);
        break;
      case CONNECTION_STATE.DISCONNECTED:
        if (restarting) showNow(BANNER_TEXT.restarting);
        else if (everConnected) showSoon(BANNER_TEXT.lost);
        break;
      default:
        break;
    }
  };

  const unsubscribe = socketManager.onStateChange(onState);

  /** serverShutdown: the restart text now, until the socket is back. */
  const noteServerRestart = () => {
    restarting = true;
    showNow(BANNER_TEXT.restarting);
    clearTimeout(staleTimer);
    staleTimer = null;
    if (socketManager.isConnected) {
      staleTimer = setTimeout(() => {
        staleTimer = null;
        if (!restarting || !socketManager.isConnected) return;
        endRestart();
        hide();
      }, restartStaleMs);
    }
  };

  return {
    element,
    isVisible,
    noteServerRestart,
    isRestarting: () => restarting,
    destroy() {
      unsubscribe();
      endRestart();
      hide();
      element.remove();
    },
  };
}
