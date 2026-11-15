/**
 * Web storage that never throws. With site data blocked (a browser setting,
 * some embedded or private windows), reading `window.sessionStorage` itself
 * throws a SecurityError, and a full quota makes setItem throw: either one
 * at module load used to leave a blank page. These wrappers try the real
 * storage on every call (so tests and other code that use it directly see
 * the same values) and keep what it would not take in memory, for this page
 * only: a tab with storage blocked still signs in and plays, it just does
 * not survive a reload.
 *
 * Use these wherever the app touches storage outside a try/catch. The boot
 * entry (src/boot/) keeps its own few lines: it may share no module with the
 * app chunk (vite.config.js).
 */

function wrap(getReal) {
  const memory = new Map();
  const real = () => {
    try {
      return getReal() || null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      const k = String(key);
      if (memory.has(k)) return memory.get(k);
      try {
        return real()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      const k = String(key);
      const v = String(value);
      try {
        const s = real();
        if (s) {
          s.setItem(k, v);
          memory.delete(k);
          return;
        }
      } catch { /* blocked or full: memory below */ }
      memory.set(k, v);
    },
    removeItem(key) {
      const k = String(key);
      memory.delete(k);
      try { real()?.removeItem(k); } catch { /* nothing stored there */ }
    },
    clear() {
      memory.clear();
      try { real()?.clear(); } catch { /* nothing stored there */ }
    },
    /** Tests: drop what memory holds. */
    _forget() {
      memory.clear();
    },
    /** Whether the real storage answered (false: this page's memory only). */
    get persistent() {
      try {
        const s = real();
        if (!s) return false;
        s.getItem('bab.storageProbe');
        return true;
      } catch {
        return false;
      }
    },
  };
}

const session = wrap(() => globalThis.sessionStorage);
const local = wrap(() => globalThis.localStorage);

/** The tab's sessionStorage, or this page's memory where it throws. */
export function safeSessionStorage() {
  return session;
}

/** The device's localStorage, or this page's memory where it throws. */
export function safeLocalStorage() {
  return local;
}
