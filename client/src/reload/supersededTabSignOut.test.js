/**
 * Sign Out in one tab while another tab of the same session is parked
 * behind the "open in another tab" notice (review 2026-11-12). Profile Sign
 * Out is client-only: it clears the device's saved session (localStorage)
 * and this tab's own copy, then reloads; the server revokes nothing. The
 * parked tab still has the session in its own sessionStorage, so "Use here"
 * (or the 'otherClosed' text inviting it) would sign the next person at a
 * shared computer in as the player who just signed out. The parked tab now
 * signs itself out when the device's saved session is gone: at once on the
 * storage event, on 'otherClosed', and on Use here (a parked tab whose
 * socket reconnected hears nothing from the server).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { NOTICE_ID } from '../ui/components/SupersededNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const SAVED = 'bab.savedSession';

let page;
let socket;
let n = 1;
let errors;
const nextId = () => `sock-${++n}`;
const notice = () => document.getElementById(NOTICE_ID);
const useHere = () => notice()?.querySelector('.superseded-notice__use');

// Node 25+ ships its own global localStorage (unusable without
// --localstorage-file) that shadows jsdom's, so provide a plain one
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
});

afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

/** Signed in (password) on a fresh socket, in the main room, then parked by another tab. */
async function signedInThenParked() {
  socket.reconnect(nextId());
  socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  expect(JSON.parse(localStorage.getItem(SAVED)).username).toBe('me');
  socket.fire('sessionSuperseded', { reason: 'newerConnection' });
  expect(page.session.isParked).toBe(true);
  expect(notice()).not.toBeNull();
  socket.clearEmits();
  socket.disconnect.mockClear();
}

/** What Profile Sign Out does to this browser's storage, seen from another tab. */
function signOutInAnotherTab({ event = true } = {}) {
  const oldValue = localStorage.getItem(SAVED);
  localStorage.removeItem(SAVED);
  if (event) window.dispatchEvent(new StorageEvent('storage', { key: SAVED, oldValue, newValue: null }));
}

function expectSignedOut() {
  expect(notice()).toBeNull();
  expect(page.session.isParked).toBe(false);
  expect(page.session.screen).toBe('signIn');
  expect(sessionStorage.getItem('username')).toBeNull();
  expect(sessionStorage.getItem('sessionToken')).toBeNull();
}

/** The parked socket is dropped for a fresh one, which restores nothing. */
async function expectFreshAnonymousSocket() {
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
  await tick(150);
  socket.reconnect(nextId());
  expect(socket.emitted('restoreSession')).toEqual([]);
  expect(socket.emitted('rejoinGame')).toEqual([]);
}

describe('Sign Out in another tab while this one is parked', () => {
  it('the storage event: this tab signs out at once, nothing restored', async () => {
    await signedInThenParked();
    signOutInAnotherTab();
    expectSignedOut();
    await expectFreshAnonymousSocket();
  });

  it("'otherClosed' after a sign-out (no storage event seen): the sign-in screen, not \"continue\"", async () => {
    await signedInThenParked();
    signOutInAnotherTab({ event: false });
    expect(notice()).not.toBeNull();
    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expectSignedOut();
    await expectFreshAnonymousSocket();
  });

  it('Use here after a sign-out (a parked tab that reconnected hears nothing): the sign-in screen', async () => {
    await signedInThenParked();
    socket.reconnect(nextId()); // a deploy: the new socket is anonymous to the server
    expect(notice().querySelector('[role="alertdialog"]').dataset.variant).toBe('reconnected');
    signOutInAnotherTab({ event: false });
    socket.clearEmits();
    socket.disconnect.mockClear();
    useHere().click();
    expectSignedOut();
    await expectFreshAnonymousSocket();
  });

  it('nothing changes for another key, a new saved session, or another account still saved', async () => {
    await signedInThenParked();
    window.dispatchEvent(new StorageEvent('storage', { key: 'bab.phoneGate.continue', oldValue: '1', newValue: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: SAVED, oldValue: null, newValue: localStorage.getItem(SAVED) }));
    expect(page.session.isParked).toBe(true);
    // another player signed in later in a third tab: this tab's session is still good
    localStorage.setItem(SAVED, JSON.stringify({ username: 'bob', sessionToken: 'tok-bob' }));
    socket.fire('sessionSuperseded', { reason: 'otherClosed' });
    expect(page.session.isParked).toBe(true);
    expect(notice().querySelector('[role="alertdialog"]').dataset.variant).toBe('otherClosed');
    expect(socket.disconnect).not.toHaveBeenCalled();
    // and Use here continues with this tab's own session
    useHere().click();
    await tick(150);
    socket.reconnect(nextId());
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.isParked).toBe(false);
    // a sign-out of the device now (this tab is live, not parked) is this tab's own business
    signOutInAnotherTab();
    expect(page.session.screen).toBe('mainRoom');
  });
});
