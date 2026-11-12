/**
 * What a server restart took away (owner decision 2026-11-11, V1_REMOVALS
 * #17 kept). On `serverShutdown` (every deploy: SIGTERM, gracefulShutdown
 * broadcasts it and closes every socket about 1 s later) the page records
 * where the player was: a seat, watching a game, a game lobby, a
 * tournament (playing or watching). Games, lobbies and tournaments live in
 * the server's memory, so after the restart the restore finds them gone;
 * the first restore path that finds it gone (rejoinFailed, the re-spectate
 * refusal, the lobby or tournament re-entry refusal, a tournamentLeft) takes
 * the record and shows ONE plain message for it. A restore that finds the
 * place still there (rejoinSuccess, the lobby, the tournament, the watched
 * table) forgets it, and nothing is recorded for the main room, the
 * game-end screen or a paused (parked) tab, where nothing is lost.
 *
 * The record lives in sessionStorage with a timestamp, so a reload while
 * the server restarts still knows, and is forgotten after
 * RESTART_NOTICE_TTL_MS (about 2 minutes) or once it was shown.
 */

export const RESTART_NOTICE_KEY = 'bab.serverRestart';
export const RESTART_NOTICE_TTL_MS = 2 * 60 * 1000;

/** Where the player was when the notice came. */
export const LOSS = Object.freeze({
  SEAT: 'seat',
  SPECTATOR: 'spectator',
  LOBBY: 'lobby',
  TOURNAMENT: 'tournament',
  TOURNAMENT_SPECTATOR: 'tournamentSpectator',
});

// An unfinished game writes no gameRecords entry and no stats: the only
// writer is the end path's recordGameStats (server/socket/gameHandlers.js,
// after gameEnd), and a game that dies with the process never gets there.
// Tournament round scores live in memory only.
export const RESTART_LOSS_TEXT = Object.freeze({
  [LOSS.SEAT]: "Your game ended because the server restarted for an update. It won't count toward your stats.",
  [LOSS.SPECTATOR]: 'The game you were watching ended because the server restarted for an update.',
  [LOSS.LOBBY]: 'Your lobby closed because the server restarted for an update.',
  // (no stats sentence: its finished rounds did count)
  [LOSS.TOURNAMENT]: 'Your tournament ended because the server restarted for an update.',
  [LOSS.TOURNAMENT_SPECTATOR]: 'The tournament you were watching ended because the server restarted for an update.',
});

const KINDS = new Set(Object.values(LOSS));

function defaultStorage() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * @param {Object} [options]
 * @param {Storage|null} [options.storage] - sessionStorage (null: this page only)
 * @param {Function} [options.now] - () => ms
 */
export function createRestartNotice({ storage = defaultStorage(), now = () => Date.now() } = {}) {
  // Kept in memory too: storage that throws (or none) still covers this page
  let memory = null;

  const write = (record) => {
    memory = record;
    try {
      if (record) storage?.setItem(RESTART_NOTICE_KEY, JSON.stringify(record));
      else storage?.removeItem(RESTART_NOTICE_KEY);
    } catch {
      /* storage blocked: memory only */
    }
  };

  const read = () => {
    let record = memory;
    try {
      if (storage) {
        const raw = storage.getItem(RESTART_NOTICE_KEY);
        record = raw ? JSON.parse(raw) : null;
      }
    } catch {
      /* blocked or unreadable: memory only */
      record = memory;
    }
    if (!record || !KINDS.has(record.kind) || typeof record.at !== 'number') {
      if (record) write(null);
      return null;
    }
    const age = now() - record.at;
    if (age < 0 || age > RESTART_NOTICE_TTL_MS) {
      write(null);
      return null;
    }
    return record;
  };

  return {
    /**
     * The notice came: remember what the player was in (null: nothing to
     * lose, e.g. the main room; forgets an older record).
     */
    note(kind) {
      write(KINDS.has(kind) ? { kind, at: now() } : null);
    },
    /** The recorded loss, while it is fresh. @returns {string|null} */
    get pending() {
      return read()?.kind || null;
    },
    /**
     * A restore path found the place gone: the message to show, once (the
     * record stays, marked shown, so the paths that fire after it, e.g. the
     * tournament re-entry after a failed rejoin at its table, stay quiet).
     * @returns {string|null}
     */
    take() {
      const record = read();
      if (!record || record.shown) return null;
      write({ ...record, shown: true });
      return RESTART_LOSS_TEXT[record.kind];
    },
    /** The message was shown for this restart. */
    get shown() {
      return !!read()?.shown;
    },
    /** The place survived (or the player signed out): nothing to say. */
    clear() {
      write(null);
    },
  };
}

let instance = null;

export function getRestartNotice() {
  if (!instance) instance = createRestartNotice();
  return instance;
}

/** For tests. */
export function resetRestartNotice(options) {
  instance = options ? createRestartNotice(options) : null;
  return instance;
}
