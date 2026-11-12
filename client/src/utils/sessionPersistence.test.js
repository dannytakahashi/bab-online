import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  rememberSession,
  forgetSession,
  adoptSavedSession,
  clearAllSessionData,
  isDeviceSignedOut,
} from './sessionPersistence.js';

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

describe('sessionPersistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a fresh tab adopts the device\'s saved session', () => {
    rememberSession('Alan', 'tok-1');
    sessionStorage.clear(); // new tab / reopened browser

    expect(adoptSavedSession()).toBe(true);
    expect(sessionStorage.getItem('username')).toBe('Alan');
    expect(sessionStorage.getItem('sessionToken')).toBe('tok-1');
  });

  it('a tab with its own session keeps it (multi-tab testing still works)', () => {
    rememberSession('Alan', 'tok-1');
    sessionStorage.setItem('username', 'Mary');
    sessionStorage.setItem('sessionToken', 'tok-m');

    expect(adoptSavedSession()).toBe(false);
    expect(sessionStorage.getItem('username')).toBe('Mary');
  });

  it('does nothing without a saved session', () => {
    expect(adoptSavedSession()).toBe(false);
    expect(sessionStorage.getItem('username')).toBeNull();
  });

  it('ignores corrupt saved data', () => {
    localStorage.setItem('bab.savedSession', '{not json');
    expect(adoptSavedSession()).toBe(false);
  });

  it('forgetSession(token) only clears a matching saved session', () => {
    rememberSession('Alan', 'tok-new');
    forgetSession('tok-old');
    sessionStorage.clear();
    expect(adoptSavedSession()).toBe(true);

    forgetSession('tok-new');
    sessionStorage.clear();
    expect(adoptSavedSession()).toBe(false);
  });

  it('clearAllSessionData signs out the tab and the device', () => {
    rememberSession('Alan', 'tok-1');
    sessionStorage.setItem('username', 'Alan');
    sessionStorage.setItem('sessionToken', 'tok-1');
    sessionStorage.setItem('gameId', 'g1');

    clearAllSessionData();

    expect(sessionStorage.getItem('username')).toBeNull();
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(adoptSavedSession()).toBe(false);
  });

  it('isDeviceSignedOut: only when storage reads and holds no saved session', () => {
    rememberSession('Alan', 'tok-1');
    expect(isDeviceSignedOut()).toBe(false);
    clearAllSessionData();
    expect(isDeviceSignedOut()).toBe(true);
    localStorage.setItem('bab.savedSession', JSON.stringify({ username: 'Alan' }));
    expect(isDeviceSignedOut()).toBe(true);
    // garbled or unreadable storage says nothing
    localStorage.setItem('bab.savedSession', '{not json');
    expect(isDeviceSignedOut()).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(isDeviceSignedOut()).toBe(false);
  });
});
