import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeSessionStorage, safeLocalStorage } from './safeStorage.js';
import { blockWebStorage } from '../testing/fakePage.js';

function plainStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    _m: m,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  safeSessionStorage()._forget();
  safeLocalStorage()._forget();
});

describe('safeSessionStorage / safeLocalStorage', () => {
  it('reads and writes through to the real storage', () => {
    const s = plainStorage();
    vi.stubGlobal('sessionStorage', s);
    safeSessionStorage().setItem('a', 1);
    expect(s.getItem('a')).toBe('1');
    s.setItem('b', 'x');
    expect(safeSessionStorage().getItem('b')).toBe('x');
    safeSessionStorage().removeItem('a');
    expect(s.getItem('a')).toBeNull();
    expect(safeSessionStorage().persistent).toBe(true);
  });

  it('storage whose access throws (site data blocked): this page\'s memory, never a throw', () => {
    const undo = blockWebStorage();
    try {
      expect(() => globalThis.sessionStorage).toThrow();
      for (const store of [safeSessionStorage(), safeLocalStorage()]) {
        expect(store.getItem('k')).toBeNull();
        store.setItem('k', 'v');
        expect(store.getItem('k')).toBe('v');
        store.removeItem('k');
        expect(store.getItem('k')).toBeNull();
        store.setItem('k', 'w');
        store.clear();
        expect(store.getItem('k')).toBeNull();
        expect(store.persistent).toBe(false);
      }
    } finally {
      undo();
    }
  });

  it('a setItem that throws (quota): the value is kept in memory and wins over the stale stored one', () => {
    const s = plainStorage();
    s.setItem('gameId', 'old');
    s.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    vi.stubGlobal('sessionStorage', s);
    safeSessionStorage().setItem('gameId', 'new');
    expect(safeSessionStorage().getItem('gameId')).toBe('new');
    safeSessionStorage().removeItem('gameId');
    expect(safeSessionStorage().getItem('gameId')).toBeNull();
  });

  it('a getItem that throws reads as null', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('x'); }, setItem() {}, removeItem() {} });
    expect(safeSessionStorage().getItem('a')).toBeNull();
    expect(safeSessionStorage().persistent).toBe(false);
  });
});
