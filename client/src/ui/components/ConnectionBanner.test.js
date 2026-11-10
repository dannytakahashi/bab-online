import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketManager } from '../../socket/SocketManager.js';
import { installConnectionBanner, BANNER_ID, BANNER_TEXT, SHOW_DELAY_MS } from './ConnectionBanner.js';

// Socket + Manager emitters with the surface SocketManager uses. Socket.IO
// v4 emits reconnect_* on the Manager (socket.io), connect/disconnect on the
// Socket
function emitter(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit: vi.fn(),
    fire(event, ...args) {
      [...(listeners.get(event) || [])].forEach((fn) => fn(...args));
    },
  };
}

function makeSocket({ connected = false } = {}) {
  const socket = emitter({ id: 'sock-1', connected, disconnect: vi.fn(), connect: vi.fn() });
  socket.io = emitter();
  return socket;
}

describe('ConnectionBanner', () => {
  let socket;
  let manager;
  let banner;
  const el = () => document.getElementById(BANNER_ID);
  const shown = () => el().classList.contains('visible');

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    socket = makeSocket({ connected: true });
    manager = new SocketManager();
    manager.initialize(socket);
    banner = installConnectionBanner(manager);
  });

  afterEach(() => {
    banner.destroy();
    vi.useRealTimers();
  });

  it('is an empty polite live region while connected', () => {
    expect(manager.isConnected).toBe(true);
    expect(el().getAttribute('role')).toBe('status');
    expect(el().getAttribute('aria-live')).toBe('polite');
    expect(shown()).toBe(false);
    expect(el().textContent).toBe('');
  });

  it('shows after the delay on a drop, reports reconnecting, and is gone on reconnect', () => {
    socket.fire('disconnect', 'transport close');
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(shown()).toBe(true);
    expect(el().textContent).toBe(BANNER_TEXT.lost);

    socket.io.fire('reconnect_attempt', 1);
    expect(el().textContent).toBe(BANNER_TEXT.reconnecting);
    socket.io.fire('reconnect_attempt', 2);
    expect(shown()).toBe(true);

    socket.fire('connect');
    expect(shown()).toBe(false);
    expect(el().textContent).toBe('');
  });

  it('never flashes for a drop shorter than the delay (iOS Safari forced reconnect)', () => {
    socket.fire('disconnect', 'io client disconnect');
    vi.advanceTimersByTime(100);
    socket.fire('connect');
    vi.advanceTimersByTime(SHOW_DELAY_MS * 3);
    expect(shown()).toBe(false);
  });

  it('a second outage shows it again', () => {
    socket.fire('disconnect', 'transport close');
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    socket.fire('connect');
    expect(shown()).toBe(false);
    socket.fire('disconnect', 'ping timeout');
    socket.io.fire('reconnect_attempt', 1);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect([shown(), el().textContent]).toEqual([true, BANNER_TEXT.reconnecting]);
  });

  it('reconnect_failed says to reload', () => {
    socket.fire('disconnect', 'transport close');
    socket.io.fire('reconnect_failed');
    expect([shown(), el().textContent]).toEqual([true, BANNER_TEXT.failed]);
  });

  it('a server-side disconnect (forceLogout) says to reload, never "Reconnecting"', () => {
    socket.fire('disconnect', 'io server disconnect');
    expect([shown(), el().textContent]).toEqual([true, BANNER_TEXT.ended]);
    vi.advanceTimersByTime(SHOW_DELAY_MS * 3);
    expect(el().textContent).toBe(BANNER_TEXT.ended);
    // A later manual connect still clears it
    socket.fire('connect');
    expect(shown()).toBe(false);
  });

  it('destroy unsubscribes and removes the element', () => {
    banner.destroy();
    expect(el()).toBeNull();
    socket.fire('disconnect', 'transport close');
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(el()).toBeNull();
    banner = installConnectionBanner(manager); // for afterEach
  });
});

describe('ConnectionBanner before the first connect', () => {
  afterEach(() => vi.useRealTimers());

  it('a page that cannot reach the server says so (reconnect attempts before any connect)', () => {
    vi.useFakeTimers();
    const socket = makeSocket({ connected: false });
    const manager = new SocketManager();
    manager.initialize(socket);
    const banner = installConnectionBanner(manager);
    expect(manager.isConnected).toBe(false);
    socket.io.fire('reconnect_attempt', 1);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(document.getElementById(BANNER_ID).textContent).toBe(BANNER_TEXT.unreachable);
    socket.fire('connect');
    expect(document.getElementById(BANNER_ID).classList.contains('visible')).toBe(false);
    banner.destroy();
  });
});
