/**
 * A restore that fails for a passing reason (restoreSessionResponse
 * `retryable: true`, 2026-11-15: a database error, a name an admin action
 * holds for a moment) keeps the saved token and the screen: the banner says
 * "Reconnecting…" and restoreSession goes out again on the same socket
 * after 1 s, 2 s, 4 s ... (at most 30 s). Any other failure signs out as
 * before. Also: the one-time passwordReset notice on a restore / sign-in.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, mainRoomPayload } from '../testing/fakePage.js';
import { BANNER_ID, BANNER_TEXT } from '../ui/components/ConnectionBanner.js';
import { clearToasts } from '../ui/kit/toast.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const DB_ERROR = { success: false, message: 'Database error. Try again.', retryable: true };
const LOCKED = { success: false, message: 'This account is being updated. Please try again in a minute.', retryable: true };

let page;
let socket;
let n = 1;
let errors;
const nextId = () => `sock-${++n}`;
const banner = () => document.getElementById(BANNER_ID);
const toastTexts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
  clearToasts();
  vi.useFakeTimers();
  sessionStorage.setItem('username', 'me');
  sessionStorage.setItem('sessionToken', 'tok-me');
  socket.clearEmits();
  socket.reconnect(nextId());
});

afterEach(() => {
  // settle on a restored session, so the next test starts clean
  socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

describe('retryable restore failures', () => {
  it('keeps the token and the screen, shows Reconnecting…, retries after 1, 2, 4 s; a success clears it', () => {
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
    socket.clearEmits();
    const screen = page.session.screen;
    socket.fire('restoreSessionResponse', DB_ERROR);
    expect(sessionStorage.getItem('sessionToken')).toBe('tok-me');
    expect(page.session.credentials()).toEqual({ username: 'me', sessionToken: 'tok-me' });
    expect(page.session.screen).toBe(screen);
    expect(document.getElementById('signInContainer')).toBeNull();
    expect(banner().classList.contains('visible')).toBe(true);
    expect(banner().textContent).toBe(BANNER_TEXT.restoring);
    expect(toastTexts()).toEqual([]); // nothing to act on: no toast

    vi.advanceTimersByTime(999);
    expect(socket.emitted('restoreSession')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('restoreSessionResponse', LOCKED);
    vi.advanceTimersByTime(1999);
    expect(socket.emitted('restoreSession')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.emitted('restoreSession')).toHaveLength(2);
    socket.fire('restoreSessionResponse', DB_ERROR);
    vi.advanceTimersByTime(4000);
    expect(socket.emitted('restoreSession')).toHaveLength(3);

    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(banner().classList.contains('visible')).toBe(false);
    expect(socket.emitted('joinMainRoom').length).toBeGreaterThan(0);
    vi.advanceTimersByTime(60000);
    expect(socket.emitted('restoreSession')).toHaveLength(3);
  });

  it('backs off to 30 s at most (within the server\'s 10 a minute)', () => {
    socket.clearEmits();
    const gaps = [];
    for (let i = 0; i < 8; i++) {
      socket.fire('restoreSessionResponse', DB_ERROR);
      let waited = 0;
      while (socket.emitted('restoreSession').length === i) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('a new socket meanwhile restores by itself; the old socket\'s retry does not send a second one', () => {
    socket.fire('restoreSessionResponse', DB_ERROR);
    socket.reconnect(nextId());
    socket.clearEmits();
    // the new connect already sent its own (resume); the pending retry is for the old socket
    vi.advanceTimersByTime(1000);
    expect(socket.emitted('restoreSession')).toEqual([]);
  });

  it('a failure without retryable signs out as before: token gone, sign-in screen', () => {
    socket.fire('restoreSessionResponse', DB_ERROR);
    socket.fire('restoreSessionResponse', { success: false, message: 'Invalid session token' });
    expect(sessionStorage.getItem('sessionToken')).toBeNull();
    expect(page.session.screen).toBe('signIn');
    expect(banner().classList.contains('visible')).toBe(false);
    socket.clearEmits();
    vi.advanceTimersByTime(60000);
    expect(socket.emitted('restoreSession')).toEqual([]);
  });
});

describe('the passwordReset notice', () => {
  it('a restore with passwordReset shows one info line', () => {
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [], passwordReset: { by: 'admin', at: '2026-11-14T09:30:00.000Z' } });
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(toastTexts().filter((t) => /An admin set a new password for your account on .+\. If you didn't ask for that, tell an admin\./.test(t))).toHaveLength(1);
  });

  it('a sign-in with passwordReset by link shows it; one without shows nothing', () => {
    socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [], passwordReset: { by: 'link', at: '2026-11-14T09:30:00.000Z' } });
    expect(toastTexts().filter((t) => /^Your password was reset with a reset link on /.test(t))).toHaveLength(1);
    clearToasts();
    socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
    expect(toastTexts().filter((t) => /password/i.test(t))).toEqual([]);
  });
});
