/**
 * The device's stats scope choice (state/statsScope.js): default human,
 * kept in localStorage, every storage failure falls back to this page's
 * choice (never a throw), stale replies recognized, quick switches
 * coalesced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getStatsScope, setStatsScope, scopePayload, isStaleScopeReply, createScopeRequester,
  STATS_SCOPE_KEY, STATS_SCOPES, _resetStatsScopeForTests,
} from './statsScope.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

const throwing = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

// Node 25+ ships its own global localStorage (unusable without
// --localstorage-file) that shadows jsdom's, so provide a plain one
beforeEach(() => {
  _resetStatsScopeForTests();
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetStatsScopeForTests();
});

describe('getStatsScope / setStatsScope', () => {
  it('defaults to human (nothing saved, or no storage at all)', () => {
    expect(getStatsScope(memoryStorage())).toBe('human');
    expect(getStatsScope(null)).toBe('human');
    expect(getStatsScope()).toBe('human');
  });

  it('remembers the choice on the device under bab.statsScope', () => {
    const storage = memoryStorage();
    expect(setStatsScope('bots', storage)).toBe(true);
    expect(storage.data).toEqual({ 'bab.statsScope': 'bots' });
    _resetStatsScopeForTests();
    expect(getStatsScope(storage)).toBe('bots');
    setStatsScope('all', storage);
    expect(getStatsScope(storage)).toBe('all');
  });

  it('uses the real localStorage by default', () => {
    setStatsScope('all');
    _resetStatsScopeForTests();
    expect(localStorage.getItem(STATS_SCOPE_KEY)).toBe('all');
    expect(getStatsScope()).toBe('all');
  });

  it('an invalid saved value is human; an invalid choice is ignored', () => {
    expect(getStatsScope(memoryStorage({ 'bab.statsScope': 'everything' }))).toBe('human');
    const storage = memoryStorage();
    expect(setStatsScope('nope', storage)).toBe(false);
    expect(setStatsScope(undefined, storage)).toBe(false);
    expect(storage.data).toEqual({});
    expect(getStatsScope(storage)).toBe('human');
  });

  it('storage that throws never throws here: the choice lives for this page', () => {
    expect(getStatsScope(throwing)).toBe('human');
    expect(setStatsScope('bots', throwing)).toBe(false);
    expect(getStatsScope(throwing)).toBe('bots');
    expect(getStatsScope(null)).toBe('bots');
  });

  it('a storage accessor that throws (blocked site data) falls back too', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    expect(getStatsScope()).toBe('human');
    expect(setStatsScope('all')).toBe(false);
    expect(getStatsScope()).toBe('all');
  });

  it('lists the three scopes in control order', () => {
    expect(STATS_SCOPES).toEqual(['human', 'bots', 'all']);
  });
});

describe('payloads and replies', () => {
  it('scopePayload carries the current choice, with extra fields', () => {
    expect(scopePayload()).toEqual({ scope: 'human' });
    setStatsScope('bots');
    expect(scopePayload()).toEqual({ scope: 'bots' });
    expect(scopePayload({ username: 'ann' })).toEqual({ username: 'ann', scope: 'bots' });
    expect(scopePayload({ username: 'ann' }, 'all')).toEqual({ username: 'ann', scope: 'all' });
  });

  it('a reply for another scope is stale; a reply without one never is', () => {
    expect(isStaleScopeReply('bots', 'human')).toBe(true);
    expect(isStaleScopeReply('human', 'human')).toBe(false);
    expect(isStaleScopeReply(undefined, 'bots')).toBe(false);
    expect(isStaleScopeReply(null, 'bots')).toBe(false);
    setStatsScope('all');
    expect(isStaleScopeReply('all')).toBe(false);
    expect(isStaleScopeReply('human')).toBe(true);
  });
});

describe('createScopeRequester', () => {
  it('coalesces quick switches into the last one', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const r = createScopeRequester(send, 200);
    r.request('bots');
    r.request('all');
    vi.advanceTimersByTime(199);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send.mock.calls).toEqual([['all']]);
    r.request('human');
    r.cancel();
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a zero delay sends at once', () => {
    const send = vi.fn();
    createScopeRequester(send, 0).request('bots');
    expect(send).toHaveBeenCalledWith('bots');
  });
});
