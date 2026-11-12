/**
 * Client session: the one place that knows which screen the web client is
 * on, how it sits at a table, and the state of its connection.
 *
 * Screens (an explicit FSM; TRANSITIONS lists every legal move):
 *
 *   BOOT -> SIGN_IN | MAIN_ROOM | TOURNAMENT_LOBBY | TABLE
 *   SIGN_IN -> SIGN_IN | MAIN_ROOM | TOURNAMENT_LOBBY | TABLE
 *   MAIN_ROOM -> MAIN_ROOM | LOBBY | TOURNAMENT_LOBBY | TABLE | SIGN_IN
 *   LOBBY -> LOBBY | MAIN_ROOM | TOURNAMENT_LOBBY | TABLE | SIGN_IN
 *   TOURNAMENT_LOBBY -> TOURNAMENT_LOBBY | MAIN_ROOM | TABLE | SIGN_IN
 *   TABLE(role) -> TABLE | GAME_END | MAIN_ROOM | TOURNAMENT_LOBBY | SIGN_IN
 *   GAME_END -> MAIN_ROOM | TOURNAMENT_LOBBY | TABLE | SIGN_IN
 *
 * A self-transition re-enters the screen (new data from the server, e.g.
 * mainRoomJoined after a reconnect); TABLE -> TABLE changes the role. An
 * illegal transition logs and fails closed (nothing changes); under Vitest
 * it throws. Each screen has enter/exit hooks (main.js renders/removes the
 * DOM there), run as exit(from) then enter(to).
 *
 * The table is entered only through enterTable(role, gameId) and left only
 * through exitTable(reason): exitTable owns the whole teardown (the
 * teardownTable hook: scene, log, overlays, bubbles, voice; then every
 * gameId copy, the rejoin flags and the per-game GameState) and the route
 * out (the tournament lobby for a tournament player, else the main room,
 * or the sign-in screen).
 *
 * Reconnects: every connect of a signed-in tab restores the session first
 * (restoreSession, once per socket id), and its reply rejoins the game
 * (exactly one rejoinGame per socket), re-spectates, or re-enters the
 * current screen. Spectators never persist gameId (only spectatingGameId).
 *
 * Connection region (connected | reconnecting | offline) follows the
 * SocketManager state; the ConnectionBanner shows the same transitions.
 */

import { CLIENT_EVENTS } from '../constants/events.js';

export const SCREEN = Object.freeze({
  BOOT: 'boot',
  SIGN_IN: 'signIn',
  MAIN_ROOM: 'mainRoom',
  LOBBY: 'lobby',
  TOURNAMENT_LOBBY: 'tournamentLobby',
  TABLE: 'table',
  GAME_END: 'gameEnd',
});

export const ROLE = Object.freeze({
  PLAYER: 'player',
  LAZY: 'lazy',
  SPECTATOR: 'spectator',
});

export const CONNECTION = Object.freeze({
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
});

/** Why the table is left (exitTable's reason). */
export const EXIT = Object.freeze({
  GAME_END_RETURN: 'gameEndReturn',
  LEFT_GAME: 'leftGame',
  ABORT: 'abortGame',
  REJOIN_FAILED: 'rejoinFailed',
  SPECTATE_FAILED: 'spectateFailed',
  TABLE_LOST: 'tableLost',
  TOURNAMENT_CANCELLED: 'tournamentCancelled',
  FORCE_LOGOUT: 'forceLogout',
  SIGN_OUT: 'signOut',
  RECONNECT_FAILED: 'reconnectFailed',
  NEW_TABLE: 'newTable',
});

const S = SCREEN;
export const TRANSITIONS = Object.freeze({
  [S.BOOT]: [S.SIGN_IN, S.MAIN_ROOM, S.TOURNAMENT_LOBBY, S.TABLE],
  [S.SIGN_IN]: [S.SIGN_IN, S.MAIN_ROOM, S.TOURNAMENT_LOBBY, S.TABLE],
  [S.MAIN_ROOM]: [S.MAIN_ROOM, S.LOBBY, S.TOURNAMENT_LOBBY, S.TABLE, S.SIGN_IN],
  [S.LOBBY]: [S.LOBBY, S.MAIN_ROOM, S.TOURNAMENT_LOBBY, S.TABLE, S.SIGN_IN],
  [S.TOURNAMENT_LOBBY]: [S.TOURNAMENT_LOBBY, S.MAIN_ROOM, S.TABLE, S.SIGN_IN],
  [S.TABLE]: [S.TABLE, S.GAME_END, S.MAIN_ROOM, S.TOURNAMENT_LOBBY, S.SIGN_IN],
  [S.GAME_END]: [S.MAIN_ROOM, S.TOURNAMENT_LOBBY, S.TABLE, S.SIGN_IN],
});

const ROLES = new Set(Object.values(ROLE));

// A route request (joinMainRoom / returnToTournament) counts as in flight
// until its reply (or a disconnect); after this long another may go out
export const ROUTE_TIMEOUT_MS = 5000;

// TOURNAMENT: the tournament lobby this tab shows (a reload re-enters it;
// the server records activeTournamentId only once a tournament begins).
// TOURNAMENT_SPECTATE: that tournament's id when this tab only watches it
// (spectateTournament): a reload re-spectates, and the lobby shows no
// player controls (the server's returnToTournament reply carries no
// isSpectator flag).
// LOBBY: the game lobby this tab shows, so a reload re-enters it (the
// server holds the seat for 30 s: GameManager.LOBBY_SEAT_GRACE_MS)
const STORAGE = {
  GAME: 'gameId', SPECTATE: 'spectatingGameId', USER: 'username', TOKEN: 'sessionToken',
  TOURNAMENT: 'tournamentId', TOURNAMENT_SPECTATE: 'tournamentSpectate', LOBBY: 'lobbyId',
};

function isTestRun() {
  try {
    return import.meta.env?.MODE === 'test';
  } catch {
    return false;
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export class IllegalTransitionError extends Error {}

export class ClientSession {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.strict] - throw on an illegal transition (default: under Vitest)
   * @param {Object} [options.logger] - console-like
   */
  constructor({ strict = isTestRun(), logger = console } = {}) {
    this._strict = strict;
    this._log = logger;
    this._screen = SCREEN.BOOT;
    this._role = null;
    this._connection = CONNECTION.RECONNECTING;
    this._hooks = {};
    this._teardownTable = null;
    this._socketManager = null;
    this._gameState = null;
    this._storage = typeof sessionStorage !== 'undefined' ? sessionStorage : memoryStorage();
    this._started = false;
    this._connectionListeners = new Set();
    this._screenListeners = new Set();
    this._unsubscribeSocket = null;
    this._resetBookkeeping();
    this.history = [];
  }

  _resetBookkeeping() {
    // Bumped by every enterTable/exitTable: deferred table work (a rejoin
    // waiting for the scene) checks it and stops when it changed
    this.tableGeneration = 0;
    this.lobbyId = null;
    this.rejoinAttempted = false;
    this.rejoinSucceeded = false;
    this._rejoinSentFor = null; // socket id
    this._rejoinSucceededFor = null; // `${socketId}:${gameId}`
    this._restoreSentFor = null; // socket id
    this._restoredSocketId = null;
    this._superseded = false; // another tab has the session (sessionSuperseded)
    this._routeInFlight = null; // { kind, at }
    this._pendingLobbyRejoin = null; // lobbyId
    this._pendingSpectate = null; // gameId
    this._pendingTournamentRejoin = null; // { tournamentId, spectator }
    this._tournamentWatchSocket = null; // socket id the server knows as the tournament's spectator
  }

  // ============================================
  // Wiring
  // ============================================

  /**
   * @param {Object} deps
   * @param {import('../socket/SocketManager.js').SocketManager} deps.socketManager
   * @param {import('./GameState.js').GameState} deps.gameState
   * @param {Storage} [deps.storage]
   */
  attach({ socketManager, gameState, storage } = {}) {
    if (storage) this._storage = storage;
    if (gameState) this._gameState = gameState;
    if (socketManager && socketManager !== this._socketManager) {
      this._unsubscribeSocket?.();
      this._socketManager = socketManager;
      this._unsubscribeSocket = socketManager.onStateChange?.((event, data) => this._onSocketState(event, data)) || null;
      if (socketManager.isConnected) this._setConnection(CONNECTION.CONNECTED);
    }
    return this;
  }

  /**
   * @param {Object} hooks
   * @param {Object} [hooks.screens] - {[SCREEN]: {enter(data, ctx), exit(ctx)}}
   * @param {Function} [hooks.teardownTable] - (reason, opts) => void
   */
  setHooks({ screens = {}, teardownTable = null } = {}) {
    this._hooks = { ...this._hooks, ...screens };
    if (teardownTable) this._teardownTable = teardownTable;
  }

  /**
   * Another tab of this browser took the session (sessionSuperseded): this
   * tab stays where it is, paused, and a reconnect does NOT restore the
   * session (that would silently take it back). Use here unparks and
   * reconnects; a sign-out or a restore that lands here unparks too.
   */
  park() {
    this._superseded = true;
    this._routeInFlight = null;
    this._pendingLobbyRejoin = null;
    this._pendingTournamentRejoin = null;
    this._pendingSpectate = null;
  }

  unpark() {
    this._superseded = false;
  }

  get isParked() {
    return this._superseded;
  }

  /** The page is wired (handlers registered): connects may resume the session now. */
  start() {
    this._started = true;
    if (this._socketManager?.socket?.connected) this.resume();
  }

  // ============================================
  // Reads
  // ============================================

  get screen() { return this._screen; }
  get role() { return this._role; }
  get connection() { return this._connection; }
  get isAtTable() { return this._screen === SCREEN.TABLE; }
  /** At the table or on its game-end screen: there is table UI to tear down. */
  get hasTable() { return this._screen === SCREEN.TABLE || this._screen === SCREEN.GAME_END; }
  get isSpectator() { return this.hasTable && this._role === ROLE.SPECTATOR; }
  get gameId() { return this._gameState?.gameId || null; }
  get persistedGameId() { return this._storage.getItem(STORAGE.GAME); }
  get persistedSpectateId() { return this._storage.getItem(STORAGE.SPECTATE); }
  get persistedTournamentId() { return this._storage.getItem(STORAGE.TOURNAMENT); }
  get persistedLobbyId() { return this._storage.getItem(STORAGE.LOBBY); }
  get username() { return this._gameState?.username || this._storage.getItem(STORAGE.USER) || null; }
  get tournamentId() { return this._gameState?.tournamentId || null; }
  get routeInFlight() { return this._routeInFlight?.kind || null; }
  get pendingSpectate() { return this._pendingSpectate; }
  get pendingLobbyRejoin() { return this._pendingLobbyRejoin; }

  can(to) {
    return (TRANSITIONS[this._screen] || []).includes(to);
  }

  // ============================================
  // Screen FSM
  // ============================================

  /**
   * Move to a screen (or re-enter the current one).
   * @returns {boolean} false when the move is illegal (nothing changed)
   */
  transition(to, data = undefined) {
    const from = this._screen;
    if (!TRANSITIONS[to] && to !== SCREEN.BOOT) {
      return this._illegal(from, to, 'unknown screen');
    }
    if (!this.can(to)) {
      return this._illegal(from, to);
    }
    const reenter = from === to;
    const ctx = { from, to, reenter, data, session: this };
    if (!reenter) this._runHook(from, 'exit', ctx);
    this._screen = to;
    if (to !== SCREEN.TABLE && to !== SCREEN.GAME_END) this._role = null;
    if (to !== SCREEN.LOBBY) {
      this.lobbyId = null;
      this._storage.removeItem(STORAGE.LOBBY);
    }
    if (to === SCREEN.TOURNAMENT_LOBBY && data?.tournamentId) this._noteTournamentLobby(data);
    else if (to === SCREEN.MAIN_ROOM || to === SCREEN.SIGN_IN) this._forgetTournamentLobby();
    this.history.push(reenter ? `${to}*` : to);
    if (this.history.length > 50) this.history.shift();
    this._runHook(to, 'enter', ctx);
    for (const fn of [...this._screenListeners]) {
      try {
        fn(to, ctx);
      } catch (err) {
        if (this._strict) throw err;
        this._log.error?.('ClientSession: screen listener failed', err);
      }
    }
    return true;
  }

  /**
   * Call fn(screen, ctx) after every transition (re-entries too), once the
   * screen's enter hook ran: the table's chrome and the Phaser loop follow
   * the screen. Returns an unsubscribe function.
   */
  onScreenChange(fn) {
    this._screenListeners.add(fn);
    return () => this._screenListeners.delete(fn);
  }

  _noteTournamentLobby(data) {
    this._storage.setItem(STORAGE.TOURNAMENT, data.tournamentId);
    if (data.isSpectator) {
      this._storage.setItem(STORAGE.TOURNAMENT_SPECTATE, data.tournamentId);
      // The server knows THIS socket as the tournament's spectator
      this._tournamentWatchSocket = this._socketManager?.id || null;
    } else if (!this.isTournamentSpectator(data.tournamentId)) {
      this._storage.removeItem(STORAGE.TOURNAMENT_SPECTATE);
    }
  }

  /** The tournament this tab only watches (kept across the TABLE it watches). */
  get watchedTournamentId() {
    return this._storage.getItem(STORAGE.TOURNAMENT_SPECTATE) || null;
  }

  _forgetTournamentLobby() {
    this._storage.removeItem(STORAGE.TOURNAMENT);
    this._storage.removeItem(STORAGE.TOURNAMENT_SPECTATE);
  }

  /** This tab watches that tournament (spectateTournament) rather than playing in it. */
  isTournamentSpectator(tournamentId) {
    return !!tournamentId && this._storage.getItem(STORAGE.TOURNAMENT_SPECTATE) === tournamentId;
  }

  _illegal(from, to, why = 'illegal transition') {
    const message = `ClientSession: ${why} ${from} -> ${to}`;
    if (this._strict) throw new IllegalTransitionError(message);
    this._log.error?.(message);
    return false;
  }

  _runHook(screen, kind, ctx) {
    const fn = this._hooks[screen]?.[kind];
    if (!fn) return;
    try {
      fn(ctx.data, ctx);
    } catch (err) {
      if (this._strict) throw err;
      this._log.error?.(`ClientSession: ${screen}.${kind} hook failed`, err);
    }
  }

  // ============================================
  // Table
  // ============================================

  /**
   * Sit at (or watch) a table. From TABLE it changes the role (the same
   * table) or, for another gameId, leaves the old table first; from
   * GAME_END the finished table is torn down first.
   * @returns {boolean}
   */
  enterTable(role, gameId = null) {
    if (!ROLES.has(role)) {
      if (this._strict) throw new Error(`ClientSession: unknown table role ${role}`);
      this._log.error?.(`ClientSession: unknown table role ${role}`);
      return false;
    }
    const from = this._screen;
    if (!this.can(SCREEN.TABLE)) return this._illegal(from, SCREEN.TABLE);

    const otherTable = from === SCREEN.TABLE && gameId && this.gameId && gameId !== this.gameId;
    if (from === SCREEN.GAME_END || otherTable) {
      // The previous table's UI goes first; nothing is routed
      this._teardown(EXIT.NEW_TABLE);
    }
    if (from !== SCREEN.TABLE || otherTable) this.tableGeneration++;

    this._role = role;
    this._persistTable(role, gameId || (from === SCREEN.TABLE && !otherTable ? this.gameId : null));
    this._pendingSpectate = null;
    this._routeInFlight = null;
    return this.transition(SCREEN.TABLE, { role, gameId });
  }

  /** Change the role at the current table (/lazy, /active). */
  setRole(role) {
    if (this._screen !== SCREEN.TABLE) return false;
    return this.enterTable(role, this.gameId);
  }

  /** gameEnd: the table stays on screen (score modal) but there is nothing to rejoin. */
  endGame() {
    if (!this.can(SCREEN.GAME_END)) return this._illegal(this._screen, SCREEN.GAME_END);
    this._clearPersistedIds();
    this.rejoinAttempted = false;
    this.rejoinSucceeded = false;
    return this.transition(SCREEN.GAME_END);
  }

  /**
   * Leave the table: tear everything down, then route out.
   * @param {string} reason - EXIT.*
   * @param {Object} [options]
   * @param {string} [options.to] - SCREEN to land on (default: the tournament lobby for a tournament player, else the main room)
   * @param {boolean} [options.route=true] - false: tear down only, stay on the current screen
   * @returns {string|null} the screen it routed to
   */
  exitTable(reason, { to = null, route = true } = {}) {
    this.tableGeneration++;
    this._teardown(reason);
    this._role = null;
    this._pendingSpectate = null;
    this.rejoinAttempted = false;
    this.rejoinSucceeded = false;
    this._rejoinSucceededFor = null;
    // Per-game state only: username and tournamentId are session identity
    this._gameState?.reset?.();
    this._clearPersistedIds();

    if (!route) return null;
    // A tab that watches a tournament goes back to watching it, also after
    // a reload (gameState.tournamentId is gone then; the key is not)
    if (!this.tournamentId && this.watchedTournamentId && this._gameState) {
      this._gameState.tournamentId = this.watchedTournamentId;
    }
    const dest = to || (this.tournamentId ? SCREEN.TOURNAMENT_LOBBY : SCREEN.MAIN_ROOM);
    if (!this.transition(dest, undefined)) return null;
    if (dest === SCREEN.MAIN_ROOM) this.requestMainRoom();
    else if (dest === SCREEN.TOURNAMENT_LOBBY) this.requestTournament();
    return dest;
  }

  _teardown(reason) {
    if (!this._teardownTable) return;
    try {
      this._teardownTable(reason);
    } catch (err) {
      if (this._strict) throw err;
      this._log.error?.('ClientSession: table teardown failed', err);
    }
  }

  _persistTable(role, gameId) {
    if (this._gameState) this._gameState.gameId = gameId || null;
    if (role === ROLE.SPECTATOR) {
      // A spectator reconnect re-spectates; rejoinGame would be refused
      this._socketManager?.clearGameId?.();
      this._storage.removeItem(STORAGE.GAME);
      if (gameId) this._storage.setItem(STORAGE.SPECTATE, gameId);
    } else {
      this._storage.removeItem(STORAGE.SPECTATE);
      if (gameId) this._socketManager?.setGameId?.(gameId);
    }
  }

  /** Every copy: sessionStorage, SocketManager._gameId, gameState.gameId. */
  _clearPersistedIds() {
    this._socketManager?.clearGameId?.();
    this._storage.removeItem(STORAGE.GAME);
    this._storage.removeItem(STORAGE.SPECTATE);
    if (this._gameState) this._gameState.gameId = null;
  }

  /** A deal's gameStart: a seat's carries a position, a spectator's none. */
  noteDeal(data) {
    if (!data?.gameId) return;
    if (data.position && this._role !== ROLE.SPECTATOR) {
      this._persistTable(this._role || ROLE.PLAYER, data.gameId);
    } else if (this._gameState) {
      this._gameState.gameId = data.gameId;
    }
  }

  // ============================================
  // Routes out (joinMainRoom / returnToTournament)
  // ============================================

  _routeBusy() {
    return !!this._routeInFlight && Date.now() - this._routeInFlight.at < ROUTE_TIMEOUT_MS;
  }

  _emit(event, data) {
    this._socketManager?.emit?.(event, data);
  }

  /** @returns {boolean} whether joinMainRoom went out (one route request at a time) */
  requestMainRoom() {
    if (this._routeBusy()) {
      this._log.log?.(`ClientSession: joinMainRoom skipped, ${this._routeInFlight.kind} in flight`);
      return false;
    }
    this._routeInFlight = { kind: 'mainRoom', at: Date.now() };
    this._emit(CLIENT_EVENTS.JOIN_MAIN_ROOM);
    return true;
  }

  requestTournament() {
    if (this._routeBusy()) return false;
    this._routeInFlight = { kind: 'tournament', at: Date.now() };
    const tournamentId = this.tournamentId;
    // Only watching it, from a socket the server does not know as its
    // spectator (a reload or reconnect since): watch again.
    // returnToTournament would find nothing and land in the main room
    if (this.isTournamentSpectator(tournamentId) && this._tournamentWatchSocket !== (this._socketManager?.id || null)) {
      this._pendingTournamentRejoin = { tournamentId, spectator: true };
      this._emit(CLIENT_EVENTS.SPECTATE_TOURNAMENT, { tournamentId });
      return true;
    }
    this._emit(CLIENT_EVENTS.RETURN_TO_TOURNAMENT);
    return true;
  }

  /** The server put this socket somewhere (main room, a lobby, a tournament, a table). */
  routeArrived() {
    this._routeInFlight = null;
    this._pendingTournamentRejoin = null;
  }

  // ============================================
  // Session resume (restoreSession first, then the rest)
  // ============================================

  credentials() {
    const username = this._storage.getItem(STORAGE.USER);
    const sessionToken = this._storage.getItem(STORAGE.TOKEN);
    return username && sessionToken ? { username, sessionToken } : null;
  }

  get sessionRestored() {
    const id = this._socketManager?.id;
    return !!id && this._restoredSocketId === id;
  }

  /**
   * On every connect of a started page: restore the session once per
   * socket. @returns {boolean} whether restoreSession went out
   */
  resume() {
    if (!this._started || this._superseded) return false;
    const id = this._socketManager?.id;
    if (!id) return false;
    this._routeInFlight = null;
    const creds = this.credentials();
    if (!creds) return false;
    if (this._restoreSentFor === id) return false;
    this._restoreSentFor = id;
    this._emit(CLIENT_EVENTS.RESTORE_SESSION, creds);
    return true;
  }

  /** Signed in by password on this socket (signInResponse / signUp auto-login). */
  noteSignedIn(username) {
    this._restoredSocketId = this._socketManager?.id || null;
    this._restoreSentFor = this._restoredSocketId;
    if (this._gameState && username) this._gameState.username = username;
  }

  /**
   * restoreSessionResponse {success: true}: rejoin, re-spectate, or
   * re-enter the current screen.
   * @returns {string} what it did: 'rejoin' | 'spectate' | 'tournament' | 'tournamentSpectate' | 'lobby' | 'mainRoom' | 'stay' | 'none'
   */
  onSessionRestored(data) {
    this.noteSignedIn(data.username);
    // The server's pointer to a tournament this player is in (one that has
    // begun) first: a rejoin below that fails, or a table with nothing to
    // rejoin, then routes back to it (returnToTournament reattaches by
    // username), not to the main room
    const activeTournamentId = data.activeTournamentId || null;
    if (activeTournamentId && this._gameState) this._gameState.tournamentId = activeTournamentId;
    const activeGameId = data.activeGameId || null;
    if (activeGameId) return this.rejoin(activeGameId) ? 'rejoin' : 'none';
    const seatedGameId = this.persistedGameId;
    if (seatedGameId) return this.rejoin(seatedGameId) ? 'rejoin' : 'none';
    const watching = this.persistedSpectateId;
    if (watching) return this.spectate(watching) ? 'spectate' : 'none';
    if (this._screen === SCREEN.TABLE) {
      // Nothing to rejoin (a draw before seating, a lost pointer): the
      // tournament lobby for a tournament player, else the main room
      return this.exitTable(EXIT.TABLE_LOST) === SCREEN.TOURNAMENT_LOBBY ? 'tournament' : 'mainRoom';
    }
    // The server's pointer, else the tournament lobby this tab was showing
    // (a reload or a reconnect)
    const showingTournament = this._screen === SCREEN.BOOT || this._screen === SCREEN.TOURNAMENT_LOBBY;
    const tournamentId = activeTournamentId ||
      (showingTournament ? this.persistedTournamentId || this.tournamentId : null);
    if (tournamentId) {
      if (this._gameState) this._gameState.tournamentId = tournamentId;
      // Only watching it (and not a player the server knows of): watch
      // again; joinTournament would make this tab an entrant
      const spectator = !activeTournamentId && this.isTournamentSpectator(tournamentId);
      this._pendingTournamentRejoin = { tournamentId, spectator };
      this._emit(spectator ? CLIENT_EVENTS.SPECTATE_TOURNAMENT : CLIENT_EVENTS.JOIN_TOURNAMENT, { tournamentId });
      return spectator ? 'tournamentSpectate' : 'tournament';
    }
    switch (this._screen) {
      case SCREEN.GAME_END:
        // The score modal stays; its Return button routes
        return 'stay';
      case SCREEN.LOBBY:
        if (this.lobbyId) return this._reenterLobby(this.lobbyId);
        break;
      case SCREEN.BOOT: {
        // A reload in a game lobby: the server holds the seat for a while
        const lobbyId = this.persistedLobbyId;
        if (lobbyId) {
          // A screen to stand on until lobbyCreated (or the error) answers
          this.transition(SCREEN.MAIN_ROOM);
          return this._reenterLobby(lobbyId);
        }
        break;
      }
      default:
        break;
    }
    if (this._screen !== SCREEN.MAIN_ROOM && this.can(SCREEN.MAIN_ROOM)) this.transition(SCREEN.MAIN_ROOM);
    this.requestMainRoom();
    return 'mainRoom';
  }

  _reenterLobby(lobbyId) {
    this._pendingLobbyRejoin = lobbyId;
    this._emit(CLIENT_EVENTS.JOIN_LOBBY, { lobbyId });
    return 'lobby';
  }

  /** Exactly one rejoinGame per socket. @returns {boolean} whether it went out */
  rejoin(gameId) {
    const id = this._socketManager?.id || null;
    if (!gameId) return false;
    if (id && this._rejoinSentFor === id) {
      this._log.log?.('ClientSession: rejoinGame already sent on this socket');
      return false;
    }
    this._rejoinSentFor = id;
    this.rejoinAttempted = true;
    const creds = this.credentials();
    const username = creds?.username || this.username;
    this._socketManager?.setGameId?.(gameId);
    this._storage.removeItem(STORAGE.SPECTATE);
    this._emit(CLIENT_EVENTS.REJOIN_GAME, { gameId, username, sessionToken: creds?.sessionToken || undefined });
    return true;
  }

  spectate(gameId) {
    if (!gameId) return false;
    this._pendingSpectate = gameId;
    this._emit(CLIENT_EVENTS.JOIN_AS_SPECTATOR, { gameId });
    return true;
  }

  /**
   * rejoinSuccess. @returns {boolean} false for a repeat on the same socket
   * (the server answers a repeated lazy rejoin again; processing it twice
   * would replay the game log twice)
   */
  noteRejoinSuccess(gameId) {
    const key = `${this._socketManager?.id || ''}:${gameId || ''}`;
    if (this._rejoinSucceededFor === key && this._screen === SCREEN.TABLE) return false;
    this._rejoinSucceededFor = key;
    this.rejoinSucceeded = true;
    this._routeInFlight = null;
    // This rejoin rebuilds the table: an earlier rebuild still waiting for
    // the scene (a rejoin on a previous socket of this same game) stops
    this.supersedeTableWork();
    return true;
  }

  /**
   * A rebuild of the current table (rejoin, re-spectate, restorePlayerState):
   * every deferred rebuild still waiting for the scene stops, so two
   * reconnects while the scene is restarting never replay the table twice.
   */
  supersedeTableWork() {
    this.tableGeneration++;
  }

  noteLobby(lobbyId) {
    this.lobbyId = lobbyId || null;
    if (this.lobbyId && this._screen === SCREEN.LOBBY) this._storage.setItem(STORAGE.LOBBY, this.lobbyId);
    else this._storage.removeItem(STORAGE.LOBBY);
    this._pendingLobbyRejoin = null;
    this._routeInFlight = null;
  }

  /** An error while re-entering a lobby after a reconnect: the lobby is gone. */
  takePendingLobbyRejoin() {
    const id = this._pendingLobbyRejoin;
    this._pendingLobbyRejoin = null;
    return id;
  }

  /**
   * An error while re-entering a tournament after a reload or reconnect: it
   * is gone. @returns {{tournamentId: string, spectator: boolean}|null}
   */
  takePendingTournamentRejoin() {
    const id = this._pendingTournamentRejoin;
    this._pendingTournamentRejoin = null;
    return id;
  }

  takePendingSpectate() {
    const id = this._pendingSpectate;
    this._pendingSpectate = null;
    return id;
  }

  /** Sign-out / forceLogout: forget the identity too. */
  clearIdentity() {
    this._superseded = false;
    this._gameState?.resetSession?.();
    this._forgetTournamentLobby();
    this._storage.removeItem(STORAGE.LOBBY);
    this._restoredSocketId = null;
    this._restoreSentFor = null;
    this._rejoinSentFor = null;
  }

  // ============================================
  // Connection region
  // ============================================

  onConnectionChange(callback) {
    this._connectionListeners.add(callback);
    return () => this._connectionListeners.delete(callback);
  }

  _setConnection(next) {
    if (this._connection === next) return;
    const prev = this._connection;
    this._connection = next;
    this._connectionListeners.forEach((cb) => {
      try {
        cb(next, prev);
      } catch (err) {
        this._log.error?.('ClientSession: connection listener failed', err);
      }
    });
  }

  _onSocketState(event, data = {}) {
    if (event === 'reconnectFailed') {
      this._setConnection(CONNECTION.OFFLINE);
      return;
    }
    if (event === 'disconnect') {
      this._routeInFlight = null;
      this._pendingLobbyRejoin = null;
      this._pendingTournamentRejoin = null;
      // The server closed it: Socket.IO never reconnects by itself
      if (data.reason === 'io server disconnect') this._setConnection(CONNECTION.OFFLINE);
      return;
    }
    if (event !== 'stateChanged') return;
    if (data.newState === 'connected') {
      this._setConnection(CONNECTION.CONNECTED);
      this.resume();
    } else if (this._connection !== CONNECTION.OFFLINE || data.newState === 'reconnecting') {
      this._setConnection(CONNECTION.RECONNECTING);
    }
  }
}

let instance = null;

export function getClientSession() {
  if (!instance) instance = new ClientSession();
  return instance;
}

/** For tests. */
export function resetClientSession(options) {
  instance?._unsubscribeSocket?.();
  instance = options ? new ClientSession(options) : null;
  return instance;
}
