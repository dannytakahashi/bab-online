/**
 * The over-the-shoulder view on the web (owner 2026-11-21; the wire and the
 * server's rules: docs/claude/spectators.md "Over-the-shoulder view").
 *
 * A pure spectator watches one seat's hand, read-only, the table drawn from
 * that seat as if looking over its player's shoulder. The wire keeps
 * viewer.position null; GameState rotates its own drawing instead: while a
 * seat is watched, GameState.position is that seat (isSpectator stays true,
 * so nothing can act) and GameState.shoulder = {position, paused}, with the
 * watched hand in myCards and its HSI in hsiValues.
 *
 * Here: the helpers every view uses to tell a pure spectator (the table
 * view) from a watcher, the words, and ShoulderWatch, which decides what to
 * send (c2s watchHand):
 *   - by default, after every full state (spectatorJoined, a requestSnapshot
 *     reply; never the watchHand reply itself) and on the first deal, watch
 *     the first human seat in seat order (seat 1 if none), or the seat the
 *     person picked for this game (an avatar click; sessionStorage
 *     `bab.shoulder`), or nothing after "Table view" for this game;
 *   - never at a tournament table (snapshot `tournament`, or the
 *     `tournament` refusal): no shoulder UI there at all;
 *   - the own-seat rule: a spectator whose username owns a seat here (a
 *     second tab) watches only that seat (seatOwners, or the `own_seat`
 *     refusal's ownPosition: switched to silently);
 *   - the paused rule: while the table is paused (an `unavailable` refusal,
 *     or between the room's "Game paused: ..." and "Game resumed." lines)
 *     the selection stays, the watched hand area shows as paused (no stale
 *     cards), and watchHand(selected) is sent again after "Game resumed."
 *     and after the next full state; only the person's own Table view, the
 *     game's end or leaving the table drop the selection.
 */

import { CLIENT_EVENTS } from '../constants/events.js';

/** The clientHello cap that asks for the over-the-shoulder view. */
export const SHOULDER_CAP = 'shoulderView';

/** The room's system lines around a self-fence suspension (server/game/persist/liveStore.js). */
export const PAUSE_LINE = 'Game paused: the server is reconnecting. It will resume on its own.';
export const RESUME_LINE = 'Game resumed.';

/** sessionStorage: {gameId, choice: 'table' | 1-4}, the person's pick for one game. */
export const STORAGE_KEY = 'bab.shoulder';

/** The pill's control back to the plain table view. */
export const TABLE_VIEW_LABEL = 'Table view';

const SEATS = [1, 2, 3, 4];
const isSeat = (p) => SEATS.includes(p);
const RANKS = new Set(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', 'HI', 'LO']);
const SUITS = new Set(['spades', 'hearts', 'diamonds', 'clubs', 'joker']);

/**
 * A `shoulder {position, hand, hsi}` (snapshot viewer.shoulder, gameStart
 * shoulder) as {position, hand, hsi}, or null when absent or malformed.
 */
export function validShoulder(raw) {
  if (!raw || typeof raw !== 'object' || !isSeat(raw.position) || !Array.isArray(raw.hand)) return null;
  const hand = [];
  for (const c of raw.hand) {
    if (!c || !SUITS.has(c.suit) || !RANKS.has(String(c.rank))) return null;
    hand.push({ suit: c.suit, rank: c.rank });
  }
  const hsi = typeof raw.hsi === 'number' && Number.isFinite(raw.hsi) ? raw.hsi : null;
  return { position: raw.position, hand, hsi };
}

/** Is this a watcher (a pure spectator looking over a seat's shoulder)? */
export function isShoulder(s) {
  return !!s && !!s.isSpectator && !s.isLazy && !!s.shoulder && isSeat(s.shoulder.position);
}

/** A pure spectator in the plain table view (seat 1 at the bottom, no hand). */
export function isPureSpectator(s) {
  return !!s && !!s.isSpectator && !s.isLazy && !isShoulder(s);
}

/**
 * Is `pos` the seat this table is drawn from with its hand shown: my own
 * seat (a player, a lazy watcher), or the watched seat?
 */
export function isViewedSeat(s, pos) {
  return !!pos && !!s && pos === s.position && (!s.isSpectator || isShoulder(s));
}

/** The first human seat in seat order (GameState.humanOwners), else seat 1. */
export function firstHumanSeat(s) {
  return SEATS.find((p) => !!s?.humanOwners?.[p]) || 1;
}

/** The seat my username owns at this table (a second tab of a player), or null. */
export function ownSeatOf(s) {
  if (!s?.username) return null;
  return SEATS.find((p) => s.seatOwners?.[p] === s.username) || null;
}

/** "Alice's" (the name as it is: no apostrophe rules beyond 's). */
export function possessive(name) {
  return `${name}'s`;
}

/** Who watches each seat ({position: [usernames]}) from GameState.watching. */
export function watchersBySeat(watching) {
  const out = {};
  for (const w of watching?.spectators || []) {
    if (!w || !isSeat(w.shoulder) || !w.username) continue;
    (out[w.shoulder] ||= []).push(w.username);
  }
  return out;
}

/** Names as words: "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The eye chip's words on a watched seat: "Zach is watching Alice's hand",
 * "Zach and Yan are watching Alice's hand"; `me` (my username) reads "You";
 * `mine` (the seat is my own): "Zach is watching your hand".
 */
export function watchTitle(names, player, { me = null, mine = false } = {}) {
  const shown = names.map((n) => (n === me ? 'You' : n));
  const verb = shown.length === 1 && shown[0] !== 'You' ? 'is' : 'are';
  return `${nameList(shown)} ${verb} watching ${mine ? 'your' : possessive(player)} hand`;
}

/** A spectator list row: "Zach · watching Alice" (or just the name). */
export function watcherRow(name, player) {
  return player ? `${name} · watching ${player}` : name;
}

/** The spectating pill while watching: "Watching Alice's hand" (· paused). */
export function watchingPillText(player, { paused = false } = {}) {
  return `Watching ${possessive(player)} hand${paused ? ' · paused' : ''}`;
}

/**
 * The heading of a watched seat's /help or tutorial card (owner
 * 2026-11-21: the watched player's name, never a team or seat): "Alice's
 * advice", "Alice's tip", "Alice's tip and advice" (both up). The card's
 * screen-reader label is the same words.
 */
export function watchedCardHeading(player, { advice = false, tip = false } = {}) {
  const what = advice && tip ? 'tip and advice' : (advice ? 'advice' : 'tip');
  return `${possessive(player)} ${what}`;
}

/** The watched hand area while the table is paused. */
export function pausedText(player) {
  return `Paused: ${possessive(player)} hand comes back when the game resumes.`;
}

function readChoice(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v.gameId !== 'string') return null;
    if (v.choice !== 'table' && !isSeat(v.choice)) return null;
    return v;
  } catch {
    return null;
  }
}

function writeChoice(storage, gameId, choice) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ gameId, choice }));
  } catch {
    /* blocked storage: the choice lasts for this page only */
  }
}

const defaultStorage = () => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
};

/**
 * What this page asks the server to show (c2s watchHand) and when.
 * One per page (getShoulderWatch); main.js wires its emit and view callback.
 */
export class ShoulderWatch {
  /**
   * @param {Object} o
   * @param {Function} o.getState - () => GameState
   * @param {Function} [o.emit] - (event, payload) => void
   * @param {Function} [o.onView] - () => void: the view changed locally (a stop, a pause): redraw
   * @param {Function} [o.storage] - () => Storage | null
   */
  constructor({ getState = null, emit = null, onView = null, storage = defaultStorage } = {}) {
    this._getState = getState;
    this._emit = emit;
    this._onView = onView;
    this._storage = storage;
    this.sent = [];
    this.leave();
  }

  /** Wire the page: its GameState, its emit and its redraw. */
  configure({ getState, emit, onView } = {}) {
    if (getState) this._getState = getState;
    if (emit) this._emit = emit;
    if (onView) this._onView = onView;
  }

  /** The table was left (or a new one entered): nothing selected, nothing known. */
  leave() {
    this.gameId = null;
    this.selected = null; // the seat watched or wanted (the selection)
    this.ownSeat = null; // the own-seat rule's seat
    this.blocked = false; // a tournament table
    this.paused = false;
    this.waitingDeal = false; // not_dealt: send at the first gameStart
    this.lastSent = undefined;
    const s = this._getState?.();
    if (s && s.shoulderHold) s.setShoulderHold?.(null);
  }

  _state() {
    return this._getState?.() || null;
  }

  /** The person's remembered pick for this game: 'table', a seat, or undefined. */
  choice() {
    const v = readChoice(this._storage?.());
    return v && v.gameId === this.gameId ? v.choice : undefined;
  }

  _remember(choice) {
    if (this.gameId) writeChoice(this._storage?.(), this.gameId, choice);
  }

  /** Is the shoulder view offered here (a pure spectator, not at a tournament table)? */
  allowed() {
    const s = this._state();
    return !!s && !!s.isSpectator && !s.isLazy && !this.blocked && !s.tournamentTable;
  }

  /** The seat to watch now (null: the plain table view). */
  desired() {
    if (!this.allowed()) return null;
    const s = this._state();
    // the person's Table view wins over every default: the own-seat rule
    // only limits WHICH seat may be watched, it never forces a watch
    const c = this.choice();
    if (c === 'table') return null;
    const own = this.ownSeat || ownSeatOf(s);
    if (own) return own;
    if (isSeat(c)) return c;
    // the seat watched now (the server's last word), else the first human seat
    return this.selected || firstHumanSeat(s);
  }

  _noteGame(gameId) {
    if (!gameId || gameId === this.gameId) return;
    this.leave();
    this.gameId = gameId;
  }

  _send(position) {
    const s = this._state();
    const gameId = this.gameId || s?.gameId;
    if (!gameId || !this._emit) return false;
    this.lastSent = position;
    this.sent.push(position);
    this._emit(CLIENT_EVENTS.WATCH_HAND, { gameId, position });
    return true;
  }

  _hold(position) {
    const s = this._state();
    s?.setShoulderHold?.(position);
  }

  /**
   * After a full state (spectatorJoined, a requestSnapshot reply), already
   * applied to GameState: send watchHand when what is wanted is not what is
   * served (the re-send rule; idempotent on the server).
   * @param {Object} snap - the parsed snapshot
   */
  afterFullState(snap) {
    const s = this._state();
    if (!snap || !s) return;
    this._noteGame(snap.gameId || s.gameId);
    if (snap.tournament) this.blocked = true;
    if (!this.allowed()) {
      this._clearSelection();
      return;
    }
    const served = validShoulder(snap.viewer?.shoulder)?.position ?? null;
    if (served) {
      this.selected = served;
      this._unpause();
    }
    if (!snap.deal) {
      this.waitingDeal = true;
      return;
    }
    const want = this.paused && this.selected ? this.selected : this.desired();
    this.selected = want;
    this.waitingDeal = false;
    if (want !== served) this._send(want);
  }

  /** The watchHand reply (stateSnapshot reason watchHand), applied to GameState. */
  afterReply(snap) {
    const s = this._state();
    if (!snap || !s) return;
    this._noteGame(snap.gameId || s.gameId);
    const served = validShoulder(snap.viewer?.shoulder)?.position ?? null;
    if (served) {
      this.selected = served;
      this._unpause();
    } else if (!this.paused) {
      this.selected = null;
    }
  }

  /**
   * A deal (gameStart) reached this spectator, already applied: the first
   * deal after the draw (or a not_dealt refusal) sends the watch; a deal
   * without the watched seat's hand while one is wanted asks again.
   * @param {Object} data - gameStart
   */
  onDeal(data) {
    const s = this._state();
    if (!s || !s.isSpectator) return;
    this._noteGame(data?.gameId || s.gameId);
    if (!this.allowed() || this.paused) return;
    const want = this.selected || this.desired();
    const got = validShoulder(data?.shoulder)?.position ?? null;
    this.waitingDeal = false;
    if (want && got !== want) {
      this.selected = want;
      this._send(want);
    }
  }

  /**
   * watchHandRefused {gameId, position, reason, message, ownPosition?}.
   * @returns {string|null} what happened: 'own_seat' (switched), 'paused', 'blocked', 'later', 'dropped'; null: ignored
   */
  onRefused(data) {
    const s = this._state();
    if (!data || !s) return null;
    if (data.gameId && (this.gameId || s.gameId) && data.gameId !== (this.gameId || s.gameId)) return null;
    switch (data.reason) {
      case 'own_seat':
        if (!isSeat(data.ownPosition)) return null;
        this.ownSeat = data.ownPosition;
        // (after a Table view only a click watches again)
        if (this.choice() === 'table' || data.position === null) return 'own_seat';
        this.selected = data.ownPosition;
        if (data.position !== data.ownPosition) this._send(data.ownPosition);
        return 'own_seat';
      case 'unavailable':
        if (!this.selected) return null;
        this.paused = true;
        this._hold(this.selected);
        this._onView?.();
        return 'paused';
      case 'tournament':
        this.blocked = true;
        this._clearSelection();
        return 'blocked';
      case 'not_dealt':
        this.waitingDeal = true;
        return 'later';
      default:
        // not_spectating: this page is not a pure spectator of that table
        this._clearSelection();
        return 'dropped';
    }
  }

  /**
   * A room system line: "Game paused: ..." keeps the selection and shows the
   * hand area as paused; "Game resumed." sends the watch again.
   * @returns {boolean} whether it was one of them
   */
  onLogLine(message) {
    if (message === PAUSE_LINE) {
      if (!this.allowed() || !this.selected) return true;
      this.paused = true;
      this._hold(this.selected);
      this._onView?.();
      return true;
    }
    if (message === RESUME_LINE) {
      if (!this.allowed() || !this.paused || !this.selected) return true;
      this._send(this.selected);
      return true;
    }
    return false;
  }

  /**
   * An avatar was clicked: 'watch' (watchHand to that seat went out) or
   * 'profile' (the caller opens the profile: the watched seat itself, a
   * seat the own-seat rule keeps out, a tournament table, not a spectator).
   */
  avatarClick(position) {
    const s = this._state();
    if (!isSeat(position) || !this.allowed() || !s?.handNo) return 'profile';
    const own = this.ownSeat || ownSeatOf(s);
    if (own && position !== own) return 'profile';
    if (isShoulder(s) && s.shoulder.position === position && !s.shoulder.paused) return 'profile';
    this.choose(position);
    return 'watch';
  }

  /** Watch `position` (the person's pick for this game). */
  choose(position) {
    if (!isSeat(position) || !this.allowed()) return false;
    this._noteGame(this._state()?.gameId);
    this._remember(position);
    this.selected = position;
    if (this.paused) {
      this._hold(position);
      this._onView?.();
    }
    return this._send(position);
  }

  /** Table view: stop watching (remembered for this game); the view changes at once. */
  stop() {
    const s = this._state();
    this._noteGame(s?.gameId);
    this._remember('table');
    const had = this.selected !== null || isShoulder(s);
    this._clearSelection();
    if (had) this._send(null);
    return had;
  }

  /**
   * The game ended (gameEnd / abortGame): the selection goes, and the table
   * is the plain spectator's again (the end screen names the sides from
   * seat 1, as for any spectator). Nothing is sent: the server forgets the
   * watch with the game.
   */
  ended() {
    const s = this._state();
    this.selected = null;
    this.paused = false;
    s?.setShoulderHold?.(null);
    if (isShoulder(s)) s.applyShoulderStop();
  }

  _unpause() {
    if (!this.paused && !this._state()?.shoulderHold) return;
    this.paused = false;
    this._hold(null);
  }

  /** Drop the selection and the view (a stop, a tournament table, not a spectator). */
  _clearSelection() {
    const s = this._state();
    this.selected = null;
    this.paused = false;
    const viewing = isShoulder(s);
    s?.setShoulderHold?.(null);
    if (viewing) {
      s.applyShoulderStop();
      this._onView?.();
    }
  }
}

let instance = null;

/** The page's ShoulderWatch (bound to the GameState singleton by main.js). */
export function getShoulderWatch(opts = null) {
  if (!instance) instance = new ShoulderWatch(opts || {});
  return instance;
}

/** Tests: a fresh one. */
export function resetShoulderWatch(opts = null) {
  instance = new ShoulderWatch(opts || {});
  return instance;
}
