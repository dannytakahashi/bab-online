/**
 * Client error reports (c2s clientError; server/socket/clientErrorHandlers.js).
 *
 * Production bundles drop console.log and nobody reads a player's console,
 * so an uncaught error, an unhandled rejection or a failed table step used
 * to vanish. This sends a short report instead:
 *   clientError {kind, message, stack?, where?, build?, page?}
 *
 * - once per kind per page load (the first is the one worth having; the
 *   server also caps each socket at 5 a minute), at most MAX_KINDS kinds;
 * - only while the socket is connected; up to MAX_BUFFER reports made
 *   before that wait and go out shortly after the next connect (after the
 *   session restore, so the server can name the signed-in user);
 * - URL queries and fragments stripped and every field cut to the server's
 *   limits here, before anything leaves the page (the server scrubs again);
 * - never throws, and never reports itself.
 *
 * The server ignores every report while CLIENT_ERRORS=off.
 */

const KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const PAGE_CHARS = /[^A-Za-z0-9_.:-]/g;
export const MAX_BUFFER = 5;
export const MAX_KINDS = 20;
/** After a connect, wait for the session restore before flushing. */
export const FLUSH_DELAY_MS = 1500;
const LIMITS = { message: 300, stack: 2000, where: 200, build: 64, page: 32 };
const STACK_LINES = 12;

/** `s` without URL queries or fragments (a reset or session token can ride in one). */
export function stripUrlParts(s) {
  return String(s)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*/gi, '$1')
    .replace(/(\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*/g, '$1');
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text of whatever was thrown or rejected; never an object's contents. */
function messageOf(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.message === 'string') {
    const name = typeof value.name === 'string' && value.name && value.name !== 'Error' ? `${value.name}: ` : '';
    return `${name}${value.message}`;
  }
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}

/** The file:line:col of an ErrorEvent, without the page's host or query. */
function whereOf(filename, line, col) {
  if (!filename) return '';
  const file = stripUrlParts(filename).split('/').pop() || '';
  return [file, line, col].filter((p) => p !== undefined && p !== null && p !== '').join(':');
}

/** The payload Joi accepts for `kind` / `value`, or null. */
export function buildReport(kind, value, { where, stack, build, page } = {}) {
  if (typeof kind !== 'string' || !KIND.test(kind)) return null;
  const message = cut(stripUrlParts(messageOf(value)).trim() || '(no message)', LIMITS.message);
  const report = { kind, message };
  const st = stack ?? (value && typeof value === 'object' ? value.stack : undefined);
  if (typeof st === 'string' && st) report.stack = cut(stripUrlParts(st.split('\n').slice(0, STACK_LINES).join('\n')), LIMITS.stack);
  if (typeof where === 'string' && where) report.where = cut(stripUrlParts(where), LIMITS.where);
  if (typeof build === 'string' && build) report.build = cut(build, LIMITS.build);
  if (typeof page === 'string' && page) report.page = page.replace(PAGE_CHARS, '').slice(0, LIMITS.page);
  if (report.page === '') delete report.page;
  return report;
}

/**
 * A reporter. `build` and `page()` (the current screen) go on every
 * report; `schedule` is setTimeout (tests pass fake timers).
 */
export function createClientErrorReporter({ build = '', page = () => null, schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let opts = { build, page };
  const seen = new Set();
  const buffer = [];
  let socket = null;
  let flushTimer = null;
  let sending = false;
  const stats = { sent: 0, buffered: 0, deduped: 0, dropped: 0 };

  const connected = () => Boolean(socket && socket.connected);

  function send(report) {
    sending = true;
    try {
      socket.emit('clientError', report);
      stats.sent++;
    } finally {
      sending = false;
    }
  }

  function flush() {
    flushTimer = null;
    try {
      while (buffer.length && connected()) send(buffer.shift());
    } catch {
      /* never let a report break the page */
    }
  }

  function report(kind, value, extra = {}) {
    try {
      if (sending) return false; // an error while sending one: never loop
      if (seen.has(kind)) {
        stats.deduped++;
        return false;
      }
      if (seen.size >= MAX_KINDS) return false;
      let currentPage = null;
      try {
        currentPage = opts.page();
      } catch {
        currentPage = null;
      }
      const r = buildReport(kind, value, { ...extra, build: opts.build, page: currentPage });
      if (!r) return false;
      // the kind counts as reported only once it is sent or waiting: a dropped one may come again
      if (connected() && !flushTimer) {
        seen.add(kind);
        send(r);
        return true;
      }
      if (buffer.length >= MAX_BUFFER) {
        stats.dropped++;
        return false;
      }
      seen.add(kind);
      buffer.push(r);
      stats.buffered++;
      return true;
    } catch {
      return false;
    }
  }

  /** Report through `sock` (a socket.io-client socket): now when connected, else after its next connect. */
  function attach(sock) {
    socket = sock;
    try {
      sock.on('connect', () => {
        if (!flushTimer) flushTimer = schedule(flush, FLUSH_DELAY_MS);
      });
      if (connected() && buffer.length && !flushTimer) flushTimer = schedule(flush, FLUSH_DELAY_MS);
    } catch {
      /* a stub socket */
    }
  }

  /**
   * window 'error' and 'unhandledrejection'. A cross-origin "Script error."
   * (a browser extension, no file, no stack) says nothing and is skipped, and
   * so is the harmless "ResizeObserver loop ..." (the canvas and chat log
   * observers), which would otherwise use up the page's one 'error'.
   * @returns {Function} removes both listeners
   */
  function installWindowHooks(win = window) {
    const onError = (e) => {
      try {
        const filename = e?.filename || '';
        const err = e?.error;
        if (!err && !filename && /^Script error\.?$/.test(String(e?.message || ''))) return;
        if (!err && /^ResizeObserver loop/.test(String(e?.message || ''))) return;
        report('error', err || e?.message || 'error', { where: whereOf(filename, e?.lineno, e?.colno) });
      } catch {
        /* never throw from the hook */
      }
    };
    const onRejection = (e) => {
      try {
        report('unhandledrejection', e?.reason);
      } catch {
        /* never throw from the hook */
      }
    };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    return () => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    };
  }

  /** Set the build and the screen getter (main.js, once it knows them); earlier reports keep theirs. */
  function configure(next = {}) {
    opts = { ...opts, ...next };
  }

  return { report, attach, configure, installWindowHooks, flush, stats, get pending() { return buffer.length; } };
}

let shared = null;

/** The page's reporter (main.js configures and attaches it; until then reports buffer). */
export function getClientErrorReporter() {
  if (!shared) shared = createClientErrorReporter();
  return shared;
}

/** For in-app counters (SeqGate, TableDirector, ClientSession): report once per kind, never throw. */
export function reportClientError(kind, value, extra) {
  try {
    return getClientErrorReporter().report(kind, value, extra);
  } catch {
    return false;
  }
}

/** Tests only. */
export function _resetClientErrorReporter() {
  shared = null;
}
