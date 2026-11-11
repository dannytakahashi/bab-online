/**
 * The admin panel's wire (server/socket/adminHandlers.js): adminRequest
 * {requestId, action, args} out, adminResponse back to this socket with the
 * same requestId. The server checks the admin on every request; the flag
 * here (isAdmin, from signInResponse / restoreSessionResponse) only decides
 * whether the menu shows the Admin entry.
 */
import { CLIENT_EVENTS, SERVER_EVENTS } from '../constants/events.js';

let adminFlag = false;
const flagListeners = new Set();

/** The display flag: the main room's Admin entry. Never authority. */
export function isAdmin() {
  return adminFlag;
}

export function setIsAdmin(on) {
  const next = on === true;
  if (next === adminFlag) return;
  adminFlag = next;
  for (const fn of flagListeners) fn(adminFlag);
}

/** Subscribe to flag changes; returns the unsubscribe. */
export function onAdminChange(fn) {
  flagListeners.add(fn);
  return () => flagListeners.delete(fn);
}

export const REQUEST_TIMEOUT_MS = 15000;

/**
 * @param {Object} socket - the page's Socket.IO socket (on/off/emit)
 * @param {{timeoutMs?: number}} [options]
 * @returns {{request: (action: string, args?: Object) => Promise<Object>, dispose: Function}}
 *          request resolves with the adminResponse (ok true or false); it
 *          rejects only when no answer came (timeout, disposed)
 */
export function createAdminApi(socket, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const pending = new Map(); // requestId -> {resolve, reject, timer}
  let seq = 0;

  const onResponse = (data) => {
    const p = data && pending.get(data.requestId);
    if (!p) return;
    pending.delete(data.requestId);
    clearTimeout(p.timer);
    p.resolve(data);
  };
  socket.on(SERVER_EVENTS.ADMIN_RESPONSE, onResponse);

  function request(action, args = {}) {
    const requestId = `adm-${Date.now().toString(36)}-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      socket.emit(CLIENT_EVENTS.ADMIN_REQUEST, { requestId, action, args });
    });
  }

  function dispose() {
    socket.off(SERVER_EVENTS.ADMIN_RESPONSE, onResponse);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    pending.clear();
  }

  return { request, dispose };
}
