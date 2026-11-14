/**
 * Which games the stats pages show (owner, 2026-11-13): human games only
 * (the default), games with bots, or all games. One choice per device,
 * shared by the Leaderboard, Records and both Profile views, kept in
 * localStorage. Storage can throw (private mode, blocked site data): every
 * access is wrapped and the choice then lives for this page only. The
 * server reads the scope from getLeaderboard / getRecords / getProfile /
 * getPlayerProfile {scope} and echoes it in the reply (server/utils/statsScope.js).
 */

export const STATS_SCOPES = Object.freeze(['human', 'bots', 'all']);
export const STATS_SCOPE_KEY = 'bab.statsScope';
export const DEFAULT_STATS_SCOPE = 'human';

/** The labels the scope control shows (and screen readers read). */
export const STATS_SCOPE_LABELS = Object.freeze({
  human: 'Human games',
  bots: 'Bot games',
  all: 'All games',
});

/** Shown where a Bot games view has nothing yet (nothing was kept before this release). */
export const BOT_STATS_EMPTY_NOTE = 'No bot games recorded yet. Games with bots count toward stats from now on.';

export const isStatsScope = (v) => STATS_SCOPES.includes(v);

/** The choice when storage cannot keep it (this page only). */
let pageScope = null;

/** The page's localStorage, or null where reading it throws (blocked storage). */
function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * The current scope: the saved one, else this page's, else 'human'.
 *
 * @param {Storage|null} [storage]
 * @returns {'human'|'bots'|'all'}
 */
export function getStatsScope(storage = defaultStorage()) {
  try {
    const saved = storage?.getItem(STATS_SCOPE_KEY);
    if (isStatsScope(saved)) return saved;
  } catch {
    // blocked storage: fall through to this page's choice
  }
  return isStatsScope(pageScope) ? pageScope : DEFAULT_STATS_SCOPE;
}

/**
 * Remember a scope on this device (and for this page, whatever storage
 * does). An unknown value is ignored.
 *
 * @returns {boolean} true when storage kept it
 */
export function setStatsScope(scope, storage = defaultStorage()) {
  if (!isStatsScope(scope)) return false;
  pageScope = scope;
  try {
    if (!storage) return false;
    storage.setItem(STATS_SCOPE_KEY, scope);
    return true;
  } catch {
    return false;
  }
}

/** The payload for a stats request: {scope} (plus `extra`, e.g. {username}). */
export function scopePayload(extra = {}, scope = getStatsScope()) {
  return { ...extra, scope };
}

/**
 * A reply that is not for the current choice (a fast switch: the earlier
 * request's reply arrives after the later one was sent). A reply without
 * a scope (a failure, or an older server) is never stale.
 */
export function isStaleScopeReply(replyScope, current = getStatsScope()) {
  return replyScope !== undefined && replyScope !== null && replyScope !== current;
}

/**
 * Coalesce quick switches into one request (arrow keys through the
 * options): the server allows 10 stats requests per 10 s per socket.
 *
 * @param {(scope: string) => void} send
 * @param {number} [delayMs]
 */
export function createScopeRequester(send, delayMs = 200) {
  let timer = null;
  return {
    request(scope) {
      if (timer) clearTimeout(timer);
      if (delayMs <= 0) {
        timer = null;
        send(scope);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        send(scope);
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Test helper: forget this page's choice. */
export function _resetStatsScopeForTests() {
  pageScope = null;
}
